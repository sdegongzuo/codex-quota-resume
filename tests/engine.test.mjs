import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { Script } from 'node:vm';
import { projectQueue, startPanel } from '../scripts/panel.mjs';
import { append, records, configuration, taskId } from '../scripts/store.mjs';
const { tick, quotaFailure, exhaustedUntil } = await import(
  process.env.ENGINE_UNDER_TEST ?? '../scripts/engine.mjs');

const failure = () => ({ thread: { kind: 'codex', status: { type: 'idle' } },
  turns: [{ id: 'failed-turn', status: 'failed', completedAt: 110,
    error: { codexErrorInfo: 'usageLimitExceeded' } }] });
const quota = (allowed = false, percent = 100) => ({ ordinaryUsageAllowed: allowed, accountId: 'account-a',
  rateLimits: { primary: { usedPercent: percent, windowDurationMins: 300, resetsAt: 200 } } });
function harness() {
  const h = { usage: quota(), snapshot: failure(), sends: [], writes: [],
    acknowledgements: [],
    config: { enabled: true, targets: { chat: { enabled: true, armedAt: 100 } } },
    state: { pending: {}, handled: [] }, visible: true, still: true };
  h.desktop = { call: async (name, args) => {
    if (name === 'list_threads') return { threads: h.visible ? [{ id: 'chat', kind: 'codex' }] : [] };
    if (name === 'get_usage_limits') return h.usage;
    if (name === 'read_thread') return h.snapshot;
    if (name === 'send_message_to_thread') {
      assert.equal(Object.values(h.state.pending).find(item => item.threadId === 'chat')?.phase, 'sending', '必须先持久化发送占位');
      assert.equal(Object.values(h.writes.at(-1).pending).find(item => item.threadId === 'chat')?.phase, 'sending');
      h.sends.push(args);
      if (h.failSend) throw new Error('模拟发送超时');
      return { accepted: true };
    }
    throw new Error(`未预期工具: ${name}`);
  } };
  h.run = now => tick({ ...h, now, persist: async () => h.writes.push(structuredClone(h.state)),
    log: async () => {}, stillEnabled: () => h.still,
    acknowledgeManualResolution: async (id, requestedAt) => h.acknowledgements.push({ id, requestedAt }) });
  return h;
}

test('tick将白名单原会话的单次input/window观测接入对应压缩状态且无adapter时保持不支持', async () => {
  const threadId = '55555555-5555-4555-8555-555555555555';
  const state = { pending: {} };
  const config = { enabled: true, hostId: 'local', targets: { [threadId]: { enabled: true } }, items: {} };
  const desktop = {
    capabilities: async () => ({ activeContextUsage: 'available' }),
    contextUsage: async targets => {
      assert.deepEqual(Object.keys(targets), [threadId]);
      return { [threadId]: { status: 'available', activeTokens: 650, windowTokens: 1000,
        timestamp: '2026-10-13T01:00:00.000Z', model: 'test-model', turnId: 'target-turn', stale: false } };
    },
    call: async name => name === 'get_usage_limits'
      ? { ordinaryUsageAllowed: true, accountId: 'account-a' }
      : name === 'list_threads' ? { threads: [], pinnedThreads: [] }
        : (() => { throw new Error(`unexpected ${name}`); })(),
  };
  await tick({ desktop, config, state, now: 1_792_000_000,
    persist: async () => {}, log: async () => {} });
  assert.equal(state.contextUsageByTarget[threadId].activeTokens, 650);
  assert.equal(state.compactionByTarget[threadId].lastRatio, 0.65);
  assert.equal(state.compactionByTarget[threadId].status, 'unsupported');
});
const queued = h => Object.values(h.state.pending).find(item => item.threadId === 'chat');

test('desktop quota error without codexErrorInfo is collected only with exhausted five-hour evidence', async () => {
  const h = harness();
  h.snapshot.thread.status.type = 'systemError';
  h.snapshot.turns[0].error = { message: 'You’ve hit your usage limit. Try again later.', additionalDetails: null };
  await h.run(150);
  assert.equal(queued(h)?.phase, 'waiting');
  assert.equal(h.sends.length, 0);
  const weeklyOnly = harness();
  weeklyOnly.snapshot = structuredClone(h.snapshot);
  weeklyOnly.usage = quota(false, 10);
  weeklyOnly.usage.rateLimits.secondary = { windowDurationMins: 10080, usedPercent: 100, resetsAt: 999 };
  await weeklyOnly.run(150);
  assert.equal(Object.keys(weeklyOnly.state.pending).length, 0);
});

