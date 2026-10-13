import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeQuotaAllowed } from '../scripts/native-quota.mjs';

test('native quota requires known five-hour window and rejects exhausted weekly or malformed windows', () => {
  const primary = { windowDurationMins: 300, usedPercent: 50 };
  assert.equal(nativeQuotaAllowed({ rateLimits: { primary } }), true);
  for (const response of [null, {}, { rateLimits: { primary: { usedPercent: 0 } } },
    { rateLimits: { primary: { ...primary, usedPercent: 100 } } },
    { rateLimits: { primary, secondary: { usedPercent: 100, windowDurationMins: 10080 } } },
    { rateLimits: { primary, secondary: { usedPercent: null } } }]) {
    assert.equal(nativeQuotaAllowed(response), false);
  }
});
