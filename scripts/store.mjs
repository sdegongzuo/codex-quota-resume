import { existsSync, readFileSync, appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

export const taskId = (accountId, hostId, threadId, turnId) => createHash('sha256')
  .update(JSON.stringify([accountId ?? 'unknown-account', hostId ?? 'local', threadId, turnId]))
  .digest('hex');
export const shouldLaunchWatcher = (fromHook, globallyEnabled) => !fromHook || globallyEnabled;

// Append-only event log keeps prior user choices and task records intact.
export function records(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').flatMap(line => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

export function append(path, value) {
  appendFileSync(path, '\n' + JSON.stringify(value) + '\n');
}

export function configuration(path) {
  const result = { schemaVersion: 2, enabled: true, targets: {}, items: {}, intervalSeconds: 30,
    compactionThresholdRatio: 0.6, resumeBufferSeconds: 120, recoveryRetrySeconds: 60 };
  const noteMonitoringStart = armedAt => {
    if (!Number.isFinite(armedAt)) return;
    result.monitoringSince = result.monitoringSince === undefined
      ? armedAt : Math.min(result.monitoringSince, armedAt);
  };
  for (const entry of records(path)) {
    if (entry.type === 'disable') result.enabled = false;
    if (entry.type === 'global') result.enabled = entry.enabled === true;
    if (entry.type === 'enable') {
      result.enabled = true;
      result.pipe = entry.pipe;
      result.callerThread = entry.threadId;
      result.hostId = entry.hostId;
      noteMonitoringStart(entry.armedAt);
      result.targets[entry.threadId] = { ...(result.targets[entry.threadId] ?? {}), enabled: true,
        armedAt: entry.armedAt, name: entry.name ?? result.targets[entry.threadId]?.name ?? entry.threadId };
    }
    if (entry.type === 'register') {
      result.pipe = entry.pipe;
      result.callerThread = entry.threadId;
      result.hostId = entry.hostId;
      noteMonitoringStart(entry.armedAt);
      if (!result.targets[entry.threadId]) result.targets[entry.threadId] = {
        enabled: true, armedAt: entry.armedAt, name: entry.name ?? entry.threadId,
      };
    }
    if (entry.type === 'discover' && entry.hostId === result.hostId
      && typeof entry.threadId === 'string' && Number.isFinite(entry.armedAt)) {
      if (!result.targets[entry.threadId]) result.targets[entry.threadId] = {
        enabled: true, armedAt: entry.armedAt, name: entry.name ?? entry.threadId,
      };
    }
    if (entry.type === 'target') {
      result.targets[entry.threadId] = { ...(result.targets[entry.threadId] ?? {}), ...entry.value };
    }
    if (entry.type === 'nativeBridge') result.nativeBridge = entry.value;
    if (entry.type === 'item') result.items[entry.id] = { ...(result.items[entry.id] ?? {}), ...entry.value };
    if (entry.type === 'settings') {
      for (const key of ['compactionThresholdRatio', 'resumeBufferSeconds', 'recoveryRetrySeconds', 'intervalSeconds']) {
        if (entry.value?.[key] !== undefined) result[key] = entry.value[key];
      }
    }
  }
  return result;
}

export function migrateState(raw, config) {
  const state = { ...(raw ?? {}), pending: { ...(raw?.pending ?? {}) }, handled: [...(raw?.handled ?? [])],
    discoveredTargets: { ...(raw?.discoveredTargets ?? {}) },
    quotaObservationsByAccount: { ...(raw?.quotaObservationsByAccount ?? {}) },
    readFailuresByTarget: { ...(raw?.readFailuresByTarget ?? {}) } };
  let changed = false;
  for (const [oldKey, item] of Object.entries(state.pending)) {
    if (!item?.turnId) continue;
    const threadId = item.threadId ?? oldKey;
    const id = taskId(item.accountId, item.hostId ?? config.hostId, threadId, item.turnId);
    if (item.id === id && oldKey === id) continue;
    const legacyId = item.id ?? oldKey;
    delete state.pending[oldKey];
    state.pending[id] = { ...item, id, threadId, hostId: item.hostId ?? config.hostId ?? 'local',
      ...(legacyId !== id ? { legacyId } : {}),
      interruptedAt: item.interruptedAt ?? item.armedAt ?? item.resetAt ?? 0,
      eligibleAt: item.eligibleAt ?? ((item.resetAt ?? 0) + (config.resumeBufferSeconds ?? 120)),
      nextCheckAt: item.nextCheckAt ?? ((item.resetAt ?? 0) + (config.resumeBufferSeconds ?? 120)),
      autoResumeEnabled: item.autoResumeEnabled ?? config.items?.[id]?.enabled
        ?? config.items?.[legacyId]?.enabled ?? true };
    if (['sending', 'sent', 'uncertain', 'running'].includes(item.phase)) state.activeAutoResume = id;
    changed = true;
  }
  return { state, changed };
}
