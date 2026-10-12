import test from 'node:test';
import assert from 'node:assert/strict';
const { tick, quotaFailure, exhaustedUntil } = await import(
  process.env.ENGINE_UNDER_TEST ?? '../scripts/engine.mjs');

const failure = () => ({ thread: { kind: 'codex', status: { type: 'idle' } },
  turns: [{ id: 'failed-turn', status: 'failed', completedAt: 110,
    error: { codexErrorInfo: 'usageLimitExceeded' } }] });
const quota = (allowed = false, percent = 100) => ({ ordinaryUsageAllowed: allowed, accountId: 'account-a',
  rateLimits: { primary: { usedPercent: percent, windowDurationMins: 300, resetsAt: 200 } } });
function harness() {
  const h = { usage: quota(), snapshot: failure(), sends: [], writes: [],
    config: { enabled: true, targets: { chat: { enabled: true, armedAt: 100 } } },
    state: { pending: {}, handled: [] }, visible: true, still: true };
  h.desktop = { call: async (name, args) => {
    if (name === 'list_threads') return { threads: h.visible ? [{ id: 'chat', kind: 'codex' }] : [] };
    if (name === 'get_usage_limits') return h.usage;
    if (name === 'read_thread') return h.snapshot;
    if (name === 'send_message_to_thread') {
      assert.equal(h.state.pending.chat.phase, 'sending', '必须先持久化发送占位');
      assert.equal(h.writes.at(-1).pending.chat.phase, 'sending');
      h.sends.push(args);
      if (h.failSend) throw new Error('模拟发送超时');
      return { accepted: true };
    }
    throw new Error(`未预期工具: ${name}`);
  } };
  h.run = now => tick({ ...h, now, persist: async () => h.writes.push(structuredClone(h.state)),
    log: async () => {}, stillEnabled: () => h.still });
  return h;
}

test('额度中断先等待，恢复且到点后只发送一次到原聊天', async () => {
  const h = harness();
  await h.run(150);
  assert.equal(h.state.pending.chat.phase, 'waiting');
  assert.equal(h.sends.length, 0);
  h.usage = quota(true, 0);
  await h.run(204);
  assert.equal(h.sends.length, 0);
  await h.run(205);
  await h.run(300);
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
    await h.run(300);
    assert.equal(h.sends.length, 0);
  });
}

for (const status of ['completed', 'interrupted', 'inProgress']) {
  test(`原任务状态变为 ${status} 时取消待续跑任务`, async () => {
    const h = harness();
    await h.run(150);
    h.usage = quota(true, 0);
    h.snapshot.turns[0].status = status;
    await h.run(300);
    assert.equal(h.sends.length, 0);
    assert.equal(h.state.pending.chat.phase, 'cancelled');
  });
}

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
  await assert.rejects(h.run(300), /模拟发送超时/);
  h.state = structuredClone(h.writes.at(-1));
  h.failSend = false;
  await h.run(400);
  assert.equal(h.sends.length, 1);
  assert.equal(h.state.pending.chat.phase, 'uncertain');
});

test('崩溃于发送占位写入之后，重启不重发', async () => {
  const h = harness();
  await h.run(150);
  h.state.pending.chat.phase = 'sending';
  h.usage = quota(true, 0);
  await h.run(300);
  assert.equal(h.sends.length, 0);
});

test('用户关闭插件、归档或移出目录后不发送', async () => {
  const h = harness();
  await h.run(150);
  h.usage = quota(true, 0);
  h.still = false;
  await h.run(300);
  assert.equal(h.sends.length, 0);
  h.still = true;
  h.visible = false;
  await h.run(300);
  assert.equal(h.sends.length, 0);
  assert.equal(h.state.pending.chat.phase, 'cancelled');
});

test('等待期间切换账号不续跑', async () => {
  const h = harness();
  await h.run(150);
  h.usage = { ...quota(true, 0), accountId: 'account-b' };
  await h.run(300);
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
  await h.run(300);
  assert.equal(h.sends.length, 0);
  assert.equal(h.state.pending.chat.phase, 'waiting');
});

test('电脑休眠错过时间，醒来后恢复检查可继续', async () => {
  const h = harness();
  await h.run(150);
  h.usage = quota(true, 0);
  await h.run(2000);
  assert.equal(h.sends.length, 1);
});
