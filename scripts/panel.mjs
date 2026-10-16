import { createServer } from 'node:http';
import { renderPanel } from './panel-view.mjs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { append, configuration, taskId } from './store.mjs';
import { safeDesktopDiagnostic } from './desktop.mjs';
import { readState } from './state-store.mjs';
import { panelQuota } from './quota-view.mjs';

export function panelConnection(connection, now = Date.now() / 1000) {
  if (!connection) return { status: 'unconfirmed', observedAt: null, reason: null };
  const stale = !Number.isFinite(connection.observedAt) || now - connection.observedAt > 90;
  return { status: stale ? 'stale' : connection.status, observedAt: connection.observedAt ?? null,
    reason: stale ? '后台检查超过 90 秒未更新，请核对后台状态' : connection.reason ?? null,
    ...(connection.method ? safeDesktopDiagnostic(connection, connection.method) : {}) };
}

export function projectQueue(pending, config, activeAutoResume, includeHistory = false) {
  const groups = new Map();
  for (const item of Object.values(pending ?? {})) {
    const key = JSON.stringify([item.accountId ?? 'unknown-account', item.hostId ?? 'local', item.threadId]);
    const previous = groups.get(key);
    const historyCount = (previous?.historyCount ?? 0) + 1;
    const safeId = taskId(item.accountId, item.hostId, item.threadId, item.turnId);
    const newest = !previous || item.interruptedAt > previous.newestAt
      || (item.interruptedAt === previous.newestAt && safeId.localeCompare(previous.newestId) > 0);
    const hasUncertainSlot = ['sending', 'uncertain'].includes(item.phase);
    const previousUncertainSlot = ['sending', 'uncertain'].includes(previous?.item.phase);
    const chooseItem = !previous || (hasUncertainSlot !== previousUncertainSlot
      ? hasUncertainSlot : newest);
    groups.set(key, { item: chooseItem ? item : previous.item, historyCount,
      newestAt: newest ? item.interruptedAt : previous.newestAt,
      newestId: newest ? safeId : previous.newestId,
      selectedIsLatest: chooseItem ? newest : (newest ? false : previous.selectedIsLatest) });
  }
  const selected = includeHistory
    ? Object.values(pending ?? {}).map(item => ({ item, historyCount: 1,
      selectedIsLatest: groups.get(JSON.stringify([item.accountId ?? 'unknown-account', item.hostId ?? 'local', item.threadId]))?.newestId
        === taskId(item.accountId, item.hostId, item.threadId, item.turnId) }))
    : [...groups.values()];
  return selected.map(({ item, historyCount, selectedIsLatest }) => {
    const id = taskId(item.accountId, item.hostId, item.threadId, item.turnId);
    const itemConfig = config.items?.[id] ?? config.items?.[item.id] ?? config.items?.[item.legacyId] ?? {};
    return {
    id, threadId: item.threadId, name: item.name,
    interruptedAt: item.interruptedAt, eligibleAt: item.eligibleAt,
    phase: item.phase, reason: item.reason, historyCount,
    runningTurnId: item.runningTurnId ?? null,
    canStop: !!item.runningTurnId && (item.phase === 'running'
      || (item.phase === 'needs_user' && activeAutoResume === item.id)),
    isLatest: selectedIsLatest,
    itemEnabled: itemConfig.enabled ?? item.autoResumeEnabled ?? true,
    manualResolutionRequested: Number.isFinite(itemConfig.manualResolutionRequestedAt)
      && itemConfig.manualResolutionRequestedAt > (itemConfig.manualResolutionHandledAt ?? 0),
    targetEnabled: config.targets[item.threadId]?.enabled !== false,
    };
  }).sort((a, b) => a.interruptedAt - b.interruptedAt || a.id.localeCompare(b.id));
}

function json(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(value));
}

