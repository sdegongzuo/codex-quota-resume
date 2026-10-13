import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { observeRolloutUsage } from '../scripts/rollout-usage.mjs';

const sessionsRoot = fileURLToPath(new URL('./fixtures/', import.meta.url));
const fixtureRoot = name => fileURLToPath(new URL(`./fixtures/${name}/`, import.meta.url));
const first = '11111111-1111-4111-8111-111111111111';
const second = '22222222-2222-4222-8222-222222222222';

test('只读匹配白名单rollout并使用单次usage和同轮窗口', async () => {
  const result = await observeRolloutUsage({ sessionsRoot, targets: { [first]: { enabled: true },
    '33333333-3333-4333-8333-333333333333': { enabled: true },
    '44444444-4444-4444-8444-444444444444': { enabled: false } },
  nowMs: Date.parse('2026-10-13T01:00:05Z') });
  assert.equal(result[first].status, 'available');
  assert.equal(result[first].activeTokens, 90);
  assert.equal(result[first].windowTokens, 200);
  assert.equal(result[first].ratio, 0.45);
  assert.equal(result[first].model, 'test-model');
  assert.equal(result[first].turnId, 'turn-fixture-1');
  assert.equal(result[first].completionDelaySeconds, 3);
  assert.equal(result['33333333-3333-4333-8333-333333333333'].status, 'unverified');
  assert.equal(Object.hasOwn(result, '44444444-4444-4444-8444-444444444444'), false);
  assert.equal(JSON.stringify(result).includes('TRANSCRIPT_SENTINEL'), false);
  assert.equal(JSON.stringify(result).includes('999999'), false);
});

test('缓存样本随时间变为stale，且压缩记录使旧样本失效', async () => {
  const freshAt = Date.parse('2026-10-13T01:00:05Z');
  const fresh = await observeRolloutUsage({ sessionsRoot, targets: { [first]: { enabled: true } }, nowMs: freshAt });
  assert.equal(fresh[first].status, 'available');
  const stale = await observeRolloutUsage({ sessionsRoot, targets: { [first]: { enabled: true } },
    nowMs: freshAt + 121_000 });
  assert.equal(stale[first].status, 'stale');
  assert.equal(stale[first].stale, true);
  const afterCompact = await observeRolloutUsage({ sessionsRoot, targets: { [second]: { enabled: true } }, nowMs: freshAt });
  assert.equal(afterCompact[second].status, 'awaiting_post_compaction_usage');
  const cachedAfterCompact = await observeRolloutUsage({ sessionsRoot, targets: { [second]: { enabled: true } }, nowMs: freshAt + 60_000 });
  assert.equal(cachedAfterCompact[second].status, 'awaiting_post_compaction_usage');
});

test('新turn清除旧usage并选择同UUID最新rollout', async () => {
  const id = '55555555-5555-4555-8555-555555555555';
  const result = await observeRolloutUsage({ sessionsRoot: fixtureRoot('multifile'),
    targets: { [id]: { enabled: true } }, nowMs: Date.parse('2026-10-13T02:00:05Z') });
  assert.equal(result[id].status, 'unavailable');
  assert.equal(result[id].reason, 'no same-turn usage and context-window pair');
});

test('拒绝负token和早于turn的window与usage', async () => {
  const negativeId = '66666666-6666-4666-8666-666666666666';
  const orderId = '77777777-7777-4777-8777-777777777777';
  const result = await observeRolloutUsage({ sessionsRoot: fixtureRoot('negative'),
    targets: { [negativeId]: { enabled: true } }, nowMs: Date.parse('2026-10-13T01:00:05Z') });
  const outOfOrder = await observeRolloutUsage({ sessionsRoot: fixtureRoot('time-order'),
    targets: { [orderId]: { enabled: true } }, nowMs: Date.parse('2026-10-13T01:00:05Z') });
  assert.equal(result[negativeId].status, 'unavailable');
  assert.equal(outOfOrder[orderId].status, 'unavailable');
});

test('malformed turn后的usage缺少turn id时安全忽略', async () => {
  const id = '88888888-8888-4888-8888-888888888888';
  const result = await observeRolloutUsage({ sessionsRoot: fixtureRoot('malformed-turn'),
    targets: { [id]: { enabled: true } }, nowMs: Date.parse('2026-10-13T01:00:05Z') });
  assert.equal(result[id].status, 'unavailable');
  assert.equal(result[id].reason, 'no same-turn usage and context-window pair');
});
