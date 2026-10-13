import test from 'node:test';
import assert from 'node:assert/strict';
import { Desktop } from '../scripts/desktop.mjs';

test('native compaction adapter binds exact thread and turn and converts usage time units', async () => {
  const calls = [];
  const desktop = new Desktop({ pipe: 'synthetic-unused', callerThread: 'controller', native: {
    verified: true, snapshot: async id => ({ turnId: id + '-turn', safeBoundary: true }),
    perform: async operation => { calls.push(operation); return { status: 'completed',
      after: { activeTokens: 20, windowTokens: 100, observedAt: 2000 } }; },
  } });
  assert.equal((await desktop.nativeSnapshot('target')).turnId, 'target-turn');
  const adapter = desktop.compactionAdapterForTarget('target', 'target-turn');
  const result = await adapter.compact({ requestId: 'one' });
  assert.equal(result.completed, true);
  assert.equal(result.after.observedAt, 2);
  assert.deepEqual(calls[0], { action: 'compact', threadId: 'target', turnId: 'target-turn',
    requestId: 'compact:target:target-turn:one' });
});

test('unverified native bridge does not expose an executable compaction adapter', async () => {
  const desktop = new Desktop({ pipe: 'synthetic-unused', callerThread: 'controller', native: { verified: false } });
  assert.equal(await desktop.nativeSnapshot('target'), null);
  assert.equal(desktop.compactionAdapterForTarget('target', 'turn'), null);
});
