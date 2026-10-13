// Conservative permission check for the same backend account. Missing windows never imply permission.
export function nativeQuotaAllowed(response) {
  const buckets = Object.values(response?.rateLimitsByLimitId ?? { legacy: response?.rateLimits });
  const windows = buckets.flatMap(bucket => [bucket?.primary, bucket?.secondary]).filter(Boolean);
  return windows.some(window => window.windowDurationMins === 300)
    && windows.every(window => Number.isFinite(window.usedPercent)
      && window.usedPercent >= 0 && window.usedPercent < 100);
}
