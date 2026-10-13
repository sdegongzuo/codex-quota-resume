import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, appendFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { append, records, configuration, migrateState, taskId, shouldLaunchWatcher } from '../scripts/store.mjs';

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

test('新配置默认开启，关闭的全局和目标设置不会被hook登记覆盖', () => {
  const dir = resolve(dirname(fileURLToPath(import.meta.url)), '../.test-evidence', randomUUID());
  mkdirSync(dir, { recursive: true });
  const path = resolve(dir, 'config.jsonl');
  assert.equal(configuration(path).enabled, true);
  append(path, { type: 'global', enabled: false });
  append(path, { type: 'target', threadId: 'chat', value: { enabled: false, armedAt: 12 } });
  append(path, { type: 'register', threadId: 'chat', pipe: 'new-pipe', hostId: 'new-host', armedAt: 99 });
  const config = configuration(path);
  assert.equal(config.enabled, false);
  assert.equal(config.targets.chat.enabled, false);
  assert.equal(config.targets.chat.armedAt, 12);
  assert.equal(config.pipe, 'new-pipe');
  assert.equal(config.hostId, 'new-host');
  assert.equal(shouldLaunchWatcher(true, config.enabled), false);
  assert.equal(shouldLaunchWatcher(true, true), true);
  assert.equal(shouldLaunchWatcher(false, false), true);
});

for (const phase of ['sending', 'uncertain']) {
  test(`旧格式 ${phase} 项迁移后继续占用防重发送槽位`, () => {
    const raw = { pending: { chat: { threadId: 'chat', accountId: 'account-a', hostId: 'host-a',
      turnId: 'turn-a', phase, resetAt: 200 } }, handled: ['legacy-turn'] };
    const { state, changed } = migrateState(raw, { resumeBufferSeconds: 120 });
    const id = taskId('account-a', 'host-a', 'chat', 'turn-a');
    assert.match(id, /^[a-f0-9]{64}$/);
    assert.equal(changed, true);
    assert.equal(Object.hasOwn(state.pending, 'chat'), false);
    assert.equal(state.pending[id].phase, phase);
    assert.equal(state.pending[id].eligibleAt, 320);
    assert.equal(state.activeAutoResume, id);
    assert.deepEqual(state.handled, ['legacy-turn']);
  });
}

test('带旧明文任务ID的日志迁移为不可逆摘要并保留旧单项关闭设置', () => {
  const legacyId = JSON.stringify(['account-private', 'host-private', 'chat-private', 'turn-private']);
  const raw = { pending: { [legacyId]: { id: legacyId, threadId: 'chat-private',
    accountId: 'account-private', hostId: 'host-private', turnId: 'turn-private', phase: 'waiting' } }, handled: [] };
  const { state, changed } = migrateState(raw, { items: { [legacyId]: { enabled: false } } });
  const id = taskId('account-private', 'host-private', 'chat-private', 'turn-private');
  assert.equal(changed, true);
  assert.equal(state.pending[id].id, id);
  assert.equal(state.pending[id].autoResumeEnabled, false);
  assert.equal(state.pending[id].legacyId, legacyId);
  assert.ok(!id.includes('account-private'));
});
