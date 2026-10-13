import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeRouter } from '../scripts/native-router.mjs';

const setup = () => {
  const backend = [], renderer = [], bridge = [];
  const router = new NativeRouter({ backend: m => backend.push(m), renderer: m => renderer.push(m) });
  return { router, backend, renderer, bridge, reply: m => bridge.push(m) };
};

test('identical caller IDs receive only their own backend responses', () => {
  const s = setup();
  s.router.rendererMessage({ id: 1, method: 'thread/read', params: {} });
  s.router.bridgeRequest({ id: 1, method: 'thread/compact/start', params: { threadId: 'authorized' } }, s.reply, () => true);
  assert.notEqual(s.backend[0].id, s.backend[1].id);
  s.router.backendMessage({ id: s.backend[1].id, result: { accepted: true } });
  s.router.backendMessage({ id: s.backend[0].id, result: { title: 'renderer only' } });
  assert.deepEqual(s.bridge, [{ id: 1, result: { accepted: true } }]);
  assert.deepEqual(s.renderer, [{ id: 1, result: { title: 'renderer only' } }]);
});

test('approvals and notifications preserve renderer routing', () => {
  const s = setup();
  const approval = { id: 7, method: 'item/commandExecution/requestApproval', params: {} };
  const event = { method: 'thread/tokenUsage/updated', params: {} };
  s.router.backendMessage(approval);
  s.router.backendMessage(event);
  s.router.rendererMessage({ id: 7, result: { decision: 'decline' } });
  assert.deepEqual(s.renderer, [approval, event]);
  assert.deepEqual(s.backend, [{ id: 7, result: { decision: 'decline' } }]);
  assert.deepEqual(s.bridge, []);
});

test('invalid methods, missing targets and unapproved targets never reach backend', () => {
  const s = setup();
  for (const message of [
    { id: 1, method: 'turn/start', params: { threadId: 'x' } },
    { id: 1, method: 'turn/interrupt', params: { threadId: 'x' } },
    { id: 1, method: 'thread/compact/start', params: { threadId: 'x' } },
    { id: 1, method: 'thread/compact/start', params: { threadId: 'x', config: {} } },
  ]) assert.throws(() => s.router.bridgeRequest(message, s.reply, () => false));
  assert.equal(s.backend.length, 0);
});

test('disconnect resolves outstanding requests once and unknown responses are discarded', () => {
  const s = setup();
  s.router.backendMessage({ id: 'unknown', result: 'private' });
  s.router.bridgeRequest({ id: 2, method: 'turn/interrupt', params: { threadId: 'x', turnId: 't' } }, s.reply, () => true);
  s.router.close(); s.router.close();
  assert.equal(s.bridge.length, 1);
  assert.match(s.bridge[0].error.message, /requires review/);
  assert.equal(s.renderer.length, 0);
  assert.throws(() => s.router.rendererMessage({ method: 'initialized' }));
});

test('host quota query is isolated from renderer and arbitrary host RPC is refused', async () => {
  const s = setup();
  const result = s.router.hostRequest('account/rateLimits/read');
  s.router.backendMessage({ id: s.backend[0].id, result: { rateLimits: {} } });
  assert.deepEqual(await result, { rateLimits: {} });
  assert.equal(s.renderer.length, 0);
  await assert.rejects(s.router.hostRequest('turn/start'));
});
