import { observeCompaction } from './compaction.mjs';
import { safeDesktopDiagnostic } from './desktop.mjs';
import { taskId } from './store.mjs';

export const CONTINUE_PROMPT = '继续完成本聊天中尚未完成的用户任务，遵守已有约束和授权。如果任务已经完成，或需要用户回答、确认或提供信息，请说明并停止，不要另起任务。';

export function exhaustedUntil(usage) {
  const buckets = Object.values(usage.rateLimitsByLimitId ?? { legacy: usage.rateLimits });
  const fiveHour = buckets.flatMap(bucket => [bucket?.primary, bucket?.secondary])
    .filter(window => window?.windowDurationMins === 300 && window.usedPercent >= 100
      && Number.isFinite(window.resetsAt));
  return fiveHour.length ? Math.max(...fiveHour.map(window => window.resetsAt)) : null;
}

const isQuotaError = error => {
  const code = error?.codexErrorInfo;
  if (code !== undefined && code !== null) return ['usageLimitExceeded', 'rateLimitExceeded'].includes(code);
  // Current Desktop read_thread can omit the typed code from a real failed turn.
  // This exact backend prefix is only a fallback; initial collection still requires
  // the official exhausted five-hour window and its server reset timestamp below.
  return typeof error?.message === 'string' && /^You[’']ve hit your usage limit\./.test(error.message);
};

export function quotaFailure(snapshot, armedAt, usage) {
  const turn = snapshot.turns?.[0];
  if (snapshot.thread?.kind !== 'codex' || turn?.status !== 'failed'
    || !turn.completedAt || turn.completedAt < armedAt) return null;
  // 普通网络故障、用户中断和每分钟速率限制不能误认为五小时额度中断。
  if (!isQuotaError(turn.error)) return null;
  // Keep an exact quota interruption when recovery raced ahead of observation;
  // it remains review-only until a linked official reset timestamp is recovered.
  const resetAt = exhaustedUntil(usage ?? {});
  return { turnId: turn.id, resetAt };
}

export function sameFailure(snapshot, pending) {
  const turn = snapshot.turns?.[0];
  return snapshot.thread?.kind === 'codex'
    && ['idle', 'systemError', 'notLoaded'].includes(snapshot.thread?.status?.type)
    && turn?.id === pending.turnId && turn.status === 'failed'
    && isQuotaError(turn.error);
}

const statusOf = snapshot => {
  const threadType = snapshot.thread?.status?.type;
  const activeFlags = snapshot.thread?.status?.activeFlags;
  const turnStatus = snapshot.turns?.[0]?.status;
  if (['waitingOnApproval', 'waitingOnUserInput', 'needsInput', 'waiting_on_user_input'].includes(threadType)
    || (Array.isArray(activeFlags) && activeFlags.some(flag => ['waitingOnApproval', 'waitingOnUserInput'].includes(flag)))) return 'needs_user';
  if (turnStatus === 'inProgress' || ['active', 'busy', 'working'].includes(threadType)) return 'running';
  if (turnStatus === 'completed') return 'turn_completed';
  if (turnStatus === 'interrupted') return 'stopped';
  if (turnStatus === 'failed') return 'failed';
  return null;
};

const primaryCatalogChat = (thread, hostId) => thread?.kind === 'codex'
  && (!thread.hostId || thread.hostId === hostId)
  && !thread.parentThreadId && !thread.agentId && !thread.agentRole
  && thread.threadSource !== 'subagent' && thread.source !== 'subagent';

function relatedResetAt(item, observations, config) {
  if (!item.accountId || !Number.isFinite(item.interruptedAt)) return null;
  const distance = Math.max(1, (config.intervalSeconds ?? 30) * 2);
  return (observations[item.accountId] ?? [])
    .filter(sample => sample.accountId === item.accountId && sample.exhaustedFiveHour === true
      && Number.isFinite(sample.resetAt) && sample.resetAt > item.interruptedAt
      && Number.isFinite(sample.observedAt)
      && Math.abs(sample.observedAt - item.interruptedAt) <= distance)
    .sort((a, b) => Math.abs(a.observedAt - item.interruptedAt) - Math.abs(b.observedAt - item.interruptedAt)
      || a.observedAt - b.observedAt)[0]?.resetAt ?? null;
}

function retainQuotaObservations(history) {
  const ordinary = history.filter(sample => sample.exhaustedFiveHour !== true).slice(-8);
  const exhaustedByReset = new Map();
  for (const sample of history.filter(sample => sample.exhaustedFiveHour === true
    && Number.isFinite(sample.resetAt))) {
    const group = exhaustedByReset.get(sample.resetAt) ?? [];
    group.push(sample);
    exhaustedByReset.set(sample.resetAt, group);
  }
  const exhausted = [...exhaustedByReset.entries()]
    .sort(([a], [b]) => b - a).slice(0, 2).flatMap(([, samples]) => {
      samples.sort((a, b) => a.observedAt - b.observedAt);
      return samples.length > 1 ? [samples[0], samples.at(-1)] : samples;
    });
  return [...ordinary, ...exhausted].sort((a, b) => a.observedAt - b.observedAt);
}

// persist 必须完成后才能发送；结果不确定时保留 sending，绝不自动重发。
export async function tick({ desktop, config, state, now, persist, log, stillEnabled = () => true,
  acknowledgeManualResolution = async () => {}, registerTarget }) {
  if (!config.enabled) return;
  state.pending ??= {};
  state.handled ??= [];
  state.discoveredTargets ??= {};
  state.quotaObservationsByAccount ??= {};
  state.readFailuresByTarget ??= {};
  state.activityByTarget ??= {};
  const armedTimes = Object.values(config.targets ?? {}).map(target => target.armedAt).filter(Number.isFinite);
  const baseline = Number.isFinite(config.monitoringSince) ? config.monitoringSince
    : armedTimes.length ? Math.min(...armedTimes)
      : Number.isFinite(state.monitoringSince) ? state.monitoringSince : now;
  state.monitoringSince = Number.isFinite(state.monitoringSince)
    ? Math.min(state.monitoringSince, baseline) : baseline;

  // Collect catalog and official quota metadata before any active-resume early return.
  let catalog = null;
  try {
    catalog = await desktop.call('list_threads', { limit: 50 });
    delete state.catalogReadFailure;
  } catch (error) {
    state.catalogReadFailure = { ...safeDesktopDiagnostic(error, 'list_threads'), observedAt: now };
    await persist();
  }
  const hostId = config.hostId ?? 'local';

  let usage = null;
  try {
    usage = await desktop.call('get_usage_limits');
    delete state.usageReadFailure;
    if (typeof usage?.accountId === 'string' && usage.accountId) {
      const history = state.quotaObservationsByAccount[usage.accountId] ??= [];
      const resetAt = exhaustedUntil(usage);
      if (!history.some(sample => sample.observedAt === now && sample.resetAt === resetAt)) {
        history.push({ accountId: usage.accountId, observedAt: now,
          ordinaryUsageAllowed: usage.ordinaryUsageAllowed === true,
          exhaustedFiveHour: resetAt !== null, resetAt });
        state.quotaObservationsByAccount[usage.accountId] = retainQuotaObservations(history);
        // Persist this official sample before read_thread can fail or a running slot returns.
        await persist();
      }
    }
  } catch (error) {
    state.usageReadFailure = { ...safeDesktopDiagnostic(error, 'get_usage_limits'), observedAt: now };
    await persist();
  }

  let fallback = null;
  state.catalogFallbackUsed = false;
  if (!catalog && typeof desktop.catalogFallback === 'function') {
    try {
      fallback = await desktop.catalogFallback({ monitoringSince: state.monitoringSince,
        expectedAccountId: usage?.accountId });
      state.catalogFallbackUsed = true;
      delete state.catalogFallbackFailure;
      await persist();
    } catch (error) {
      state.catalogFallbackFailure = { method: 'local_rollout_catalog',
        code: safeDesktopDiagnostic(error).code, observedAt: now };
      await persist();
    }
  }
  const catalogThreads = catalog
    ? [...(catalog.threads ?? []), ...(catalog.pinnedThreads ?? [])] : fallback?.threads ?? [];
  const primary = new Map(catalogThreads.filter(thread => typeof thread?.id === 'string' && thread.id
    && primaryCatalogChat(thread, hostId))
    .map(thread => [thread.id, thread]));
  const visible = new Set(primary.keys());

  config.targets ??= {};
  for (const thread of primary.values()) {
    if (config.targets[thread.id] || state.discoveredTargets[thread.id]) continue;
    const discovered = { threadId: thread.id, hostId,
      name: thread.title ?? thread.name ?? thread.id, armedAt: state.monitoringSince };
    try {
      if (registerTarget) {
        const registered = await registerTarget(discovered);
        if (registered === false) continue;
      }
    } catch (error) {
      state.discoveryFailures ??= {};
      state.discoveryFailures[thread.id] = { method: 'register_target',
        code: safeDesktopDiagnostic(error, 'list_threads').code, observedAt: now };
      await persist();
      continue;
    }
    const target = { enabled: true, armedAt: discovered.armedAt, name: discovered.name };
    state.discoveredTargets[thread.id] = target;
    config.targets[thread.id] = target;
    delete state.discoveryFailures?.[thread.id];
    await persist();
  }
  for (const [threadId, target] of Object.entries(state.discoveredTargets)) {
    if (!config.targets[threadId]) config.targets[threadId] = target;
  }

  const snapshots = new Map();
  const observedThreads = [];
  const readTarget = async threadId => {
    try {
      const snapshot = await desktop.call('read_thread', { threadId,
        hostId: config.targets[threadId]?.hostId ?? hostId, turnLimit: 1, includeOutputs: false });
      delete state.readFailuresByTarget[threadId];
      snapshots.set(threadId, snapshot);
      const threadType = snapshot.thread?.status?.type;
      state.activityByTarget[threadId] = { status: threadType === 'notLoaded' ? 'not_loaded'
        : statusOf(snapshot) ?? (threadType === 'idle' ? 'idle' : 'unknown'),
        observedAt: now, name: snapshot.thread?.title ?? config.targets[threadId]?.name ?? threadId };
      return snapshot;
    } catch (error) {
      state.readFailuresByTarget[threadId] = { ...safeDesktopDiagnostic(error, 'read_thread'), observedAt: now };
      state.activityByTarget[threadId] = { status: 'unknown', observedAt: now };
      await persist();
      return null;
    }
  };
  for (const [threadId, target] of Object.entries(config.targets)) {
    if (target.enabled === false || (catalog && !visible.has(threadId))) continue;
    const snapshot = await readTarget(threadId);
    if (!snapshot || snapshot.thread?.kind !== 'codex'
      || (snapshot.thread.hostId && snapshot.thread.hostId !== hostId)
      || snapshot.thread.parentThreadId || snapshot.thread.agentId || snapshot.thread.agentRole) continue;
    observedThreads.push({ threadId, snapshot });
    const latestTurnId = snapshot.turns?.[0]?.id;
    for (const oldItem of Object.values(state.pending)) {
      if (oldItem.threadId !== threadId || oldItem.phase !== 'needs_review'
        || oldItem.resetEvidenceStatus !== 'missing' || !latestTurnId || latestTurnId === oldItem.turnId) continue;
      const priorStatus = statusOf(snapshot);
      if (priorStatus === 'turn_completed') oldItem.phase = 'turn_completed';
      else if (priorStatus === 'stopped') oldItem.phase = 'stopped';
      else if (priorStatus === 'needs_user') oldItem.phase = 'needs_user';
      else oldItem.phase = 'superseded';
      oldItem.reason = priorStatus === 'turn_completed'
        ? '原额度失败轮次已被后续完成轮次取代；任务整体完成状态未知'
        : priorStatus === 'stopped' ? '原额度失败轮次已被后续停止轮次取代'
          : priorStatus === 'needs_user' ? '原额度失败轮次已改变，会话需要用户处理'
            : '原额度失败轮次已改变；保留历史记录并按新轮次重新核对';
      await persist();
    }
    const hasOpenItem = Object.values(state.pending).some(item => item.threadId === threadId
      && ['waiting', 'blocked_unavailable', 'manual_running'].includes(item.phase));
    if (hasOpenItem) continue;
    const failure = quotaFailure(snapshot, target.armedAt, usage ?? {});
    if (!failure || state.handled.includes(failure.turnId)) continue;
    const accountId = usage?.accountId ?? null;
    const id = taskId(accountId, hostId, threadId, failure.turnId);
    if (state.pending[id]) continue;
    const interruptedAt = snapshot.turns?.[0]?.completedAt;
    // A currently exhausted window is usable only when its official sample is
    // temporally linked to this failed turn. A later quota cycle must not be
    // attached to an old failure merely because the same account is in use.
    const resetAt = relatedResetAt({ accountId, interruptedAt }, state.quotaObservationsByAccount, config);
    const item = state.pending[id] = { ...failure, id, threadId, hostId, accountId,
      name: snapshot.thread.title ?? target.name ?? threadId, armedAt: target.armedAt, interruptedAt,
      resetAt, eligibleAt: resetAt === null ? null : resetAt + (config.resumeBufferSeconds ?? 120),
      nextCheckAt: resetAt === null ? null : resetAt + (config.resumeBufferSeconds ?? 120),
      autoResumeEnabled: config.items?.[id]?.enabled ?? true,
      phase: resetAt === null ? 'needs_review' : 'waiting' };
    if (resetAt === null) item.resetEvidenceStatus = 'missing';
    item.reason = resetAt === null
      ? '检测到额度错误，但缺少可关联的官方五小时额度恢复时间；需要核对，暂不续跑'
      : '五小时额度中断已登记；等待恢复时间及实际使用许可后继续原会话';
    await persist();
    await log(resetAt === null ? 'needs_review' : 'waiting', { threadId, turnId: failure.turnId, resetAt });
  }
  for (const item of Object.values(state.pending)) {
    if (item.phase !== 'needs_review' || item.resetEvidenceStatus !== 'missing') continue;
    const resetAt = relatedResetAt(item, state.quotaObservationsByAccount, config);
    if (resetAt === null) continue;
    item.resetAt = resetAt;
    item.eligibleAt = resetAt + (config.resumeBufferSeconds ?? 120);
    item.nextCheckAt = item.eligibleAt;
    item.phase = 'waiting';
    item.resetEvidenceStatus = 'restored_from_official_observation';
    item.reason = '已从同账号且与中断时段关联的官方五小时额度记录恢复reset时间；等待缓冲及实际使用许可';
    await persist();
  }

  // Catalog/usage are authorization and safety inputs. A missing read allows
  // collection above, but blocks compaction and all queue processing this tick.
  if (!catalog || !usage) return;

  state.compaction ??= {};
  state.compactionByTarget ??= {};
  state.contextUsageByTarget ??= {};
  const desktopCapabilities = typeof desktop.capabilities === 'function'
    ? await desktop.capabilities() : { activeContextUsage: 'unsupported' };
  const contextUsage = desktopCapabilities.activeContextUsage === 'available'
    && typeof desktop.contextUsage === 'function'
    ? await desktop.contextUsage(config.targets ?? {}) : {};
  state.contextUsageByTarget = contextUsage;
  const compressionQuota = usage;
  for (const [threadId, target] of Object.entries(config.targets ?? {})) {
    if (target.enabled === false) continue;
    const observed = contextUsage[threadId];
    const fresh = observed?.status === 'available' && observed.stale !== true;
    const sample = fresh ? { activeTokens: observed.activeTokens,
      windowTokens: observed.windowTokens, observedAt: Date.parse(observed.timestamp) / 1000 } : null;
    const compaction = state.compactionByTarget[threadId] ??= {};
    let nativeSnapshot = null;
    if (typeof desktop.nativeSnapshot === 'function') {
      try { nativeSnapshot = await desktop.nativeSnapshot(threadId); } catch { /* Fail closed on a disconnected bridge. */ }
    }
    const nativeMatches = nativeSnapshot?.turnId === observed?.turnId;
    const adapter = nativeMatches && typeof desktop.compactionAdapterForTarget === 'function'
      ? desktop.compactionAdapterForTarget(threadId, observed.turnId) : desktop.compactionAdapter;
    try {
      await observeCompaction({ state: compaction, sample,
        threshold: config.compactionThresholdRatio ?? 0.6,
        hasUsage: fresh, ordinaryUsageAllowed: compressionQuota?.ordinaryUsageAllowed === true,
        safeBoundary: nativeMatches && nativeSnapshot?.safeBoundary === true, adapter,
        persist: async () => persist() });
    } catch (error) {
      compaction.status = 'error';
      compaction.reason = `压缩协调状态读取失败 (${safeDesktopDiagnostic(error).code})`;
      await persist();
    }
  }
  const firstTarget = Object.keys(contextUsage).find(id => config.targets?.[id]?.enabled !== false);
  if (firstTarget) state.compaction = state.compactionByTarget[firstTarget];
  else {
    state.compaction.status = 'unsupported';
    state.compaction.reason = '未登记可观测的目标会话';
  }
  for (const item of Object.values(state.pending)) {
    const itemConfig = config.items?.[item.id] ?? {};
    const requestedAt = itemConfig.manualResolutionRequestedAt;
    if (!Number.isFinite(requestedAt) || requestedAt <= (itemConfig.manualResolutionHandledAt ?? 0)) continue;
    if (item.manualResolutionHandledAt >= requestedAt) {
      await acknowledgeManualResolution(item.id, requestedAt);
      continue;
    }
    if (!['sending', 'uncertain'].includes(item.phase) || !visible.has(item.threadId)) continue;
    const snapshot = snapshots.get(item.threadId) ?? await readTarget(item.threadId);
    if (!snapshot) {
      item.reason = '人工核对请求已记录；当前无法确认原会话状态，继续保留发送槽位';
      await persist();
      continue;
    }
    if (statusOf(snapshot) === 'running') {
      item.phase = 'uncertain';
      item.reason = '原会话仍在运行；人工核对请求保留，发送槽位继续占用';
      await persist();
      continue;
    }
    const threadType = snapshot.thread?.status?.type;
    const turnStatus = snapshot.turns?.[0]?.status;
    const confirmedNotRunning = ['idle', 'systemError', 'notLoaded', 'waitingOnApproval', 'needsInput']
      .includes(threadType) && ['failed', 'completed', 'interrupted'].includes(turnStatus);
    if (!confirmedNotRunning) continue;
    item.phase = 'needs_review';
    item.reason = '用户已核对原会话并确认不在运行；插件不会自动重发';
    item.manualResolutionHandledAt = requestedAt;
    item.manuallyResolvedAt = now;
    if (state.activeAutoResume === item.id) state.activeAutoResume = null;
    await persist();
    await acknowledgeManualResolution(item.id, requestedAt);
  }
  // Hold the sole execution slot until the accepted turn is observed running or has ended.
  if (state.activeAutoResume) {
    const active = state.pending[state.activeAutoResume];
    if (!active) return;
    if (['sending', 'uncertain'].includes(active.phase)) return;
    const snapshot = snapshots.get(active.threadId) ?? await readTarget(active.threadId);
    if (!snapshot) { active.phase = 'connection_unavailable'; await persist(); return; }
    const status = statusOf(snapshot);
    if (!status) return; // Stale or unavailable acknowledgement must not free the slot.
    const latestTurn = snapshot.turns?.[0];
    if (status === 'needs_user') {
      active.phase = 'needs_user';
      if (latestTurn?.status === 'inProgress') active.runningTurnId = latestTurn.id;
      active.reason = '当前续跑轮次正在等待用户处理；保留串行执行槽位，避免启动下一个任务';
      await persist(); return;
    }
    if (status === 'running') {
      active.phase = 'running';
      active.runningTurnId = latestTurn?.id;
      await persist(); return;
    }
    if (latestTurn?.id === active.turnId) return;
    active.phase = status === 'failed' ? 'needs_review' : status;
    state.activeAutoResume = null;
    await persist();
    if (status === 'running') return;
  }

  if (catalog) for (const [threadId, target] of Object.entries(config.targets)) {
    if (!visible.has(threadId)) {
      for (const pending of Object.values(state.pending).filter(item => item.threadId === threadId
        && ['waiting', 'blocked_unavailable'].includes(item.phase))) {
        if (pending.phase !== 'blocked_unavailable') {
          pending.phase = 'blocked_unavailable';
          pending.reason = '当前会话未出现在可确认目录中；保留记录并暂停发送';
        }
        await persist();
      }
      continue;
    }
    const snapshot = snapshots.get(threadId);
    if (!snapshot) continue;
    let pending = Object.values(state.pending).find(item => item.threadId === threadId
      && ['waiting', 'blocked_unavailable', 'manual_running'].includes(item.phase));
    if (pending && config.items?.[pending.id]?.enabled !== undefined) {
      pending.autoResumeEnabled = config.items[pending.id].enabled;
    }
    if (pending?.phase === 'blocked_unavailable') {
      pending.phase = 'waiting'; pending.reason = null; await persist();
    }
    if (pending && statusOf(snapshot) === 'running') {
      pending.phase = 'manual_running';
      pending.manualTurnId = snapshot.turns?.[0]?.id ?? pending.manualTurnId ?? null;
      pending.reason = '检测到用户已继续此会话；等待该轮结束后再核对';
      await persist();
      continue;
    }
    if (pending?.phase === 'manual_running') {
      const latestTurn = snapshot.turns?.[0];
      if (latestTurn?.id === pending.turnId || latestTurn?.id !== pending.manualTurnId) continue;
      const status = statusOf(snapshot);
      if (status === 'turn_completed') {
        pending.phase = 'turn_completed';
        pending.reason = '用户手动续跑的轮次已完成；任务整体完成状态未知';
      } else if (status === 'stopped') {
        pending.phase = 'stopped';
        pending.autoResumeEnabled = false;
        pending.reason = '用户手动停止了续跑轮次';
      } else if (status === 'needs_user') {
        pending.phase = 'needs_user';
        pending.reason = '用户手动续跑的轮次需要用户处理';
      } else {
        pending.phase = 'superseded';
        pending.reason = '用户手动续跑后出现新失败；需要重新核对';
      }
      await persist();
      continue;
    }
    if (pending && (!sameFailure(snapshot, pending) || pending.armedAt !== target.armedAt)) {
      const observedStatus = statusOf(snapshot);
      if (observedStatus === 'stopped') {
        pending.phase = 'stopped';
        pending.autoResumeEnabled = false;
        pending.reason = '原失败轮次已停止；此项已关闭自动续跑';
      } else if (observedStatus === 'turn_completed') {
        pending.phase = 'turn_completed';
        pending.reason = '原失败轮次已完成；任务整体完成状态未知';
      } else if (observedStatus === 'needs_user') {
        pending.phase = 'needs_user';
        pending.reason = '会话需要用户处理';
      } else {
        pending.phase = 'superseded';
        pending.reason = '原失败轮次已改变；需要重新核对';
      }
      await persist();
      continue;
    }
    if (target.enabled === false || (pending && !pending.autoResumeEnabled)) continue;
  }

  // A manual live turn blocks only its own queued resume; unrelated chats do not stall the queue.
  if (observedThreads.some(({ threadId, snapshot }) => statusOf(snapshot) === 'running'
    && Object.values(state.pending).some(item => item.threadId === threadId
      && ['waiting', 'blocked_unavailable', 'manual_running'].includes(item.phase)))) return;

  state.nextRecoveryCheckAtByAccount ??= {};
  const candidates = Object.values(state.pending).filter(item => item.phase === 'waiting'
    && item.autoResumeEnabled !== false && config.items?.[item.id]?.enabled !== false
    && config.targets[item.threadId]?.enabled !== false
    && Number.isFinite(item.resetAt) && Number.isFinite(item.eligibleAt)
    && now >= item.eligibleAt && now >= (item.nextCheckAt ?? 0)
    && now >= (state.nextRecoveryCheckAtByAccount[item.accountId ?? 'unknown-account'] ?? 0))
    .sort((a, b) => a.interruptedAt - b.interruptedAt || a.id.localeCompare(b.id));
  const pending = candidates[0];
  if (!pending) return;
  const target = config.targets[pending.threadId];
  let allowed;
  try {
    allowed = await desktop.call('get_usage_limits');
    delete state.usageReadFailure;
  } catch (error) {
    state.usageReadFailure = { ...safeDesktopDiagnostic(error, 'get_usage_limits'), observedAt: now };
    await persist();
    return;
  }
  if (allowed.ordinaryUsageAllowed !== true
    || (pending.accountId && allowed.accountId !== pending.accountId)) {
    pending.nextCheckAt = now + (config.recoveryRetrySeconds ?? 60);
    pending.phase = 'waiting';
    pending.reason = allowed.ordinaryUsageAllowed === true ? '账号与中断时不一致' : '额度许可尚未恢复';
    const accountKey = pending.accountId ?? 'unknown-account';
    const next = now + (config.recoveryRetrySeconds ?? 60);
    state.nextRecoveryCheckAtByAccount[accountKey] = next;
    for (const sibling of Object.values(state.pending)) {
      if (sibling.accountId === pending.accountId && sibling.phase === 'waiting') {
        sibling.nextCheckAt = Math.max(sibling.nextCheckAt ?? 0, next);
      }
    }
    await persist();
    return;
  }
  let fresh;
  try {
    fresh = await desktop.call('read_thread', {
      threadId: pending.threadId, hostId: config.hostId, turnLimit: 1, includeOutputs: false,
    });
    delete state.readFailuresByTarget[pending.threadId];
  } catch (error) {
    state.readFailuresByTarget[pending.threadId] = {
      ...safeDesktopDiagnostic(error, 'read_thread'), observedAt: now,
    };
    await persist();
    return;
  }
  if (!sameFailure(fresh, pending)) {
    pending.phase = 'superseded'; pending.reason = '原失败轮次已改变；需要重新核对';
    await persist(); return;
  }
  const current = configurationEnabledNow(config, pending, stillEnabled);
  if (!current) return;
  let latestUsage;
  try {
    latestUsage = await desktop.call('get_usage_limits');
  } catch (error) {
    state.usageReadFailure = { ...safeDesktopDiagnostic(error, 'get_usage_limits'), observedAt: now };
    await persist();
    return;
  }
  delete state.usageReadFailure;
  if (latestUsage.ordinaryUsageAllowed !== true
    || (pending.accountId && latestUsage.accountId !== pending.accountId)
    || !configurationEnabledNow(config, pending, stillEnabled)) {
    pending.nextCheckAt = now + (config.recoveryRetrySeconds ?? 60);
    await persist(); return;
  }
  pending.phase = 'sending'; pending.claimedAt = now;
  state.activeAutoResume = pending.id;
  await persist();
  await log('sending', { threadId: pending.threadId, turnId: pending.turnId });
  try {
    await desktop.call('send_message_to_thread', { threadId: pending.threadId,
      hostId: config.hostId, prompt: CONTINUE_PROMPT });
    pending.phase = 'sent'; pending.sentAt = now;
    await persist(); await log('sent', { threadId: pending.threadId, turnId: pending.turnId });
  } catch (error) {
    pending.phase = 'uncertain'; pending.reason = '发送结果未确认，已停止自动重发';
    await persist(); await log('uncertain', { threadId: pending.threadId, reason: pending.reason });
    throw error;
  }
}

function configurationEnabledNow(config, pending, stillEnabled) {
  return config.enabled && config.targets[pending.threadId]?.enabled !== false
    && config.items?.[pending.id]?.enabled !== false
    && stillEnabled(pending.threadId, pending.armedAt, pending.id);
}