test('known non-quota error code and quoted error text do not become quota interruptions', () => {
  for (const error of [{ codexErrorInfo: 'internalServerError', message: 'You’ve hit your usage limit.' },
    { message: 'Upstream quoted: You’ve hit your usage limit.' }, { message: 'Network connection lost' }]) {
    const snapshot = failure();
    snapshot.turns[0].error = error;
    assert.equal(quotaFailure(snapshot, 100, quota()), null);
  }
});

test('message-only quota errors preserve closed target and closed item choices', async () => {
  const closedTarget = harness();
  closedTarget.snapshot.turns[0].error = { codexErrorInfo: null, message: "You've hit your usage limit." };
  closedTarget.config.targets.chat.enabled = false;
  await closedTarget.run(150);
  assert.equal(Object.keys(closedTarget.state.pending).length, 0);
  assert.equal(closedTarget.sends.length, 0);
  const closedItem = harness();
  closedItem.snapshot.turns[0].error = { message: 'You’ve hit your usage limit.' };
  await closedItem.run(150);
  const item = queued(closedItem);
  closedItem.config.items = { [item.id]: { enabled: false } };
  closedItem.usage = quota(true, 0);
  await closedItem.run(350);
  assert.equal(closedItem.sends.length, 0);
  assert.equal(item.autoResumeEnabled, false);
});

test('手动继续队列中的会话时阻挡自动发送并保留等待项', async () => {
  const h = harness();
  await h.run(150);
  h.snapshot.thread.status.type = 'busy';
  h.snapshot.turns[0].id = 'manual-turn';
  h.snapshot.turns[0].status = 'inProgress';
  h.usage = quota(true, 0);
  await h.run(320);
  assert.equal(h.sends.length, 0);
  assert.equal(queued(h).phase, 'manual_running');
  h.snapshot.turns[0].status = 'completed';
  await h.run(350);
  assert.equal(queued(h).phase, 'manual_running', '忙碌状态不能被旧的终止轮次释放');
  h.snapshot.thread.status.type = 'idle';
  await h.run(360);
  assert.equal(queued(h).phase, 'turn_completed');
});

test('当前原生 activeFlags 的用户等待状态保留自动续跑的串行槽位', async () => {
  for (const flag of ['waitingOnApproval', 'waitingOnUserInput']) {
    const h = harness();
    await h.run(150);
    const entry = queued(h);
    entry.phase = 'running';
    h.state.activeAutoResume = entry.id;
    h.snapshot.thread.status = { type: 'active', activeFlags: [flag] };
    h.snapshot.turns[0] = { id: 'accepted-turn', status: 'inProgress' };
    h.usage = quota(true, 0);
    await h.run(350);
    assert.equal(entry.phase, 'needs_user');
    assert.equal(h.state.activeAutoResume, entry.id);
    assert.equal(h.sends.length, 0);
    h.snapshot.thread.status = { type: flag };
    h.snapshot.turns[0].status = 'completed';
    await h.run(355);
    assert.equal(entry.phase, 'needs_user');
    assert.equal(h.state.activeAutoResume, entry.id);
    h.snapshot.thread.status = { type: 'idle' };
    h.snapshot.turns[0].status = 'completed';
    await h.run(360);
    assert.equal(entry.phase, 'turn_completed');
    assert.equal(h.state.activeAutoResume, null);
  }
});

test('队列按账号、宿主和原会话合并；只显示最新项但保留历史次数和最新项开关', () => {
  const pending = {
    latest: { id: taskId('account-a', 'host-a', 'chat', 'turn-latest'), turnId: 'turn-latest',
      threadId: 'chat', accountId: 'account-a', hostId: 'host-a', interruptedAt: 200,
      eligibleAt: 400, phase: 'waiting', autoResumeEnabled: true },
    old: { id: taskId('account-a', 'host-a', 'chat', 'turn-old'), turnId: 'turn-old',
      threadId: 'chat', accountId: 'account-a', hostId: 'host-a', interruptedAt: 100,
      eligibleAt: 300, phase: 'superseded', autoResumeEnabled: true },
    otherHost: { id: 'otherHost', threadId: 'chat', accountId: 'account-a', hostId: 'host-b',
      interruptedAt: 150, eligibleAt: 350, phase: 'waiting' },
  };
  const latestId = taskId('account-a', 'host-a', 'chat', 'turn-latest');
  const config = { items: { [latestId]: { enabled: false } }, targets: { chat: { enabled: true } } };
  const items = projectQueue(pending, config);
  assert.equal(items.length, 2);
  const latest = items.find(item => item.id === latestId);
  assert.equal(latest.historyCount, 2);
  assert.equal(latest.interruptedAt, 200);
  assert.equal(latest.itemEnabled, false);
  assert.equal(latest.isLatest, true);
  assert.match(latest.id, /^[a-f0-9]{64}$/);
  assert.ok(!latest.id.includes('account-a'));
});

