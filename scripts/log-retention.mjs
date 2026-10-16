import { lstatSync, realpathSync, readdirSync, unlinkSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';

export const LOG_RETENTION = { maxAgeMs: 7 * 86400_000, stateBytes: 32 * 1024 * 1024, eventBytes: 8 * 1024 * 1024 };

// Only regular files immediately inside the explicit plugin log directory qualify.
export function pruneLogs(directory, pattern, { keep = [], maxBytes, now = Date.now(), maxAgeMs = LOG_RETENTION.maxAgeMs } = {}) {
  const root = resolve(directory);
  try {
    if (lstatSync(root).isSymbolicLink() || realpathSync(root).toLowerCase() !== root.toLowerCase()) return [];
  } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const files = readdirSync(root).filter(name => pattern.test(name)).flatMap(name => {
    const path = resolve(root, name);
    if (dirname(path) !== root || basename(path) !== name) return [];
    const info = lstatSync(path);
    return info.isFile() && !info.isSymbolicLink() ? [{ path, name, size: info.size, mtimeMs: info.mtimeMs }] : [];
  }).sort((a, b) => a.mtimeMs - b.mtimeMs || a.name.localeCompare(b.name));
  let total = files.reduce((sum, file) => sum + file.size, 0);
  const removed = [];
  for (const file of files) {
    if (keep.includes(file.name) || (now - file.mtimeMs <= maxAgeMs && total <= maxBytes)) continue;
    // Recheck immediately before unlinking; never follow links or recurse.
    const info = lstatSync(file.path);
    if (!info.isFile() || info.isSymbolicLink()) continue;
    unlinkSync(file.path);
    total -= file.size;
    removed.push(file.name);
  }
  return removed;
}
