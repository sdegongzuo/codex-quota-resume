import { readdirSync, realpathSync, statSync, createReadStream } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const cache = new Map();

function stringEnd(text, start) {
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === '\\') { i++; continue; }
    if (text[i] === '"') return i + 1;
  }
  return -1;
}

function skipValue(text, start) {
  if (text[start] === '"') return stringEnd(text, start);
  if (text[start] !== '{' && text[start] !== '[') {
    let i = start;
    while (i < text.length && ![',', '}', ']'].includes(text[i])) i++;
    return i;
  }
  const stack = [text[start] === '{' ? '}' : ']'];
  let quoted = false;
  for (let i = start + 1; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '\\') i++;
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === '{') stack.push('}');
    else if (c === '[') stack.push(']');
    else if (c === '}' || c === ']') {
      if (stack.pop() !== c) return -1;
      if (!stack.length) return i + 1;
    }
  }
  return -1;
}

// Read only the two small top-level routing fields without parsing payload/transcript content.
function topLevelFields(line) {
  const values = {};
  let i = 0;
  while (/\s/.test(line[i] ?? '')) i++;
  if (line[i++] !== '{') return values;
  while (i < line.length) {
    while (/\s/.test(line[i] ?? '')) i++;
    if (line[i] === '}') break;
    if (line[i] !== '"') return values;
    const keyStart = i;
    i = stringEnd(line, i);
    if (i < 0) return values;
    let key;
    try { key = JSON.parse(line.slice(keyStart, i)); } catch { return values; }
    while (/\s/.test(line[i] ?? '')) i++;
    if (line[i++] !== ':') return values;
    while (/\s/.test(line[i] ?? '')) i++;
    const valueStart = i;
    if ((key === 'type' || key === 'timestamp') && line[i] === '"') {
      i = stringEnd(line, i);
      if (i < 0) return values;
      try { values[key] = JSON.parse(line.slice(valueStart, i)); } catch { return values; }
    } else i = skipValue(line, i);
    if (i < 0) return values;
    while (/\s/.test(line[i] ?? '')) i++;
    if (line[i] === ',') i++;
    else if (line[i] === '}') break;
    else return values;
    if (values.type && values.timestamp) return values;
  }
  return values;
}

function findRollouts(root, threadIds) {
  const matches = new Map([...threadIds].map(id => [id.toLowerCase(), []]));
  const expected = /^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
  const visit = directory => {
    let entries;
    try { entries = readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) {
        const id = expected.exec(entry.name)?.[1];
        if (id && matches.has(id.toLowerCase())) matches.get(id.toLowerCase()).push(path);
      }
    }
  };
  visit(root);
  return matches;
}

