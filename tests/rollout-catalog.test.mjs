import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, utimesSync, symlinkSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { discoverRolloutCatalog } from '../scripts/rollout-catalog.mjs';

const evidenceRoot = resolve('.test-evidence', `rollout-catalog-${randomUUID()}`);
let fixtureNumber = 0;
function writeMeta(root, meta, { mtime = 1_800_000_000, body = '' } = {}) {
  const id = meta.id ?? randomUUID();
  const actual = { id, originator: 'Codex Desktop', source: 'vscode', timestamp: 1_800_000_000, ...meta };
  const dir = resolve(root, `fixture-${++fixtureNumber}`);
  mkdirSync(dir, { recursive: true });
  const path = resolve(dir, `rollout-2026-10-14-${id}.jsonl`);
  writeFileSync(path, `${JSON.stringify({ type: 'session_meta', payload: actual })}\n${body}`);
  utimesSync(path, mtime, mtime);
  return { id: actual.id, path };
}

test('fallback仅返回符合条件的本机主桌面Codex session_meta，且只读首行', async () => {
  const root = resolve(evidenceRoot, 'valid');
  const entry = writeMeta(root, {} , { body: `${JSON.stringify({ type: 'event_msg', message: 'PRIVATE TRANSCRIPT' })}\n` });
  const result = await discoverRolloutCatalog({ sessionsRoot: root, monitoringSince: 1_799_999_900 });
  assert.deepEqual(result, [{ id: entry.id, kind: 'codex', hostId: 'local', title: entry.id,
    source: 'local_rollout_metadata' }]);
  assert.equal(JSON.stringify(result).includes('PRIVATE TRANSCRIPT'), false);
});

test('拒绝非桌面、代理、父子线程、UUID不匹配以及baseline之前的元数据', async () => {
  const root = resolve(evidenceRoot, 'reject');
  const baseline = 1_800_000_000;
  const cases = [
    { originator: 'Codex CLI' },
    { source: 'subAgent' },
    { agent_id: 'agent-1' },
    { parent_thread_id: randomUUID() },
  ];
  for (const meta of cases) writeMeta(root, meta, { mtime: baseline - 10 });
  const old = writeMeta(root, { timestamp: baseline - 10 }, { mtime: baseline - 10 });
  const fresh = writeMeta(root, {}, { mtime: baseline - 10 });
  const freshByMtime = writeMeta(root, { timestamp: null }, { mtime: baseline - 10 });
  // A recent file timestamp is sufficient even when session_meta timestamp is older.
  utimesSync(fresh.path, baseline + 1, baseline + 1);
  utimesSync(freshByMtime.path, baseline + 2, baseline + 2);
  const result = await discoverRolloutCatalog({ sessionsRoot: root, monitoringSince: baseline });
  assert.deepEqual(result.map(item => item.id), [freshByMtime.id, fresh.id]);
  assert.notEqual(result[0].id, old.id);
});

test('只接受文件名末尾UUID与session_meta.id完全匹配的rollout', async () => {
  const root = resolve(evidenceRoot, 'filename-mismatch');
  const dir = resolve(root, 'case');
  mkdirSync(dir, { recursive: true });
  const filenameId = randomUUID();
  const wrongId = randomUUID();
  const path = resolve(dir, `rollout-2026-10-14-${filenameId}.jsonl`);
  writeFileSync(path, `${JSON.stringify({ type: 'session_meta', payload: {
    id: wrongId, originator: 'Codex Desktop', source: 'vscode', timestamp: 1_800_000_000,
  } })}\n`);
  const result = await discoverRolloutCatalog({ sessionsRoot: root, monitoringSince: 1_799_999_900 });
  assert.deepEqual(result, []);
});

test('递归扫描跳过符号链接，最多检查最近200个metadata文件', async () => {
  const root = resolve(evidenceRoot, 'bounded');
  const baseline = 1_800_000_000;
  const entries = [];
  for (let i = 0; i < 201; i++) {
    entries.push(writeMeta(root, { timestamp: baseline }, { mtime: baseline + i }));
  }
  const outside = writeMeta(resolve(evidenceRoot, 'outside'), { timestamp: baseline }, { mtime: baseline + 10_000 });
  try { symlinkSync(dirname(outside.path), resolve(root, 'linked'), 'dir'); } catch { /* OS policy may forbid symlink creation. */ }
  const result = await discoverRolloutCatalog({ sessionsRoot: root, monitoringSince: baseline });
  assert.equal(result.length, 200);
  assert.equal(result.some(item => item.id === entries[0].id), false);
  assert.equal(result.some(item => item.id === outside.id), false);
});

test('expectedAccountId过滤不匹配账号，thread_source子代理结构被拒绝且不泄漏metadata字段', async () => {
  const root = resolve(evidenceRoot, 'account-filter');
  const accountId = randomUUID();
  const matching = writeMeta(root, { creator_account_id: accountId,
    session_id: randomUUID(), thread_source: 'main', base_instructions: 'PRIVATE HEADER' });
  writeMeta(root, { creator_account_id: randomUUID() });
  writeMeta(root, { thread_source: { type: 'subagent', parent_thread_id: randomUUID() } });
  writeMeta(root, { thread_source: { subAgent: { thread_spawn: randomUUID() } } });
  const result = await discoverRolloutCatalog({ sessionsRoot: root, monitoringSince: 1_799_999_900,
    expectedAccountId: accountId });
  assert.deepEqual(result, [{ id: matching.id, kind: 'codex', hostId: 'local', title: matching.id,
    source: 'local_rollout_metadata' }]);
  assert.equal(JSON.stringify(result).includes(accountId), false);
  assert.equal(JSON.stringify(result).includes('PRIVATE HEADER'), false);
});