test('较新的历史中断不会遮盖仍占发送槽位的未知结果卡片', () => {
  const pending = {
    latest: { id: taskId('account-a', 'host-a', 'chat', 'turn-latest'), turnId: 'turn-latest',
      threadId: 'chat', accountId: 'account-a', hostId: 'host-a', interruptedAt: 300,
      eligibleAt: 400, phase: 'waiting', autoResumeEnabled: true },
    unknown: { id: taskId('account-a', 'host-a', 'chat', 'turn-unknown'), turnId: 'turn-unknown',
      threadId: 'chat', accountId: 'account-a', hostId: 'host-a', interruptedAt: 100,
      eligibleAt: 200, phase: 'uncertain', autoResumeEnabled: true },
  };
  const config = { items: {}, targets: { chat: { enabled: true } } };
  const [item] = projectQueue(pending, config);
  assert.equal(item.id, taskId('account-a', 'host-a', 'chat', 'turn-unknown'));
  assert.equal(item.phase, 'uncertain');
  assert.equal(item.historyCount, 2);
  assert.equal(item.isLatest, false);
});

test('本机面板聚合同会话历史、脱敏状态、拒绝坏请求并只记录人工核对请求', async () => {
  const root = resolve('.test-evidence', 'panel-http');
  mkdirSync(root, { recursive: true });
  const dir = resolve(root, randomUUID());
  mkdirSync(dir, { recursive: true });
  const configPath = resolve(dir, 'config.jsonl');
  const statePath = resolve(dir, 'state.jsonl');
  const now = Math.floor(Date.now() / 1000);
  const pending = {};
  for (const [threadId, turnId, phase, interruptedAt] of [
    ['chat-private', 'new-turn', 'waiting', now],
    ['chat-private', 'old-turn', 'uncertain', now - 100],
    ['other-chat', 'uncertain-turn', 'uncertain', now - 50],
  ]) {
    const id = taskId('account-private', 'host-private', threadId, turnId);
    pending[id] = { id, threadId, turnId, accountId: 'account-private', hostId: 'host-private',
      phase, interruptedAt, eligibleAt: now + 120, autoResumeEnabled: true };
  }
  append(statePath, { pending, connection: { status: 'unavailable', observedAt: now,
    reason: '模拟连接中断', pipe: 'private-pipe', callerThread: 'private-caller' },
    contextUsageByTarget: { 'chat-private': { status: 'available', activeTokens: 600,
      windowTokens: 1000, ratio: 0.6, model: 'test-model', turnId: 'usage-turn',
      timestamp: new Date(now * 1000).toISOString(), stale: false, completionDelaySeconds: 1,
      source: 'rollout_last_usage' } } });
  let enableCount = 0;
  const panel = startPanel({ configPath, statePath, capabilities: { usage: 'verified',
    threadSnapshot: 'verified', activeContextUsage: 'unsupported', compaction: 'unsupported',
    limitation: '测试中未提供真实上下文接口' }, onGlobalEnabled: async () => enableCount++ });
  await new Promise(resolvePromise => panel.server.once('listening', resolvePromise));
  try {
    const url = new URL(panel.getUrl());
    const post = (path, body, headers = {}) => fetch(new URL(path, url), { method: 'POST',
      headers: { 'x-quota-resume-token': panel.token, 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body) });
    const page = await fetch(url);
    assert.equal(page.status, 200);
    const html = await page.text();
    for (const match of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) new Script(match[1]);
    assert.match(html, /核对原会话后解除等待/);
    assert.match(html, /立即停止正在运行的任务/);
    assert.match(html, /已监测会话的上下文/);
    assert.match(html, /关闭自动续跑/);
    const stateResponse = await fetch(new URL('/api/state', url), {
      headers: { 'x-quota-resume-token': panel.token },
    });
    assert.equal(stateResponse.status, 200);
    const state = await stateResponse.json();
    assert.equal(state.contextUsage[0].activeTokens, 600);
    assert.equal(state.contextUsage[0].windowTokens, 1000);
    assert.equal(state.contextUsage[0].ratio, 0.6);
    assert.equal(state.contextUsage[0].compactionStatus, 'unsupported');
    assert.ok(!JSON.stringify(state).includes('source'));
    assert.equal(state.items.length, 2);
    const grouped = state.items.find(item => item.threadId === 'chat-private');
    assert.equal(grouped.historyCount, 2);
    assert.equal(grouped.phase, 'uncertain');
    assert.equal(grouped.isLatest, false);
    assert.match(grouped.id, /^[a-f0-9]{64}$/);
    assert.ok(!JSON.stringify(state).includes('account-private'));
    assert.ok(!JSON.stringify(state).includes('private-pipe'));
    assert.equal(state.connection.status, 'unavailable');
    assert.equal('pipe' in state.connection, false);

    const forgedHost = await new Promise((resolvePromise, reject) => {
      const request = http.request({ hostname: '127.0.0.1', port: url.port, path: '/api/state',
        headers: { host: 'evil.example', 'x-quota-resume-token': panel.token } }, response => {
        response.resume(); resolvePromise(response.statusCode);
      });
      request.on('error', reject);
      request.end();
    });
    assert.equal(forgedHost, 403);
    assert.equal((await post('/api/global', null)).status, 400);
    assert.equal((await fetch(new URL('/api/state', url), {
      headers: { 'x-quota-resume-token': panel.token },
    })).status, 200, '非法JSON对象不得终止面板进程');
    assert.equal((await post('/api/resolve', { id: grouped.id })).status, 200);
    assert.ok(configuration(configPath).items[grouped.id].manualResolutionRequestedAt > 0);
    assert.equal(records(statePath).at(-1).pending[grouped.id].phase, 'uncertain',
      '人工请求只写配置日志，不直接改写或解除待核对记录');
    assert.equal((await post('/api/global', { enabled: true })).status, 200);
    assert.equal(enableCount, 1);
  } finally {
    await new Promise(resolvePromise => panel.server.close(resolvePromise));
  }
});

