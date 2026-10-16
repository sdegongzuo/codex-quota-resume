import { mkdirSync, readdirSync, readFileSync, openSync, writeSync, fsyncSync, closeSync, statSync } from 'node:fs';
import { latestRecord } from './store.mjs';
import { deflateSync, inflateSync } from 'node:zlib';
import { pruneLogs, LOG_RETENTION } from './log-retention.mjs';

const segmentLimit = 4 * 1024 * 1024;
const journalDirectory = path => `${path}.journal`;
const clone = value => JSON.parse(JSON.stringify(value));
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function encode(entry) {
  const plain = JSON.stringify(entry);
  if (Buffer.byteLength(plain) < 512) return plain + '\n';
  const packed = JSON.stringify({ type: 'deflate', data: deflateSync(Buffer.from(plain)).toString('base64') });
  return (Buffer.byteLength(packed) < Buffer.byteLength(plain) ? packed : plain) + '\n';
}

function segments(path) {
  try { return readdirSync(journalDirectory(path)).filter(name => /^\d{12}\.jsonl$/.test(name)).sort(); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

function changes(before, after, path = [], result = []) {
  if (JSON.stringify(before) === JSON.stringify(after)) return result;
  if (object(before) && object(after)) {
    for (const key of Object.keys(before)) {
      if (!Object.hasOwn(after, key)) result.push({ path: [...path, key], remove: true });
    }
    for (const key of Object.keys(after)) changes(before[key], after[key], [...path, key], result);
  } else result.push({ path, value: after });
  return result;
}

function replay(path, name) {
  const lines = readFileSync(`${journalDirectory(path)}/${name}`, 'utf8').split('\n');
  let state;
  for (let index = 0; index < lines.length; index++) {
    if (!lines[index].trim()) continue;
    let entry;
    try { entry = JSON.parse(lines[index]); }
    catch (error) {
      // An interrupted append can leave only its final line incomplete.
      if (index === lines.length - 1) break;
      throw error;
    }
    if (entry.type === 'deflate') entry = JSON.parse(inflateSync(Buffer.from(entry.data, 'base64')).toString('utf8'));
    if (entry.type === 'checkpoint') state = entry.state;
    else if (entry.type === 'patch' && state !== undefined) {
      for (const change of entry.changes) {
        if (!change.path.length) { state = change.value; continue; }
        let parent = state;
        for (const key of change.path.slice(0, -1)) parent = parent[key];
        const key = change.path.at(-1);
        if (change.remove) delete parent[key];
        else Object.defineProperty(parent, key, { value: change.value, enumerable: true, writable: true, configurable: true });
      }
    } else throw new Error('Invalid state journal record');
  }
  return state;
}

export function readState(path) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const names = segments(path);
      for (let index = names.length - 1; index >= 0; index--) {
        const state = replay(path, names[index]);
        if (state !== undefined) return state;
      }
      return latestRecord(path);
    } catch (error) {
      if (error.code !== 'ENOENT' || attempt === 2) throw error;
      // Retention may remove a segment after this reader enumerated it.
    }
  }
}

// One watcher owns writes under control.mjs's existing per-directory lock.
// Each segment starts with a checkpoint; retention always protects two recoverable segments.
export function createStateWriter(path, { maxSegmentBytes = segmentLimit, autoCleanup = false, onCleanupError = () => {} } = {}) {
  let previous = readState(path);
  let name = segments(path).at(-1);
  // Start a fresh segment after restart, avoiding appends after a torn final line.
  let fresh = true;
  let lastCleanup = -Infinity;
  return state => {
    const next = clone(state);
    // These rollout parsing details are redundant for the panel and queue recovery.
    // Delay is calculated from timestamp on read, rather than persisted every poll.
    for (const sample of Object.values(next.contextUsageByTarget ?? {})) {
      for (const key of ['completionDelaySeconds', 'totalTokens', 'outputTokens', 'ordinal', 'windowTimestamp', 'source']) delete sample[key];
    }
    const patch = changes(previous, next);
    if (!fresh && !patch.length) return;
    const line = encode({ type: 'patch', changes: patch });
    const directory = journalDirectory(path);
    mkdirSync(directory, { recursive: true });
    const rollover = fresh || !name || statSync(`${directory}/${name}`).size + Buffer.byteLength(line) > maxSegmentBytes;
    let data = line;
    if (rollover) {
      const sequence = Number(segments(path).at(-1)?.slice(0, 12) ?? 0) + 1;
      name = `${String(sequence).padStart(12, '0')}.jsonl`;
      data = encode({ type: 'checkpoint', state: next });
    }
    let fd;
    try {
      fd = openSync(`${directory}/${name}`, rollover ? 'wx' : 'a');
      const bytes = Buffer.from(data);
      let written = 0;
      while (written < bytes.length) written += writeSync(fd, bytes, written, bytes.length - written);
      fsyncSync(fd);
    } catch (error) { fresh = true; throw error; }
    finally { if (fd !== undefined) closeSync(fd); }
    previous = next;
    fresh = false;
    if (autoCleanup && (rollover || Date.now() - lastCleanup >= 3600_000)) {
      try {
        const names = segments(path);
        const recoverable = [];
        for (let index = names.length - 1; index >= 0 && recoverable.length < 2; index--) {
          if (replay(path, names[index]) !== undefined) recoverable.push(names[index]);
        }
        if (recoverable.length === 2) {
          const keep = names.filter(candidate => candidate >= recoverable[1]);
          pruneLogs(directory, /^\d{12}\.jsonl$/, { keep, maxBytes: LOG_RETENTION.stateBytes });
        }
        lastCleanup = Date.now();
      } catch (error) { onCleanupError(error); }
    }
  };
}
