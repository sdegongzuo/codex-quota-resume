import test from 'node:test';
import assert from 'node:assert/strict';
import { observeCompaction } from '../scripts/compaction.mjs';

const sample = (activeTokens, observedAt, windowTokens = 100) => ({ activeTokens, windowTokens, observedAt });

test('阈值首次观测可触发，但没有明确恢复许可不压缩', async () => {
  const state = {};
  let calls = 0;
  await observeCompaction({ state, sample: sample(60, 1), hasUsage: true,
    ordinaryUsageAllowed: false, safeBoundary: true,
    adapter: { verified: true, compact: async () => { calls++; return { completed: true, after: sample(20, 2) }; } } });
  assert.equal(state.status, 'quota_unavailable');
  assert.equal(calls, 0);
  await observeCompaction({ state, sample: sample(60, 3), hasUsage: true,
    ordinaryUsageAllowed: true, safeBoundary: true,
    adapter: { verified: true, compact: async () => { calls++; return { completed: true, after: sample(20, 4) }; } } });
  assert.equal(state.status, 'completed');
  assert.equal(calls, 1);
});

test('压缩后重置请求标识，旧观测不触发重复周期', async () => {
  const state = {};
  const requestIds = [];
  const adapter = { verified: true, compact: async ({ requestId }) => {
    requestIds.push(requestId);
    return { completed: true, after: sample(30, Number(requestId.split(':')[0]) + 1) };
  } };
  await observeCompaction({ state, sample: sample(60, 10), hasUsage: true,
    ordinaryUsageAllowed: true, safeBoundary: true, adapter });
  assert.equal(state.requestId, null);
  await observeCompaction({ state, sample: sample(60, 10), hasUsage: true,
    ordinaryUsageAllowed: true, safeBoundary: true, adapter });
  assert.equal(requestIds.length, 1);
  await observeCompaction({ state, sample: sample(60, 12), hasUsage: true,
    ordinaryUsageAllowed: true, safeBoundary: true, adapter });
  assert.equal(requestIds.length, 2);
  assert.notEqual(requestIds[0], requestIds[1]);
});

test('只有验证过的实际 adapter 与安全边界能执行压缩', async () => {
  const state = {};
  let calls = 0;
  await observeCompaction({ state, sample: sample(60, 1), hasUsage: true,
    ordinaryUsageAllowed: true, safeBoundary: false,
    adapter: { verified: true, compact: async () => { calls++; return {}; } } });
  assert.equal(state.status, 'waiting_boundary');
  assert.equal(calls, 0);
  await observeCompaction({ state, sample: sample(60, 2), hasUsage: true,
    ordinaryUsageAllowed: true, safeBoundary: true,
    adapter: { verified: false, compact: async () => { calls++; return {}; } } });
  assert.equal(state.status, 'unsupported');
  assert.equal(calls, 0);
});
