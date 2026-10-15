// Store only display metadata; never expose account credentials or raw responses.
export function quotaSnapshot(usage, observedAt) {
  const windows = [];
  const buckets = usage.rateLimitsByLimitId && Object.keys(usage.rateLimitsByLimitId).length
    ? usage.rateLimitsByLimitId : { legacy: usage.rateLimits };
  for (const [bucket, limits] of Object.entries(buckets)) {
    for (const slot of ['primary', 'secondary']) {
      const value = limits?.[slot];
      if (!value || ![300, 10080].includes(value.windowDurationMins)) continue;
      windows.push({ bucket, slot, windowDurationMins: value.windowDurationMins,
        remainingPercent: Number.isFinite(value.usedPercent)
          ? Math.min(100, Math.max(0, 100 - value.usedPercent)) : null,
        resetsAt: Number.isFinite(value.resetsAt) ? value.resetsAt : null });
    }
  }
  return { observedAt, windows };
}

export function panelQuota(state, now = Date.now() / 1000) {
  const sample = state.quotaDisplay;
  return { observedAt: sample?.observedAt ?? null, windows: sample?.windows ?? [],
    status: state.usageReadFailure ? 'unavailable' : !sample ? 'unconfirmed'
      : !sample.windows?.length ? 'no_data'
        : !Number.isFinite(sample.observedAt) || now - sample.observedAt > 90 ? 'stale' : 'available',
    reason: state.usageReadFailure ? '额度读取失败，以下为上次成功数据' : null };
}
