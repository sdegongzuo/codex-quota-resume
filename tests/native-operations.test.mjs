import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeOperations } from '../scripts/native-operations.mjs';
const invocation = { action: 'compact', threadId: 'allowed', turnId: 't1', requestId: 'r1' };
const setup = ({ failPersist = false, quota = true } = {}) => {
  let time = 1000, sent = 0, state = { turnId: 't1', status: 'completed', safeBoundary: true };
  const records = [];
  const operations = new NativeOperations({ snapshot: async () => state,
    request: async () => { sent++; }, ordinaryUsageAllowed: async () => quota,
    persist: async value => { if (failPersist) throw Error('disk unavailable'); records.push(value); },
    now: () => time, wait: async ms => { time += ms; }, timeoutMs: 500 });
  return { operations, records, sent: () => sent, set: value => { state = value; } };
};

test('accepted compaction without completion and post-event usage remains uncertain and never repeats', async () => {
  const s = setup();
  assert.equal((await s.operations.perform(invocation)).status, 'uncertain');
  assert.equal(s.records[0].status, 'sending');
  await s.operations.perform(invocation);
  assert.equal(s.sent(), 1);
});

test('durability failure and quota denial prevent native requests', async () => {
  const s = setup({ failPersist: true });
  await assert.rejects(s.operations.perform(invocation));
  assert.equal(s.sent(), 0);
  const q = setup({ quota: false });
  assert.equal((await q.operations.perform(invocation)).status, 'not_ready');
  assert.equal(q.sent(), 0);
});

test('native compaction needs completion plus new usage and restore prevents crash resend', async () => {
  let calls = 0;
  const before = { turnId: 't1', status: 'completed', safeBoundary: true, compactionCompletedAt: 1 };
  const after = { ...before, compactionCompletedAt: 1001, usage: { activeTokens: 20, windowTokens: 100, observedAt: 1002 } };
  const operations = new NativeOperations({ request: async () => {}, snapshot: async () => ++calls === 1 ? before : after,
    persist: async () => {}, ordinaryUsageAllowed: async () => true, now: () => 1000 });
  assert.equal((await operations.perform(invocation)).status, 'completed');
  const s = setup();
  s.operations.restore([{ ...invocation, status: 'sending' }]);
  assert.equal((await s.operations.perform(invocation)).status, 'uncertain');
  assert.equal(s.sent(), 0);
});

test('interruption needs matching interrupted turn, target changes cannot confirm completion', async () => {
  const s = setup();
  s.set({ turnId: 'new', status: 'inProgress', safeBoundary: false });
  assert.equal((await s.operations.perform({ ...invocation, action: 'interrupt' })).status, 'target_changed');
  assert.equal(s.sent(), 0);
});

test('matching interruption receipt confirms result and request ID cannot change identity', async () => {
  let sent = 0;
  const records = [];
  const operations = new NativeOperations({ request: async () => { sent++; },
    snapshot: async () => ({ turnId: 't1', status: sent ? 'interrupted' : 'inProgress', safeBoundary: false }),
    persist: async value => records.push(value), ordinaryUsageAllowed: async () => true, now: () => 1000 });
  const stop = { ...invocation, action: 'interrupt' };
  assert.equal((await operations.perform(stop)).status, 'completed');
  assert.equal(sent, 1);
  assert.equal(records[0].status, 'sending');
  await assert.rejects(operations.perform({ ...stop, threadId: 'other' }), /identity conflict/);
  assert.equal(sent, 1);
});

test('simultaneous requests with the same identity cannot race before the durable claim', async () => {
  const s = setup();
  const [first, second] = await Promise.all([s.operations.perform(invocation), s.operations.perform(invocation)]);
  assert.equal(first.status, 'uncertain');
  assert.equal(second.status, 'uncertain');
  assert.equal(s.sent(), 1);
});
