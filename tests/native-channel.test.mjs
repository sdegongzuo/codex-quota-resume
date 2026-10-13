import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { attachNativeChannel } from '../scripts/native-channel.mjs';

test('bridge EOF reports connection failure exactly once', { skip: process.platform !== 'win32' }, async () => {
  const server = net.createServer(socket => socket.end(Buffer.from([1, 0])));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  let failures = 0;
  const channel = attachNativeChannel({ pipe: '\\\\.\\pipe\\quota-resume-synthetic', service: { dispatch: async () => {} },
    onFailure: () => { failures++; }, connect: () => net.createConnection({ host: '127.0.0.1', port: server.address().port }) });
  try {
    await once(channel.socket, 'close');
    assert.equal(failures, 1);
    channel.close();
    assert.equal(failures, 1);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('intentional channel close does not report a transport failure', { skip: process.platform !== 'win32' }, async () => {
  const server = net.createServer(socket => socket.resume());
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  let failures = 0;
  const channel = attachNativeChannel({ pipe: '\\\\.\\pipe\\quota-resume-synthetic', service: { dispatch: async () => {} },
    onFailure: () => { failures++; }, connect: () => net.createConnection({ host: '127.0.0.1', port: server.address().port }) });
  try {
    await once(channel.socket, 'connect');
    const closed = once(channel.socket, 'close'); channel.close(); await closed;
    assert.equal(failures, 0);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