export function startPanel({ host = '127.0.0.1', port = 0, accessToken, configPath, statePath, capabilities,
  onGlobalEnabled = async () => {}, onStop = null }) {
  if (accessToken !== undefined && !/^[A-Za-z0-9_-]{43}$/.test(accessToken)) throw Error('Invalid panel access token');
  const token = accessToken ?? randomBytes(32).toString('base64url');
  const server = createServer(async (request, response) => {
    try {
    const address = request.socket.remoteAddress;
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address)) return json(response, 403, { error: '只允许本机访问' });
    const actualPort = server.address()?.port;
    const exactOrigin = `http://${host}:${actualPort}`;
    if (request.headers.host !== `${host}:${actualPort}`) return json(response, 403, { error: 'Host 不匹配' });
    const origin = request.headers.origin;
    if (origin && origin !== exactOrigin) return json(response, 403, { error: '来源不匹配' });
    if (request.url?.split('?')[0] === '/') {
      const url = new URL(request.url, `http://${host}`);
      if (url.searchParams.get('token') !== token) return json(response, 403, { error: '缺少本机访问令牌' });
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      response.end(renderPanel(token, typeof onStop === 'function')); return;
    }
    const supplied = Buffer.from(request.headers['x-quota-resume-token'] ?? '');
    const expected = Buffer.from(token);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return json(response, 403, { error: '令牌无效' });
    const config = configuration(configPath);
    if (request.method === 'GET' && request.url === '/api/state') {
      const state = readState(statePath) ?? { pending: {} };
      const items = projectQueue(state.pending, config, state.activeAutoResume);
      const historyItems = projectQueue(state.pending, config, state.activeAutoResume, true);
      const connection = panelConnection(state.connection);
      const safeConfig = { enabled: config.enabled, compactionThresholdRatio: config.compactionThresholdRatio,
        resumeBufferSeconds: config.resumeBufferSeconds, recoveryRetrySeconds: config.recoveryRetrySeconds };
      const compaction = state.compaction ?? { status: capabilities.compaction, reason: capabilities.limitation };
      const contextIds = new Set([...Object.keys(config.targets ?? {}), ...Object.keys(state.contextUsageByTarget ?? {})]);
      const contextUsage = [...contextIds].map(threadId => {
        const sample = state.contextUsageByTarget?.[threadId] ?? { status: 'unavailable' };
        const activity = state.activityByTarget?.[threadId];
        const activityFresh = Number.isFinite(activity?.observedAt)
          && Date.now() / 1000 - activity.observedAt <= 90 && !state.readFailuresByTarget?.[threadId];
        const activityStatus = activityFresh ? activity.status : 'unknown';
        const delay = sample.timestamp ? Math.max(0, (Date.now() - Date.parse(sample.timestamp)) / 1000) : null;
        const stale = sample.stale === true || delay !== null && delay > 120;
        return {
          threadId, name: activity?.name ?? config.targets?.[threadId]?.name ?? threadId,
          activityStatus, isRunning: activityStatus === 'running',
          activityObservedAt: activity?.observedAt ?? null,
          status: sample.status === 'available' && stale ? 'stale' : sample.status,
          activeTokens: sample.activeTokens ?? null, windowTokens: sample.windowTokens ?? null,
          ratio: sample.ratio ?? null, model: sample.model ?? null, turnId: sample.turnId ?? null,
          timestamp: sample.timestamp ?? null, stale,
          completionDelaySeconds: delay ?? sample.completionDelaySeconds ?? null,
          reason: sample.reason ?? null,
          compactionStatus: state.compactionByTarget?.[threadId]?.status
            ?? (capabilities.compaction === 'connected_unverified'
              ? '桥接已认证，真实效果尚未验收' : 'unsupported'),
          compactionReason: state.compactionByTarget?.[threadId]?.reason ?? capabilities.limitation,
        };
      });
      const compactionLabels = { unsupported: '不支持', not_thresholded: '未达到阈值',
        waiting_boundary: '等待安全边界', compacting: '压缩进行中', completed: '压缩已确认',
        uncertain: '压缩结果待核对', quota_unavailable: '额度许可未确认',
        connected_unverified: '桥接已认证，真实效果尚未验收',
        above_threshold_after_compaction: '压缩后仍高于阈值' };
      return json(response, 200, { config: safeConfig, items, historyItems, connection, capabilities, contextUsage, quota: panelQuota(state),
        compaction: { ...compaction, status: compactionLabels[compaction.status] ?? compaction.status } });
    }
    if (request.method !== 'POST') return json(response, 404, { error: 'not found' });
    let body = '';
    for await (const chunk of request) { body += chunk; if (body.length > 8192) return json(response, 413, { error: 'request too large' }); }
    let value;
    try { value = JSON.parse(body); } catch { return json(response, 400, { error: 'invalid JSON' }); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return json(response, 400, { error: '请求内容必须是JSON对象' });
    }
    if (request.url === '/api/global' && typeof value.enabled === 'boolean') {
      append(configPath, { type: 'global', enabled: value.enabled });
      if (value.enabled) await onGlobalEnabled();
    }
    else if (request.url === '/api/item' && typeof value.id === 'string' && typeof value.enabled === 'boolean') {
      const state = readState(statePath) ?? { pending: {} };
      const item = state.pending?.[value.id] ?? Object.values(state.pending ?? {}).find(candidate =>
        taskId(candidate.accountId, candidate.hostId, candidate.threadId, candidate.turnId) === value.id);
      if (!item) return json(response, 404, { error: 'queue item not found' });
      append(configPath, { type: 'item', id: value.id, value: { enabled: value.enabled } });
    } else if (request.url === '/api/stop' && typeof value.id === 'string' && typeof value.turnId === 'string') {
      if (typeof onStop !== 'function') return json(response, 501, { error: '当前安装尚未接通原生停止接口' });
      const state = readState(statePath) ?? { pending: {} };
      const item = Object.values(state.pending ?? {}).find(candidate =>
        taskId(candidate.accountId, candidate.hostId, candidate.threadId, candidate.turnId) === value.id);
      if (!item || !(item.phase === 'running' || (item.phase === 'needs_user' && state.activeAutoResume === item.id))
        || !item.runningTurnId || item.runningTurnId !== value.turnId) {
        return json(response, 409, { error: '运行轮次已变化，请刷新任务列表后操作' });
      }
      // Retain the user's stop choice before requesting the backend operation.
      append(configPath, { type: 'item', id: value.id, value: { enabled: false } });
      append(configPath, { type: 'target', threadId: item.threadId, value: { enabled: false } });
      const result = await onStop({ threadId: item.threadId, turnId: value.turnId,
        requestId: `stop:${value.id}:${value.turnId}` });
      return json(response, 200, { saved: true, operation: result });
    } else if (request.url === '/api/resolve' && typeof value.id === 'string') {
      const state = readState(statePath) ?? { pending: {} };
      const item = state.pending?.[value.id] ?? Object.values(state.pending ?? {}).find(candidate =>
        taskId(candidate.accountId, candidate.hostId, candidate.threadId, candidate.turnId) === value.id);
      if (!item || !['sending', 'uncertain'].includes(item.phase)) return json(response, 409, { error: '只有发送结果待核对的任务可请求解除等待' });
      const itemConfig = config.items?.[value.id] ?? {};
      if (!(Number.isFinite(itemConfig.manualResolutionRequestedAt)
        && itemConfig.manualResolutionRequestedAt > (itemConfig.manualResolutionHandledAt ?? 0))) {
        append(configPath, { type: 'item', id: value.id, value: { manualResolutionRequestedAt: Math.floor(Date.now() / 1000) } });
      }
    }
    else if (request.url === '/api/settings' && Number.isFinite(value.compactionThresholdRatio)
      && value.compactionThresholdRatio >= 0.1 && value.compactionThresholdRatio <= 0.9) {
      append(configPath, { type: 'settings', value: { compactionThresholdRatio: value.compactionThresholdRatio } });
    } else return json(response, 400, { error: 'unsupported setting' });
    return json(response, 200, { saved: true });
    } catch {
      if (response.destroyed || response.writableEnded) return;
      if (response.headersSent) return response.destroy();
      return json(response, request.aborted ? 400 : 500,
        { error: request.aborted ? '请求读取中断' : '面板请求处理失败' });
    }
  });
  server.listen(port, host);
  return { server, token, getUrl: () => `http://${host}:${server.address().port}/?token=${encodeURIComponent(token)}` };
}