function uncertainHarness() {
  const h = harness();
  const id = 'task-hash';
  h.state.pending[id] = { id, threadId: 'chat', hostId: 'local', accountId: 'account-a',
    turnId: 'failed-turn', resetAt: 200, interruptedAt: 110, eligibleAt: 320,
    armedAt: 100, phase: 'uncertain', autoResumeEnabled: true };
  h.state.activeAutoResume = id;
  h.config.items = { [id]: { manualResolutionRequestedAt: 500 } };
  return { h, id };
}

test('用户核对发送结果后，后台确认原会话不在运行才释放槽位且不重发', async () => {
  const { h, id } = uncertainHarness();
  h.usage = quota(true, 0);
  await h.run(501);
  assert.equal(h.state.pending[id].phase, 'needs_review');
  assert.equal(h.state.activeAutoResume, null);
  assert.deepEqual(h.acknowledgements, [{ id, requestedAt: 500 }]);
  assert.equal(h.sends.length, 0);
});

test('发送不确定任务仍在运行时，人工解除请求保留并继续占用槽位', async () => {
  const { h, id } = uncertainHarness();
  h.snapshot.thread.status.type = 'busy';
  h.snapshot.turns[0].id = 'accepted-turn';
  h.snapshot.turns[0].status = 'inProgress';
  h.usage = quota(true, 0);
  await h.run(501);
  assert.equal(h.state.pending[id].phase, 'uncertain');
  assert.equal(h.state.activeAutoResume, id);
  assert.equal(h.config.items[id].manualResolutionRequestedAt, 500);
  assert.equal(h.acknowledgements.length, 0);
  assert.equal(h.sends.length, 0);
});

test('额度中断先等待，恢复且到点后只发送一次到原聊天', async () => {
  const h = harness();
  await h.run(150);
  assert.equal(queued(h).phase, 'waiting');
  assert.equal(h.sends.length, 0);
  h.usage = quota(true, 0);
  await h.run(319);
  assert.equal(h.sends.length, 0);
  await h.run(320);
  await h.run(350);
  assert.equal(h.sends.length, 1);
  assert.equal(h.sends[0].threadId, 'chat');
  assert.match(h.sends[0].prompt, /尚未完成/);
});

