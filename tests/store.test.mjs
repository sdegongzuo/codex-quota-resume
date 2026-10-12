import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, appendFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { append, records, configuration } from '../scripts/store.mjs';

test('多个聊天登记均保留，部分损坏记录不覆盖有效状态', () => {
  const dir = resolve(dirname(fileURLToPath(import.meta.url)), '../.test-evidence', randomUUID());
  mkdirSync(dir, { recursive: true });
  const path = resolve(dir, 'config.jsonl');
  append(path, { type: 'enable', threadId: 'a', pipe: 'pipe-a', armedAt: 1 });
  appendFileSync(path, '{"type":');
  append(path, { type: 'enable', threadId: 'b', pipe: 'pipe-b', armedAt: 2 });
  const config = configuration(path);
  assert.deepEqual(Object.keys(config.targets), ['a', 'b']);
  assert.equal(config.pipe, 'pipe-b');
  assert.equal(records(path).length, 2);
  append(path, { type: 'disable' });
  assert.equal(configuration(path).enabled, false);
});
