import test from 'node:test';
import assert from 'node:assert/strict';
import { quotaSnapshot, panelQuota } from '../scripts/quota-view.mjs';

test('额度显示使用官方窗口，正确转换剩余比例并保留未知值', () => {
  const sample = quotaSnapshot({ secret: 'hidden', rateLimitsByLimitId: { standard: {
    primary: { windowDurationMins: 300, usedPercent: 50, resetsAt: 1234 },
    secondary: { windowDurationMins: 10080, usedPercent: null, resetsAt: null },
  } } }, 100);
  assert.equal(sample.windows[0].remainingPercent, 50);
  assert.equal(sample.windows[0].resetsAt, 1234);
  assert.equal(sample.windows[1].remainingPercent, null);
  assert.equal(sample.windows[1].resetsAt, null);
  assert.equal(JSON.stringify(sample).includes('hidden'), false);
  assert.equal(panelQuota({ quotaDisplay: sample }, 191).status, 'stale');
  assert.equal(panelQuota({ quotaDisplay: sample, usageReadFailure: {} }, 110).status, 'unavailable');
  assert.equal(panelQuota({}, 110).status, 'unconfirmed');
});

test('兼容旧额度结构且零剩余额度不会显示为未知', () => {
  const sample = quotaSnapshot({ rateLimits: { primary: {
    windowDurationMins: 300, usedPercent: 100, resetsAt: 200,
  } } }, 100);
  assert.equal(sample.windows[0].remainingPercent, 0);
  assert.equal(panelQuota({ quotaDisplay: sample }, 110).status, 'available');
});

test('空响应不会标记额度可用；空新版映射可回退旧窗口', () => {
  assert.equal(panelQuota({ quotaDisplay: quotaSnapshot({}, 100) }, 110).status, 'no_data');
  const sample = quotaSnapshot({ rateLimitsByLimitId: {}, rateLimits: {
    primary: { windowDurationMins: 300, usedPercent: 100, resetsAt: 200 },
  } }, 100);
  assert.equal(sample.windows[0].remainingPercent, 0);
  assert.equal(panelQuota({ quotaDisplay: { ...sample, observedAt: null } }, 110).status, 'stale');
});
