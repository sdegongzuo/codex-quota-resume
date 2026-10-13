import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeEvents } from '../scripts/native-events.mjs';
const start = { method: 'turn/started', params: { threadId: 'allowed', turn: { id: 'turn1' } } };

test('authorized native events track exact turn and discard item bodies', () => {
  const events = new NativeEvents({ authorized: id => id === 'allowed', now: () => 100 });
  events.observe({ ...start, params: { ...start.params, threadId: 'other' } });
  assert.equal(events.snapshot('other'), null);
  events.observe(start);
  events.observe({ method: 'item/started', params: { threadId: 'allowed', turnId: 'turn1',
    item: { id: 'tool1', type: 'commandExecution', command: 'PRIVATE_SENTINEL' } } });
  assert.equal(events.snapshot('allowed').safeBoundary, false);
  assert.equal(events.snapshot('allowed').activeItemCount, 1);
  assert.equal(JSON.stringify(events.snapshot('allowed')).includes('PRIVATE_SENTINEL'), false);
  events.observe({ method: 'turn/completed', params: { threadId: 'allowed', turn: { id: 'old', status: 'interrupted' } } });
  assert.equal(events.snapshot('allowed').status, 'inProgress');
  events.observe({ method: 'turn/completed', params: { threadId: 'allowed', turn: { id: 'turn1', status: 'interrupted' } } });
  assert.equal(events.snapshot('allowed').status, 'interrupted');
  assert.equal(events.snapshot('allowed').activeItemCount, 0);
});

test('compaction completion invalidates old usage and needs a subsequent matching usage receipt', () => {
  const events = new NativeEvents({ authorized: () => true, now: () => 100 });
  events.observe(start);
  const usage = { method: 'thread/tokenUsage/updated', params: { threadId: 'allowed', turnId: 'turn1',
    tokenUsage: { last: { totalTokens: 60 }, total: { totalTokens: 999999 }, modelContextWindow: 100 } } };
  events.observe(usage);
  assert.equal(events.snapshot('allowed').usage.activeTokens, 60);
  events.observe({ method: 'item/completed', params: { threadId: 'allowed', turnId: 'turn1', item: { id: 'c', type: 'contextCompaction' } } });
  assert.equal(events.snapshot('allowed').usage, null);
  events.observe({ ...usage, params: { ...usage.params, turnId: 'old' } });
  assert.equal(events.snapshot('allowed').usage, null);
  events.observe(usage);
  assert.equal(events.snapshot('allowed').usage.activeTokens, 60);
});

test('streamed text deltas do not invoke configuration authorization or retain transcript', () => {
  let checks = 0;
  const events = new NativeEvents({ authorized: () => { checks++; return true; } });
  events.observe({ method: 'item/agentMessage/delta', params: { threadId: 'allowed', delta: 'PRIVATE_SENTINEL' } });
  assert.equal(checks, 0);
  assert.equal(events.targets.size, 0);
});
