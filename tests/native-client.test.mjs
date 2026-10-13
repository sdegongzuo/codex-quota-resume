import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { NativeClient } from '../scripts/native-client.mjs';
import { NativeFrameDecoder, encodeNativeFrame } from '../scripts/native-wire.mjs';

test('native client uses one authenticated framed request and matches response identity', async () => {
  let received;
  const server = net.createServer(socket => {
    const decoder = new NativeFrameDecoder(message => {
      received = message;
      const response = encodeNativeFrame({ id: message.id, result: { turnId: 'synthetic-turn' } });
      socket.write(response.subarray(0, 2)); socket.end(response.subarray(2));
    });
    socket.on('data', chunk => decoder.push(chunk));
  });
  server.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const token = 'synthetic-token-012345678901234567890123';
  const client = new NativeClient({ pipe: '\\\\.\\pipe\\quota-resume-synthetic', token,
    connect: () => net.createConnection({ host: '127.0.0.1', port: server.address().port }) });
  try {
    assert.deepEqual(await client.command('snapshot', 'target'), { turnId: 'synthetic-turn' });
    assert.equal(received.token, token);
    assert.equal(received.threadId, 'target');
    assert.equal(received.command, 'snapshot');
    await assert.rejects(client.command('turn/start', 'target'));
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('connection can retry before sending, but loss after request transmission never retries operation', async () => {
  let connections = 0, received = 0;
  const server = net.createServer(socket => {
    const decoder = new NativeFrameDecoder(() => { received++; socket.destroy(); });
    socket.on('data', chunk => decoder.push(chunk));
  });
  server.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const client = new NativeClient({ pipe: '\\\\.\\pipe\\quota-resume-synthetic',
    token: 'synthetic-token-012345678901234567890123', timeoutMs: 1000,
    connect: () => {
      connections++;
      return net.createConnection({ host: '127.0.0.1', port: connections === 1 ? 0 : server.address().port });
    } });
  try {
    await assert.rejects(client.command('interrupt', 'target', 'turn'));
    assert.equal(connections, 2);
    assert.equal(received, 1);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
