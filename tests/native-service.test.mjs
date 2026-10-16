import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeService } from '../scripts/native-service.mjs';
const token = 'synthetic-bridge-token-01234567890123456789';
const setup = () => {
  let config = { enabled: true, targets: { allowed: { enabled: true } } };
  let snapshot = { turnId: 't1', status: 'completed', safeBoundary: true };
  const sent = [], replies = [];
  const service = new NativeService({ token, configuration: () => config, events: { snapshot: () => snapshot,
    beginCompaction: () => true, invalidateCompaction: () => {} },
    ordinaryUsageAllowed: async () => true,
    router: { bridgeRequest: (m, reply, authorize) => { if (!authorize()) throw Error('denied'); sent.push(m); reply({ id: m.id, result: {} }); } } });
  return { service, sent, replies, reply: r => replies.push(r), setConfig: c => { config = c; }, setSnapshot: s => { snapshot = s; } };
};
const command = { id: 1, token, command: 'compact', threadId: 'allowed', turnId: 't1' };

test('目标通过真实路由核心查询及切换active，响应不包含目标正文', async () => {
  const { NativeRouter } = await import('../scripts/native-router.mjs');
  let goal = { threadId: 'allowed', status: 'paused', objective: 'private objective' };
  let config = { enabled: true, targets: { allowed: { enabled: true } } };
  let snapshot = { turnId: 'failed', status: 'failed' };
  const sent = [], replies = [];
  let router;
  router = new NativeRouter({ renderer: () => {}, backend: message => {
    sent.push(message);
    if (message.method === 'thread/goal/set') goal = { ...goal, status: message.params.status };
    router.backendMessage({ id: message.id, result: { goal } });
  } });
  const service = new NativeService({ token, router, events: { snapshot: () => snapshot },
    configuration: () => config, ordinaryUsageAllowed: async () => true });
  const message = { id: 20, token, command: 'goal_get', threadId: 'allowed' };
  await service.dispatch(message, r => replies.push(r));
  assert.deepEqual(replies.at(-1).result, { goal: { threadId: 'allowed', status: 'paused' } });
  await service.dispatch({ ...message, command: 'goal_resume', turnId: 'failed' }, r => replies.push(r));
  assert.equal(replies.at(-1).result.goal.status, 'active');
  assert.deepEqual(sent.at(-1).params, { threadId: 'allowed', status: 'active', origin: 'user' });
  for (const status of ['budgetLimited', 'complete']) {
    goal.status = status;
    const count = sent.filter(m => m.method === 'thread/goal/set').length;
    await service.dispatch({ ...message, command: 'goal_resume', turnId: 'failed' }, r => replies.push(r));
    assert.ok(replies.at(-1).error);
    assert.equal(sent.filter(m => m.method === 'thread/goal/set').length, count);
  }
  goal.status = 'paused'; snapshot = { turnId: 'new', status: 'inProgress' };
  const count = sent.length;
  await service.dispatch({ ...message, command: 'goal_resume', turnId: 'failed' }, r => replies.push(r));
  assert.equal(sent.length, count);
  config = { enabled: false, targets: { allowed: { enabled: true } } };
  snapshot = { turnId: 'failed', status: 'failed' };
  await service.dispatch({ ...message, command: 'goal_resume', turnId: 'failed' }, r => replies.push(r));
  assert.equal(sent.length, count);
  goal = null;
  await service.dispatch(message, r => replies.push(r));
  assert.deepEqual(replies.at(-1).result, { goal: null });
});

test('bridge rejects invalid token, arbitrary commands, non-targets and arbitrary extra parameters', async () => {
  const s = setup();
  for (const message of [{ ...command, token: 'wrong' }, { ...command, command: 'turn/start' },
    { ...command, threadId: 'other' }, { ...command, config: {} }, { ...command, turnId: 'old' }]) {
    await s.service.dispatch(message, s.reply);
  }
  assert.equal(s.sent.length, 0);
  assert.equal(s.replies.every(r => r.error), true);
});

test('compact requires global and item switches plus a confirmed safe boundary', async () => {
  const s = setup();
  await s.service.dispatch(command, s.reply);
  assert.equal(s.sent.length, 1);
  s.setConfig({ enabled: false, targets: { allowed: { enabled: true } } });
  await s.service.dispatch({ ...command, id: 2 }, s.reply);
  s.setConfig({ enabled: true, targets: { allowed: { enabled: false } } });
  await s.service.dispatch({ ...command, id: 3 }, s.reply);
  s.setConfig({ enabled: true, targets: { allowed: { enabled: true } } });
  s.setSnapshot({ turnId: 't1', status: 'inProgress', safeBoundary: false });
  await s.service.dispatch({ ...command, id: 4 }, s.reply);
  assert.equal(s.sent.length, 1);
});

test('manual stop remains usable after auto-resume switches are disabled', async () => {
  const s = setup();
  s.setConfig({ enabled: false, targets: { allowed: { enabled: false } } });
  s.setSnapshot({ turnId: 't1', status: 'inProgress', safeBoundary: false });
  await s.service.dispatch({ ...command, command: 'interrupt' }, s.reply);
  assert.equal(s.sent[0].method, 'turn/interrupt');
  assert.deepEqual(s.sent[0].params, { threadId: 'allowed', turnId: 't1' });
});