for (const allowed of [false, null, undefined]) {
  test(`到点但后台许可为 ${allowed} 时不发送`, async () => {
    const h = harness();
    await h.run(150);
    h.usage = quota(allowed, 0);
    if (allowed === undefined) delete h.usage.ordinaryUsageAllowed;
    await h.run(320);
    assert.equal(h.sends.length, 0);
  });
}

for (const [status, expected] of [['completed', 'turn_completed'], ['interrupted', 'stopped'], ['inProgress', 'manual_running']]) {
  test(`原任务状态变为 ${status} 时采用对应的可见状态`, async () => {
    const h = harness();
    await h.run(150);
    h.usage = quota(true, 0);
    h.snapshot.turns[0].status = status;
    await h.run(300);
    assert.equal(h.sends.length, 0);
    assert.equal(queued(h).phase, expected);
    if (status === 'interrupted') assert.equal(queued(h).autoResumeEnabled, false);
  });
}

test('会话需要用户处理时不会标为已完成或重新续跑', async () => {
  const h = harness();
  await h.run(150);
  h.snapshot.thread.status.type = 'needsInput';
  h.usage = quota(true, 0);
  await h.run(300);
  assert.equal(h.sends.length, 0);
  assert.equal(queued(h).phase, 'needs_user');
});

test('用户新提交另一轮，即使又失败也不续跑原失败', async () => {
  const h = harness();
  await h.run(150);
  h.snapshot.turns[0].id = 'new-user-turn';
  h.usage = quota(true, 0);
  await h.run(300);
  assert.equal(h.sends.length, 0);
});

test('发送超时后即使重启也不会重复发送', async () => {
  const h = harness();
  await h.run(150);
  h.usage = quota(true, 0);
  h.failSend = true;
  await assert.rejects(h.run(320), /模拟发送超时/);
  h.state = structuredClone(h.writes.at(-1));
  h.failSend = false;
  await h.run(400);
  assert.equal(h.sends.length, 1);
  assert.equal(queued(h).phase, 'uncertain');
});

test('崩溃于发送占位写入之后，重启不重发', async () => {
  const h = harness();
  await h.run(150);
  const entry = queued(h);
  entry.phase = 'sending';
  h.state.activeAutoResume = entry.id;
  h.usage = quota(true, 0);
  await h.run(320);
  assert.equal(h.sends.length, 0);
});

test('用户关闭插件、归档或移出目录后不发送', async () => {
  const h = harness();
  await h.run(150);
  h.usage = quota(true, 0);
  h.still = false;
  await h.run(320);
  assert.equal(h.sends.length, 0);
  h.still = true;
  h.visible = false;
  await h.run(320);
  assert.equal(h.sends.length, 0);
  assert.equal(queued(h).phase, 'blocked_unavailable');
});

test('等待期间切换账号不续跑', async () => {
  const h = harness();
  await h.run(150);
  h.usage = { ...quota(true, 0), accountId: 'account-b' };
  await h.run(320);
  assert.equal(h.sends.length, 0);
});

test('注册被新用户输入更新后，不发送旧等待项', async () => {
  const h = harness();
  await h.run(150);
  h.config.targets.chat.armedAt = 250;
  h.usage = quota(true, 0);
  await h.run(300);
  assert.equal(h.sends.length, 0);
});

test('历史失败、普通错误、非五小时限制不进入等待', () => {
  assert.equal(quotaFailure(failure(), 120, quota()), null);
  const ordinary = failure();
  ordinary.turns[0].error.codexErrorInfo = 'internalServerError';
  assert.equal(quotaFailure(ordinary, 100, quota()), null);
  const weekly = quota();
  weekly.rateLimits.primary.windowDurationMins = 10080;
  assert.equal(exhaustedUntil(weekly), null);
});

test('额度恢复后后台仍不允许使用时，保持等待，包括周额度限制', async () => {
  const h = harness();
  await h.run(150);
  h.usage = quota(false, 0);
  h.usage.rateLimits.secondary = { usedPercent: 100, windowDurationMins: 10080, resetsAt: 1000 };
  await h.run(320);
  assert.equal(h.sends.length, 0);
  assert.equal(queued(h).phase, 'waiting');
  assert.equal(queued(h).nextCheckAt, 380);
});

test('电脑休眠错过时间，醒来后恢复检查可继续', async () => {
  const h = harness();
  await h.run(150);
  h.usage = quota(true, 0);
  await h.run(2000);
  assert.equal(h.sends.length, 1);
});
