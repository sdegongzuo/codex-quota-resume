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

// persist 必须完成后才能发送；结果不确定时保留 sending，绝不自动重发。
export async function tick({ desktop, config, state, now, persist, log, stillEnabled = () => true }) {
  if (!config.enabled) return;
  const catalog = await desktop.call('list_threads', { limit: 50 });
  const visible = new Set([...(catalog.threads ?? []), ...(catalog.pinnedThreads ?? [])]
    .filter(thread => thread.kind === 'codex').map(thread => thread.id));
  const usage = await desktop.call('get_usage_limits');
  for (const [threadId, target] of Object.entries(config.targets)) {
    if (!target.enabled) continue;
    if (!visible.has(threadId)) {
      const pending = state.pending[threadId];
      if (pending?.phase === 'waiting') {
        pending.phase = 'cancelled';
        state.handled.push(pending.turnId);
        await persist();
        await log('cancelled', { threadId, reason: '聊天已离开当前可见目录，停止自动继续' });
      }
      continue;
    }
    const snapshot = await desktop.call('read_thread', {
      threadId, hostId: config.hostId, turnLimit: 1, includeOutputs: false,
    });
    let pending = state.pending[threadId];
    if (pending && pending.phase !== 'waiting') continue;
    if (pending && (!sameFailure(snapshot, pending) || pending.armedAt !== target.armedAt)) {
      pending.phase = 'cancelled';
      state.handled.push(pending.turnId);
      await persist();
      await log('cancelled', { threadId, reason: '聊天已继续、完成或被手动改变' });
      continue;
    }
    if (!pending) {
      const failure = quotaFailure(snapshot, target.armedAt, usage);
      if (!failure || state.handled.includes(failure.turnId)) continue;
      pending = state.pending[threadId] = { ...failure, armedAt: target.armedAt,
        accountId: usage.accountId ?? null, phase: 'waiting' };
      await persist();
      await log('waiting', { threadId, turnId: failure.turnId, resetAt: failure.resetAt });
    }
    if (now < pending.resetAt + 5 || usage.ordinaryUsageAllowed !== true) continue;
    if (pending.accountId && usage.accountId !== pending.accountId) continue;
    // 再读一次缩小用户操作与发送之间的竞争窗口。
    const fresh = await desktop.call('read_thread', {
      threadId, hostId: config.hostId, turnLimit: 1, includeOutputs: false,
    });
    if (!sameFailure(fresh, pending)) {
      pending.phase = 'cancelled';
      state.handled.push(pending.turnId);
      await persist();
      continue;
    }
    const allowed = await desktop.call('get_usage_limits');
    if (allowed.ordinaryUsageAllowed !== true || !stillEnabled(threadId, target.armedAt)) continue;
    if (pending.accountId && allowed.accountId !== pending.accountId) continue;
    pending.phase = 'sending';
    state.handled.push(pending.turnId);
    await persist();
    await log('sending', { threadId, turnId: pending.turnId });
    try {
      await desktop.call('send_message_to_thread', {
        threadId, hostId: config.hostId, prompt: CONTINUE_PROMPT,
      });
      pending.phase = 'sent';
      await persist();
      await log('sent', { threadId, turnId: pending.turnId });
    } catch (error) {
      pending.phase = 'uncertain';
      await persist();
      await log('uncertain', { threadId, reason: '发送结果未确认，已停止自动重发' });
      throw error;
    }
  }
}
