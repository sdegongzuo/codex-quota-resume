import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeService } from '../scripts/native-service.mjs';
const token = 'synthetic-bridge-token-01234567890123456789';
const setup = () => {
  let config = { enabled: true, targets: { allowed: { enabled: true } } };
  let snapshot = { turnId: 't1', status: 'completed', safeBoundary: true };
  const sent = [], replies = [];
  const service = new NativeService({ token, configuration: () => config, events: { snapshot: () => snapshot },
    ordinaryUsageAllowed: async () => true,
    router: { bridgeRequest: (m, reply, authorize) => { if (!authorize()) throw Error('denied'); sent.push(m); reply({ id: m.id, result: {} }); } } });
  return { service, sent, replies, reply: r => replies.push(r), setConfig: c => { config = c; }, setSnapshot: s => { snapshot = s; } };
};
const command = { id: 1, token, command: 'compact', threadId: 'allowed', turnId: 't1' };

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
