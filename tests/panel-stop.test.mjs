import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
import { startPanel } from '../scripts/panel.mjs';
import { append, configuration, taskId } from '../scripts/store.mjs';

test('panel stop binds running turn and persists disabled choices before operation', async () => {
  const directory = resolve('.acceptance-data', `panel-stop-${randomUUID()}`);
  mkdirSync(directory, { recursive: true });
  const configPath = join(directory, 'config.jsonl'), statePath = join(directory, 'state.jsonl');
  const item = { accountId: 'synthetic', hostId: 'local', threadId: 'synthetic-target', turnId: 'failed-turn',
    runningTurnId: 'running-turn', phase: 'running' };
  const id = taskId(item.accountId, item.hostId, item.threadId, item.turnId);
  append(configPath, { type: 'target', threadId: item.threadId, value: { enabled: true } });
  append(statePath, { pending: { [id]: { ...item, id } } });
  let calls = 0;
  const panel = startPanel({ configPath, statePath, capabilities: {}, onStop: async operation => {
    calls++;
    const config = configuration(configPath);
    assert.equal(config.items[id].enabled, false);
    assert.equal(config.targets[item.threadId].enabled, false);
    assert.equal(operation.turnId, item.runningTurnId);
    return { status: 'uncertain' };
  } });
  await new Promise(resolvePromise => panel.server.once('listening', resolvePromise));
  const url = new URL(panel.getUrl());
  const send = turnId => fetch(`${url.origin}/api/stop`, { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-quota-resume-token': panel.token },
    body: JSON.stringify({ id, turnId }) });
  try {
    const page = await (await fetch(panel.getUrl())).text();
    assert.match(page, /停止任务并关闭自动续跑/);
    assert.match(page, /runningTurnId/);
    assert.equal((await send('old-turn')).status, 409);
    assert.equal(calls, 0);
    const response = await send(item.runningTurnId);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).operation.status, 'uncertain');
    assert.equal(calls, 1);
  } finally { await new Promise(resolvePromise => panel.server.close(resolvePromise)); }
});
