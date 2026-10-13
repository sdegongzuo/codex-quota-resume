const validSample = sample => Number.isFinite(sample?.activeTokens) && sample.activeTokens >= 0
  && Number.isFinite(sample?.windowTokens) && sample.windowTokens > 0
  && Number.isFinite(sample?.observedAt);

// `adapter` is the boundary for a verified host compaction API. No text summary is treated as compaction.
export async function observeCompaction({ state, sample, threshold = 0.6, hasUsage = false,
  ordinaryUsageAllowed = false, safeBoundary = false, adapter, persist = async () => {} }) {
  state.status ??= 'not_thresholded';
  if (['compacting', 'uncertain'].includes(state.status)) {
    state.status = 'uncertain';
    state.reason = '压缩请求结果待核对，禁止自动重复请求';
    await persist();
    return state;
  }
  if (!hasUsage || !validSample(sample)) {
    state.status = 'unsupported';
    state.reason = '当前桌面未提供当前活动上下文 token 和实际窗口大小';
    await persist();
    return state;
  }
  const ratio = sample.activeTokens / sample.windowTokens;
  if (state.status === 'completed' && state.after && state.armed
    && sample.observedAt <= state.after.observedAt) {
    await persist();
    return state;
  }
  state.lastSample = sample;
  state.lastRatio = ratio;
  if (ratio < threshold) {
    state.armed = true;
    state.status = 'not_thresholded';
    state.reason = null;
    state.requestId = null;
    await persist();
    return state;
  }
  if (ordinaryUsageAllowed !== true) {
    state.status = 'quota_unavailable';
    state.reason = '额度许可未确认，等待恢复后再执行压缩';
    await persist();
    return state;
  }
  if (!adapter || adapter.verified !== true || typeof adapter.compact !== 'function') {
    state.status = 'unsupported';
    state.reason = '未发现经过验证的桌面实际压缩接口';
    await persist();
    return state;
  }
  state.armed ??= true; // A first observation above threshold still triggers once.
  if (!state.armed) {
    state.status = 'above_threshold_after_compaction';
    await persist();
    return state;
  }
  if (!safeBoundary) {
    state.status = 'waiting_boundary';
    await persist();
    return state;
  }
  state.status = 'compacting';
  state.before = sample;
  state.requestId ??= `${sample.observedAt}:${sample.activeTokens}`;
  await persist();
  try {
    const result = await adapter.compact({ requestId: state.requestId });
    if (result?.completed !== true || !validSample(result.after)) {
      state.status = 'uncertain';
      state.reason = '压缩结果或压缩后活动用量未确认';
      await persist();
      return state;
    }
    state.after = result.after;
    state.status = 'completed';
    state.armed = result.after.activeTokens / result.after.windowTokens < threshold;
    if (state.armed) state.requestId = null;
    state.reason = state.armed ? null : '压缩后仍高于阈值；下降到阈值以下后重新布防';
  } catch {
    state.status = 'uncertain';
    state.reason = '压缩请求结果待核对，禁止自动重复请求';
  }
  await persist();
  return state;
}