async function inspectRollout(path, threadId, nowMs, staleAfterSeconds) {
  const rootPath = realpathSync(path);
  const stat = statSync(rootPath);
  const cached = cache.get(rootPath);
  if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs)
    return { ...(cached.resultStatus === 'awaiting_post_compaction_usage'
      ? { status: cached.resultStatus, reason: 'waiting for usage after compaction' }
      : freshness(cached.sample, nowMs, staleAfterSeconds)), verified: cached.verified,
      recordTime: cached.recordTime };

  let verified = false;
  let turn = null;
  let window = null;
  let latestUsage = null;
  let lastOrdinal = -1;
  let compactedOrdinal = -1;
  let ordinal = 0;
  let recordTime = 0;
  const input = createReadStream(rootPath, { encoding: 'utf8' });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      ordinal++;
      const fields = topLevelFields(line);
      const rowTime = Date.parse(fields.timestamp ?? '');
      if (Number.isFinite(rowTime)) recordTime = Math.max(recordTime, rowTime);
      if (fields.type === 'compacted') { compactedOrdinal = ordinal; continue; }
      const kind = fields.type;
      if (!['session_meta', 'turn_context', 'event_msg', 'token_usage_record'].includes(kind)) continue;
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      if (row.type === 'session_meta') {
        verified = row.payload?.id === threadId || row.payload?.session_id === threadId;
        if (!verified) break;
      } else if (row.type === 'turn_context') {
        // A new turn supersedes every sample/window from the preceding turn, even if its metadata is malformed.
        latestUsage = null; lastOrdinal = -1; turn = null; window = null;
        if (typeof row.payload?.model !== 'string' || !row.payload.model
          || !row.payload.turn_id || !Number.isFinite(Date.parse(row.timestamp))) {
          turn = null; window = null; continue;
        }
        turn = { id: row.payload?.turn_id, model: row.payload?.model,
          timestamp: row.timestamp };
        window = null;
      } else if (row.type === 'event_msg' && Number.isFinite(row.payload?.info?.model_context_window)) {
        const windowTime = Date.parse(row.timestamp);
        if (!Number.isFinite(windowTime) || windowTime < Date.parse(turn?.timestamp ?? '')) continue;
        window = { tokens: row.payload.info.model_context_window, timestamp: row.timestamp,
          turnId: turn?.id, model: turn?.model, ordinal };
      } else if (row.type === 'token_usage_record') {
        const payload = row.payload ?? {};
        const usage = payload.usage ?? {};
        if (!turn || typeof payload.turn_id !== 'string' || !payload.turn_id
          || typeof payload.thread_id !== 'string' || payload.thread_id !== threadId
          || payload.turn_id !== turn.id) continue;
        const usageTime = Date.parse(row.timestamp);
        if (!Number.isFinite(usage.total_tokens) || usage.total_tokens < 0
          || !Number.isFinite(usageTime) || usageTime < Date.parse(turn?.timestamp ?? '')
          || (Number.isFinite(usage.input_tokens) && usage.input_tokens < 0)
          || (Number.isFinite(usage.output_tokens) && usage.output_tokens < 0)) {
          latestUsage = null; lastOrdinal = ordinal; continue;
        }
        latestUsage = { activeTokens: usage.total_tokens,
          inputTokens: usage.input_tokens, totalTokens: usage.total_tokens,
          outputTokens: usage.output_tokens, model: turn.model, turnId: payload.turn_id,
          timestamp: row.timestamp, ordinal,
          pairedWindow: window?.turnId === payload.turn_id && window.ordinal < ordinal
            && Date.parse(window.timestamp) >= Date.parse(turn.timestamp)
            && Date.parse(window.timestamp) <= usageTime && window.tokens > 0
            ? { tokens: window.tokens, timestamp: window.timestamp } : null };
        lastOrdinal = ordinal;
      }
    }
  } finally {
    lines.close();
    input.destroy();
  }
  if (!recordTime) recordTime = stat.mtimeMs;
  if (!verified) return { status: 'unverified', verified: false, recordTime,
    reason: 'rollout metadata did not match the configured target' };
  const sample = latestUsage?.pairedWindow?.tokens > 0 && compactedOrdinal < lastOrdinal
    ? { activeTokens: latestUsage.activeTokens, totalTokens: latestUsage.totalTokens,
      outputTokens: latestUsage.outputTokens, model: latestUsage.model, turnId: latestUsage.turnId,
      timestamp: latestUsage.timestamp, ordinal: latestUsage.ordinal,
      windowTokens: latestUsage.pairedWindow.tokens, windowTimestamp: latestUsage.pairedWindow.timestamp,
      ratio: Math.min(latestUsage.activeTokens, latestUsage.pairedWindow.tokens)
        / latestUsage.pairedWindow.tokens, source: 'rollout_last_usage',
      completionDelaySeconds: Math.max(0, (nowMs - Date.parse(latestUsage.timestamp)) / 1000) }
    : null;
  const result = compactedOrdinal >= 0 && compactedOrdinal >= lastOrdinal
    ? { status: 'awaiting_post_compaction_usage', reason: 'waiting for usage after compaction' }
    : freshness(sample, nowMs, staleAfterSeconds);
  cache.set(rootPath, { size: stat.size, mtimeMs: stat.mtimeMs, sample, resultStatus: result.status,
    verified: true, recordTime });
  if (compactedOrdinal >= 0 && compactedOrdinal >= lastOrdinal) {
    return { ...result, verified: true, recordTime };
  }
  return { ...result, verified: true, recordTime };
}

function freshness(sample, nowMs, staleAfterSeconds) {
  if (!sample) return { status: 'unavailable', reason: 'no same-turn usage and context-window pair' };
  const delay = Math.max(0, (nowMs - Date.parse(sample.timestamp)) / 1000);
  return { status: delay > staleAfterSeconds ? 'stale' : 'available', stale: delay > staleAfterSeconds,
    ...sample, completionDelaySeconds: delay };
}

/** Read only the explicitly configured target rollouts. No transcript text is returned or cached. */
export async function observeRolloutUsage({ sessionsRoot, targets, nowMs = Date.now(), staleAfterSeconds = 120 }) {
  const root = realpathSync(resolve(sessionsRoot));
  const result = {};
  const enabled = Object.entries(targets ?? {}).filter(([threadId, target]) =>
    target?.enabled !== false && UUID.test(threadId));
  const pathsByThread = findRollouts(root, new Set(enabled.map(([threadId]) => threadId)));
  for (const [threadId] of enabled) {
    const paths = pathsByThread.get(threadId.toLowerCase()) ?? [];
    if (!paths.length) {
      result[threadId] = { status: 'not_found', reason: 'no rollout filename matched the configured target' };
      continue;
    }
    const candidates = [];
    for (const candidate of paths) {
      try {
        const resolved = realpathSync(candidate);
        if (!resolved.startsWith(root + sep)) continue;
        candidates.push({ ...await inspectRollout(resolved, threadId, nowMs, staleAfterSeconds), path: resolved });
      } catch {
        // A rollout may disappear or become unreadable after enumeration; keep the target isolated.
      }
    }
    if (!candidates.length) {
      result[threadId] = { status: 'unavailable', reason: 'matched rollout files were no longer readable or failed path validation' };
      continue;
    }
    const verified = candidates.filter(x => x.verified);
    const pool = verified.length ? verified : candidates;
    const selected = pool.sort((a, b) => a.recordTime - b.recordTime || a.path.localeCompare(b.path)).at(-1);
    const { verified: _verified, recordTime: _recordTime, path: _path, ...publicResult } = selected;
    result[threadId] = publicResult;
  }
  return result;
}
