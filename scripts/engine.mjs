import { observeCompaction } from './compaction.mjs';
import { taskId } from './store.mjs';

export const CONTINUE_PROMPT = '继续完成本聊天中尚未完成的用户任务，遵守已有约束和授权。如果任务已经完成，或需要用户回答、确认或提供信息，请说明并停止，不要另起任务。';

export function exhaustedUntil(usage) {
  const buckets = Object.values(usage.rateLimitsByLimitId ?? { legacy: usage.rateLimits });
  const fiveHour = buckets.flatMap(bucket => [bucket?.primary, bucket?.secondary])
    .filter(window => window?.windowDurationMins === 300 && window.usedPercent >= 100
      && Number.isFinite(window.resetsAt));
  return fiveHour.length ? Math.max(...fiveHour.map(window => window.resetsAt)) : null;
}

export function quotaFailure(snapshot, armedAt, usage) {
  const turn = snapshot.turns?.[0];
  if (snapshot.thread?.kind !== 'codex' || turn?.status !== 'failed'
    || !turn.completedAt || turn.completedAt < armedAt) return null;
  const code = turn.error?.codexErrorInfo;
  // 普通网络故障、用户中断和每分钟速率限制不能误认为五小时额度中断。
  if (code !== 'usageLimitExceeded' && code !== 'rateLimitExceeded') return null;
  const resetAt = exhaustedUntil(usage);
  return resetAt === null ? null : { turnId: turn.id, resetAt };
}

export function sameFailure(snapshot, pending) {
  const turn = snapshot.turns?.[0];
  return snapshot.thread?.kind === 'codex'
    && ['idle', 'systemError', 'notLoaded'].includes(snapshot.thread?.status?.type)
    && turn?.id === pending.turnId && turn.status === 'failed'
    && ['usageLimitExceeded', 'rateLimitExceeded'].includes(turn.error?.codexErrorInfo);
}

const statusOf = snapshot => {
  const threadType = snapshot.thread?.status?.type;
  const turnStatus = snapshot.turns?.[0]?.status;
  if (['waitingOnApproval', 'needsInput', 'waiting_on_user_input'].includes(threadType)) return 'needs_user';
  if (turnStatus === 'completed') return 'turn_completed';
  if (turnStatus === 'interrupted') return 'stopped';
  if (turnStatus === 'inProgress' || ['busy', 'working'].includes(threadType)) return 'running';
  if (turnStatus === 'failed') return 'failed';
  return null;
};

