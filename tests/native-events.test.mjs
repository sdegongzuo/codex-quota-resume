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

test('reserved compaction correlates its new turn and preserves usage emitted before completion', () => {
  const events = new NativeEvents({ authorized: () => true, now: () => 100 });
  events.observe(start);
  events.observe({ method: 'turn/completed', params: { threadId: 'allowed', turn: { id: 'turn1', status: 'completed' } } });
  assert.equal(events.beginCompaction('allowed', 'op1', 'turn1'), true);
  assert.equal(events.beginCompaction('allowed', 'op2', 'turn1'), false);
  events.observe({ method: 'turn/started', params: { threadId: 'allowed', turn: { id: 'compact1' } } });
  events.observe({ method: 'item/started', params: { threadId: 'allowed', turnId: 'compact1', item: { id: 'c', type: 'contextCompaction' } } });
  events.observe({ method: 'thread/tokenUsage/updated', params: { threadId: 'allowed', turnId: 'compact1',
    tokenUsage: { last: { totalTokens: 20 }, modelContextWindow: 100 } } });
  events.observe({ method: 'item/completed', params: { threadId: 'allowed', turnId: 'compact1', item: { id: 'c', type: 'contextCompaction' } } });
  const s = events.snapshot('allowed');
  assert.equal(s.usage.activeTokens, 20);
  assert.equal(s.compactionReceipt.operationId, 'op1');
  assert.equal(s.compactionReceipt.baselineTurnId, 'turn1');
  assert.equal(s.compactionReceipt.turnId, 'compact1');
  assert.equal(s.compactionReceipt.status, 'completed');
  assert.ok(s.usageSequence > s.compactionReceipt.startedSequence);
});

test('concurrent renderer input invalidates compaction correlation and ordinary items cannot confirm it', () => {
  const events = new NativeEvents({ authorized: () => true });
  const ready = () => {
    events.observe(start);
    events.observe({ method: 'turn/completed', params: { threadId: 'allowed', turn: { id: 'turn1', status: 'completed' } } });
    assert.equal(events.beginCompaction('allowed', 'op1', 'turn1'), true);
  };
  ready();
  events.observeRendererMessage({ method: 'turn/start', params: { threadId: 'allowed' } });
  events.observe({ method: 'turn/started', params: { threadId: 'allowed', turn: { id: 'user1' } } });
  assert.equal(events.snapshot('allowed').compactionReceipt.status, 'uncertain');
  ready();
  events.observe({ method: 'turn/started', params: { threadId: 'allowed', turn: { id: 'user2' } } });
  events.observe({ method: 'item/started', params: { threadId: 'allowed', turnId: 'user2', item: { id: 'a', type: 'agentMessage', text: 'PRIVATE_SENTINEL' } } });
  assert.equal(events.snapshot('allowed').compactionReceipt.status, 'uncertain');
  assert.equal(JSON.stringify(events.snapshot('allowed')).includes('PRIVATE_SENTINEL'), false);
});
