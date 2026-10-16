import { mkdirSync, appendFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pruneLogs, LOG_RETENTION } from './log-retention.mjs';

export function createEventLogger(dataDir, { clock = Date.now, autoCleanup = false } = {}) {
  const directory = resolve(dataDir, 'event-logs');
  const pattern = /^\d{13}-[a-f0-9-]{36}\.jsonl$/;
  const repeated = new Map();
  let name, bytes = 0, lastCleanup = -Infinity;
  const cleanup = (force = false) => {
    const now = clock();
    if (!autoCleanup || (!force && now - lastCleanup < 3600_000)) return;
    try {
      const newest = readdirSync(directory).filter(file => pattern.test(file)).sort().slice(-2);
      pruneLogs(directory, pattern, { keep: [...newest, name], maxBytes: LOG_RETENTION.eventBytes, now });
      lastCleanup = now;
    } catch { /* Diagnostic cleanup must not interrupt queue persistence. */ }
  };
  const log = (event, details = {}) => {
    cleanup();
    const now = clock();
    const signature = JSON.stringify([event, details]);
    const prior = repeated.get(signature);
    const noisy = ['poll_error', 'connection_state_persist_error', 'launch_error', 'log_cleanup_error'].includes(event);
    if (noisy && prior && now - prior.time < 300_000) { prior.suppressed++; return; }
    const entry = { time: new Date(now).toISOString(), event, ...details,
      ...(noisy && prior?.suppressed ? { suppressedRepeats: prior.suppressed } : {}) };
    const line = JSON.stringify(entry) + '\n';
    mkdirSync(directory, { recursive: true });
    const rollover = !name || bytes + Buffer.byteLength(line) > 1024 * 1024;
    if (rollover) {
      name = `${now}-${randomUUID()}.jsonl`;
      bytes = 0;
    }
    appendFileSync(resolve(directory, name), line);
    bytes += Buffer.byteLength(line);
    if (noisy) {
      repeated.set(signature, { time: now, suppressed: 0 });
      if (repeated.size > 128) repeated.delete(repeated.keys().next().value);
    }
    if (rollover) cleanup(true);
  };
  log.cleanup = () => cleanup();
  return log;
}