// persist 必须完成后才能发送；结果不确定时保留 sending，绝不自动重发。
export async function tick({ desktop, config, state, now, persist, log, stillEnabled = () => true,
  acknowledgeManualResolution = async () => {} }) {
  if (!config.enabled) return;
  state.compaction ??= {};
  state.compactionByTarget ??= {};
  state.contextUsageByTarget ??= {};
  const desktopCapabilities = typeof desktop.capabilities === 'function'
    ? await desktop.capabilities() : { activeContextUsage: 'unsupported' };
  const contextUsage = desktopCapabilities.activeContextUsage === 'available'
    && typeof desktop.contextUsage === 'function'
    ? await desktop.contextUsage(config.targets ?? {}) : {};
  state.contextUsageByTarget = contextUsage;
  const compressionQuota = await desktop.call('get_usage_limits');
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
    await observeCompaction({ state: compaction, sample,
      threshold: config.compactionThresholdRatio ?? 0.6,
      hasUsage: fresh, ordinaryUsageAllowed: compressionQuota.ordinaryUsageAllowed === true,
      safeBoundary: nativeMatches && nativeSnapshot?.safeBoundary === true, adapter,
      persist: async () => persist() });
  }
  const firstTarget = Object.keys(contextUsage).find(id => config.targets?.[id]?.enabled !== false);
  if (firstTarget) state.compaction = state.compactionByTarget[firstTarget];
  else {
    state.compaction.status = 'unsupported';
    state.compaction.reason = '未登记可观测的目标会话';
  }
  const catalog = await desktop.call('list_threads', { limit: 50 });
  const visible = new Set([...(catalog.threads ?? []), ...(catalog.pinnedThreads ?? [])]
    .filter(thread => thread.kind === 'codex').map(thread => thread.id));
  const usage = await desktop.call('get_usage_limits');
  for (const item of Object.values(state.pending)) {
    const itemConfig = config.items?.[item.id] ?? {};
    const requestedAt = itemConfig.manualResolutionRequestedAt;
    if (!Number.isFinite(requestedAt) || requestedAt <= (itemConfig.manualResolutionHandledAt ?? 0)) continue;
    if (item.manualResolutionHandledAt >= requestedAt) {
      await acknowledgeManualResolution(item.id, requestedAt);
      continue;
    }
    if (!['sending', 'uncertain'].includes(item.phase) || !visible.has(item.threadId)) continue;
    let snapshot;
    try {
      snapshot = await desktop.call('read_thread', { threadId: item.threadId,
        hostId: item.hostId ?? config.hostId, turnLimit: 1, includeOutputs: false });
    } catch {
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
    let snapshot;
    try {
      snapshot = await desktop.call('read_thread', { threadId: active.threadId,
        hostId: active.hostId ?? config.hostId, turnLimit: 1, includeOutputs: false });
    } catch { active.phase = 'connection_unavailable'; await persist(); return; }
    const status = statusOf(snapshot);
    if (!status) return; // Stale or unavailable acknowledgement must not free the slot.
    const latestTurn = snapshot.turns?.[0];
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

  const observedThreads = [];
  for (const [threadId, target] of Object.entries(config.targets)) {
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
    const snapshot = await desktop.call('read_thread', {
      threadId, hostId: config.hostId, turnLimit: 1, includeOutputs: false,
    });
    observedThreads.push({ threadId, snapshot });
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
    if (!pending) {
      const failure = quotaFailure(snapshot, target.armedAt, usage);
      if (!failure) continue;
      if (state.handled?.includes(failure.turnId)) continue;
      const id = taskId(usage.accountId, config.hostId, threadId, failure.turnId);
      if (state.pending[id]) continue;
      pending = state.pending[id] = { ...failure, id, threadId,
        name: snapshot.thread?.title ?? target.name ?? threadId, armedAt: target.armedAt,
        interruptedAt: snapshot.turns[0].completedAt,
        eligibleAt: failure.resetAt + (config.resumeBufferSeconds ?? 120),
        nextCheckAt: failure.resetAt + (config.resumeBufferSeconds ?? 120),
        accountId: usage.accountId ?? null,
        autoResumeEnabled: config.items?.[id]?.enabled ?? true, phase: 'waiting' };
      pending.hostId = config.hostId ?? 'local';
      pending.reason = '活动上下文及真实压缩接口尚未提供；额度续跑独立排队';
      await persist();
      await log('waiting', { threadId, turnId: failure.turnId, resetAt: failure.resetAt });
    }
  }

  // A manual live turn blocks only its own queued resume; unrelated chats do not stall the queue.
  if (observedThreads.some(({ threadId, snapshot }) => statusOf(snapshot) === 'running'
    && Object.values(state.pending).some(item => item.threadId === threadId
      && ['waiting', 'blocked_unavailable', 'manual_running'].includes(item.phase)))) return;

  state.nextRecoveryCheckAtByAccount ??= {};
  const candidates = Object.values(state.pending).filter(item => item.phase === 'waiting'
    && item.autoResumeEnabled !== false && config.items?.[item.id]?.enabled !== false
    && config.targets[item.threadId]?.enabled !== false
    && now >= item.eligibleAt && now >= (item.nextCheckAt ?? 0)
    && now >= (state.nextRecoveryCheckAtByAccount[item.accountId ?? 'unknown-account'] ?? 0))
    .sort((a, b) => a.interruptedAt - b.interruptedAt || a.id.localeCompare(b.id));
  const pending = candidates[0];
  if (!pending) return;
  const target = config.targets[pending.threadId];
  const allowed = await desktop.call('get_usage_limits');
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
  const fresh = await desktop.call('read_thread', {
    threadId: pending.threadId, hostId: config.hostId, turnLimit: 1, includeOutputs: false,
  });
  if (!sameFailure(fresh, pending)) {
    pending.phase = 'superseded'; pending.reason = '原失败轮次已改变；需要重新核对';
    await persist(); return;
  }
  const current = configurationEnabledNow(config, pending, stillEnabled);
  if (!current) return;
  const latestUsage = await desktop.call('get_usage_limits');
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
