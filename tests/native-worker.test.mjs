import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { NativeRouter } from '../scripts/native-router.mjs';
import { NativeEvents } from '../scripts/native-events.mjs';
import { NativeService } from '../scripts/native-service.mjs';
import { NativeFrameDecoder, encodeNativeFrame } from '../scripts/native-wire.mjs';
import { connectNativeWorker } from '../scripts/native-worker.mjs';

test('worker authenticates service and confirms compaction through framed RPC plus subsequent native usage', async () => {
  const token = 'synthetic-native-worker-token-012345678901';
  const config = { enabled: true, targets: { target: { enabled: true } } };
  const events = new NativeEvents({ authorized: id => id === 'target' });
  events.observe({ method: 'turn/started', params: { threadId: 'target', turn: { id: 't1' } } });
  events.observe({ method: 'turn/completed', params: { threadId: 'target', turn: { id: 't1', status: 'completed' } } });
  let calls = 0, router;
  router = new NativeRouter({ renderer: () => {}, backend: message => {
    calls++;
    events.observe({ method: 'turn/started', params: { threadId: 'target', turn: { id: 'compact-turn' } } });
    events.observe({ method: 'item/started', params: { threadId: 'target', turnId: 'compact-turn',
      item: { id: 'compaction1', type: 'contextCompaction' } } });
    events.observe({ method: 'thread/tokenUsage/updated', params: { threadId: 'target', turnId: 'compact-turn',
      tokenUsage: { last: { totalTokens: 20 }, modelContextWindow: 100 } } });
    events.observe({ method: 'item/completed', params: { threadId: 'target', turnId: 'compact-turn',
      item: { id: 'compaction1', type: 'contextCompaction' } } });
    events.observe({ method: 'turn/completed', params: { threadId: 'target', turn: { id: 'compact-turn', status: 'completed' } } });
    router.backendMessage({ id: message.id, result: {} });
  } });
  const service = new NativeService({ token, router, events, configuration: () => config,
    ordinaryUsageAllowed: async () => true });
  const server = net.createServer(socket => {
    const decoder = new NativeFrameDecoder(message => {
      service.dispatch(message, reply => socket.end(encodeNativeFrame(reply))).catch(() => socket.destroy());
    });
    socket.on('data', chunk => decoder.push(chunk));
  });
  server.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const records = [];
  try {
    const worker = await connectNativeWorker({ descriptor: { pipe: '\\\\.\\pipe\\quota-resume-synthetic', token,
      connect: () => net.createConnection({ host: '127.0.0.1', port: server.address().port }) },
      targets: config.targets, persist: async record => records.push(record), history: [],
      ordinaryUsageAllowed: async () => true });
    assert.equal(worker.verified, true);
    const operation = { action: 'compact', threadId: 'target', turnId: 't1', requestId: 'synthetic-once' };
    const result = await worker.perform(operation);
    assert.equal(result.status, 'completed');
    assert.equal(result.after.activeTokens, 20);
    assert.equal(result.compactTurnId, 'compact-turn');
    await worker.perform(operation);
    assert.equal(calls, 1);
    assert.equal(records[0].status, 'sending');
    assert.equal(records.at(-1).status, 'completed');
  } finally { router.close(); await new Promise(resolve => server.close(resolve)); }
});
