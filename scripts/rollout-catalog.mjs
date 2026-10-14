import { open, realpath, readdir, lstat, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const ROLLOUT_NAME = new RegExp(`-${UUID}\\.jsonl$`, 'i');
const MAX_CANDIDATES = 200;
const MAX_METADATA_BYTES = 256 * 1024;

function isWithin(root, path) {
  const rel = relative(root, path);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function timestampSeconds(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value > 1e12 ? value / 1000 : value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed / 1000;
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric > 1e12 ? numeric / 1000 : numeric;
  }
  return null;
}

async function firstLineJson(path) {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(MAX_METADATA_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const newline = buffer.indexOf(0x0a, 0);
    if (newline < 0 && bytesRead === buffer.length) return null;
    const length = newline < 0 ? bytesRead : newline;
    if (length <= 0 || length >= MAX_METADATA_BYTES) return null;
    return JSON.parse(buffer.toString('utf8', 0, length).replace(/\r$/, ''));
  } finally {
    await handle.close();
  }
}

function hasSubagentThreadSource(value) {
  if (typeof value === 'string') return ['subagent', 'sub_agent', 'sub-agent'].includes(value.toLowerCase());
  if (!value || typeof value !== 'object') return false;
  if (['subAgent', 'subagent', 'sub_agent', 'thread_spawn'].some(key => Object.hasOwn(value, key))) return true;
  const markers = [value.type, value.kind, value.source, value.role]
    .filter(marker => typeof marker === 'string').map(marker => marker.toLowerCase());
  return markers.some(marker => ['subagent', 'sub_agent', 'sub-agent', 'agent'].includes(marker))
    || ['agent_id', 'agentId', 'parent_thread_id', 'parentThreadId']
      .some(key => value[key] !== undefined && value[key] !== null && value[key] !== '');
}

function isPrimaryDesktopSession(payload, expectedAccountId) {
  if (payload?.originator !== 'Codex Desktop') return false;
  const source = typeof payload.source === 'string' ? payload.source.toLowerCase() : '';
  if (!['vscode', 'desktop', 'codex_desktop', 'codex-desktop'].includes(source)) return false;
  if (['agent_id', 'agentId', 'agent_role', 'agentRole', 'parent_thread_id', 'parentThreadId']
    .some(key => payload[key] !== undefined && payload[key] !== null && payload[key] !== '')) return false;
  if (['subagent', 'sub_agent', 'sub-agent'].includes(source)) return false;
  if (hasSubagentThreadSource(payload.thread_source)) return false;
  if (expectedAccountId !== undefined && payload.creator_account_id !== undefined
    && payload.creator_account_id !== expectedAccountId) return false;
  return typeof payload.id === 'string' && new RegExp(`^${UUID}$`, 'i').test(payload.id);
}

/**
 * Finds recent primary Codex Desktop chats using only rollout session metadata.
 * It parses only session_meta from the first 256 KiB of each of the 200 newest candidate files.
 */
export async function discoverRolloutCatalog({ sessionsRoot, monitoringSince, expectedAccountId }) {
  if (typeof sessionsRoot !== 'string' || !isAbsolute(sessionsRoot)) {
    throw new TypeError('sessionsRoot must be an explicit absolute path');
  }
  if (!Number.isFinite(monitoringSince)) throw new TypeError('monitoringSince must be a finite epoch timestamp');

  let root;
  try { root = await realpath(sessionsRoot); } catch { return []; }
  let rootStat;
  try { rootStat = await stat(root); } catch { return []; }
  if (!rootStat.isDirectory()) return [];

  const files = [];
  const directories = [root];
  while (directories.length) {
    const directory = directories.pop();
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const path = resolve(directory, entry.name);
      if (!isWithin(root, path)) continue;
      if (entry.isDirectory()) {
        directories.push(path);
        continue;
      }
      if (!entry.isFile() || !/\.jsonl$/i.test(entry.name) || !ROLLOUT_NAME.test(entry.name)) continue;
      try {
        const resolvedPath = await realpath(path);
        if (!isWithin(root, resolvedPath)) continue;
        const info = await lstat(path);
        if (!info.isFile() || info.isSymbolicLink()) continue;
        files.push({ path: resolvedPath, mtimeSeconds: info.mtimeMs / 1000 });
      } catch { /* A rollout may disappear between listing and metadata read. */ }
    }
  }

  files.sort((a, b) => b.mtimeSeconds - a.mtimeSeconds || a.path.localeCompare(b.path));
  const found = new Map();
  for (const file of files.slice(0, MAX_CANDIDATES)) {
    try {
      const row = await firstLineJson(file.path);
      if (row?.type !== 'session_meta' || !isPrimaryDesktopSession(row.payload, expectedAccountId)) continue;
      const match = file.path.match(ROLLOUT_NAME);
      const filenameId = match?.[0]?.slice(1, -'.jsonl'.length);
      if (!filenameId || filenameId.toLowerCase() !== row.payload.id.toLowerCase()) continue;
      const timestamp = timestampSeconds(row.payload.timestamp);
      if ((timestamp === null || timestamp < monitoringSince) && file.mtimeSeconds < monitoringSince) continue;
      if (found.has(row.payload.id)) continue;
      found.set(row.payload.id, { id: row.payload.id, kind: 'codex', hostId: 'local',
        title: row.payload.id, source: 'local_rollout_metadata' });
    } catch { /* Malformed, truncated, or concurrently removed metadata is ignored. */ }
  }
  return [...found.values()];
}

// Name retained for the Desktop adapter; return value matches list_threads.thread[].
export function discoverRolloutThreads(options) {
  return discoverRolloutCatalog(options);
}
