import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, statSync, readFileSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { append } from '../scripts/store.mjs';
import { createStateWriter, readState } from '../scripts/state-store.mjs';
import { startPanel } from '../scripts/panel.mjs';
import { inflateSync } from 'node:zlib';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

function fixture() {
  const directory = resolve('.test-evidence', `state-journal-${randomUUID()}`);
  mkdirSync(directory, { recursive: true });
  return resolve(directory, 'state.jsonl');
}

test('migration preserves legacy history and pending send guards; restart replays nested changes', () => {
  const path = fixture();
  const state = { pending: { a: { phase: 'sending', turnId: 'failed' } }, activeAutoResume: 'a', handled: ['old'], nested: { obsolete: 1 } };
  append(path, state);
  const original = readFileSync(path);
  assert.deepEqual(readState(path), state);
  const write = createStateWriter(path);
  write(state);
  state.pending.a.phase = 'uncertain';
  state.handled.push('new');
  delete state.nested.obsolete;
  state.nested.added = { text: '状态' };
  write(state);
  assert.deepEqual(readState(path), state);
  createStateWriter(path)(state);
  assert.deepEqual(readState(path), state);
  assert.deepEqual(readFileSync(path), original);
});

test('repeated observations persist deltas rather than full snapshots and skip identical writes', () => {
  const path = fixture();
  const write = createStateWriter(path);
  const state = { large: 'unchanged'.repeat(6000), activity: { a: { observedAt: 0 } } };
  for (let index = 0; index < 200; index++) {
    state.activity.a.observedAt = index;
    write(state);
  }
  const directory = `${path}.journal`;
  const bytes = () => readdirSync(directory).reduce((sum, name) => sum + statSync(`${directory}/${name}`).size, 0);
  const size = bytes();
  assert.ok(size < Buffer.byteLength(JSON.stringify(state)) * 200 / 20);
  write(state);
  assert.equal(bytes(), size);
  assert.deepEqual(readState(path), state);
});

test('rollover checkpoints recover independently and retain earlier segments unchanged', () => {
  const path = fixture();
  const write = createStateWriter(path, { maxSegmentBytes: 600 });
  const state = { pending: { a: { phase: 'sending' } }, activeAutoResume: 'a', counter: 0 };
  write(state);
  const firstPath = `${path}.journal/000000000001.jsonl`;
  for (let counter = 1; counter <= 80; counter++) { state.counter = counter; write(state); }
  const names = readdirSync(`${path}.journal`).sort();
  assert.ok(names.length > 1);
  const first = readFileSync(firstPath);
  state.counter++;
  write(state);
  assert.deepEqual(readFileSync(firstPath), first);
  for (const name of names) assert.ok(statSync(`${path}.journal/${name}`).size <= 600);
  let checkpoint = JSON.parse(readFileSync(`${path}.journal/${names.at(-1)}`, 'utf8').split('\n')[0]);
  if (checkpoint.type === 'deflate') checkpoint = JSON.parse(inflateSync(Buffer.from(checkpoint.data, 'base64')));
  assert.equal(checkpoint.type, 'checkpoint');
  assert.deepEqual(readState(path), state);
});

test('many target heartbeat changes are compressed losslessly and mixed legacy records remain readable', () => {
  const path = fixture();
  const state = { activityByTarget: Object.fromEntries(Array.from({ length: 100 }, (_, index) =>
    [`thread-${index}`, { observedAt: 1, status: 'idle' }])) };
  const write = createStateWriter(path);
  write(state);
  for (const item of Object.values(state.activityByTarget)) item.observedAt = 2;
  write(state);
  const text = readFileSync(`${path}.journal/000000000001.jsonl`, 'utf8');
  assert.ok(Buffer.byteLength(text) < 2000);
  assert.deepEqual(readState(path), state);
  appendFileSync(`${path}.journal/000000000001.jsonl`, JSON.stringify({ type: 'patch', changes: [{ path: ['extra'], value: true }] }) + '\n');
  assert.deepEqual(readState(path), { ...state, extra: true });
});

test('torn final append is ignored and restarted writer uses a fresh segment', () => {
  const path = fixture();
  const write = createStateWriter(path);
  write({ pending: { a: { phase: 'sending' } }, activeAutoResume: 'a' });
  appendFileSync(`${path}.journal/000000000001.jsonl`, '{"type":"patch"');
  const state = readState(path);
  assert.equal(state.pending.a.phase, 'sending');
  createStateWriter(path)(state);
  assert.equal(readdirSync(`${path}.journal`).length, 2);
  assert.deepEqual(readState(path), state);
});

test('panel reads current journal state instead of frozen legacy snapshot', async () => {
  const path = fixture();
  append(path, { pending: {}, connection: { status: 'unavailable', observedAt: 1 } });
  const write = createStateWriter(path);
  write({ pending: {}, connection: { status: 'available', observedAt: Date.now() / 1000 } });
  const panel = startPanel({ statePath: path, configPath: `${path}.config`, capabilities: {} });
  await new Promise(resolvePromise => panel.server.once('listening', resolvePromise));
  try {
    const url = new URL(panel.getUrl());
    const response = await fetch(`${url.origin}/api/state`, { headers: { 'x-quota-resume-token': panel.token } });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).connection.status, 'available');
  } finally { await new Promise(resolvePromise => panel.server.close(resolvePromise)); }
});

test('failed rollover open can retry without losing the last durable send guard', t => {
  const path = fixture();
  const write = createStateWriter(path, { maxSegmentBytes: 100 });
  write({ pending: {}, counter: 0 });
  const original = fs.openSync;
  let fail = true;
  const mock = t.mock.method(fs, 'openSync', (...args) => {
    if (fail && String(args[0]).endsWith('000000000002.jsonl') && args[1] === 'wx') {
      fail = false;
      throw Object.assign(new Error('injected open failure'), { code: 'EACCES' });
    }
    return original(...args);
  });
  syncBuiltinESMExports();
  try {
    const state = { pending: { claim: { phase: 'sending' } }, activeAutoResume: 'claim', counter: 1 };
    assert.throws(() => write(state), { code: 'EACCES' });
    assert.equal(readState(path).counter, 0);
    write(state);
    assert.deepEqual(readState(path), state);
  } finally { mock.mock.restore(); syncBuiltinESMExports(); }
});
