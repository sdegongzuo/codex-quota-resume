import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, utimesSync, symlinkSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pruneLogs } from '../scripts/log-retention.mjs';
import { createStateWriter, readState } from '../scripts/state-store.mjs';
import { createEventLogger } from '../scripts/event-log.mjs';
import { append } from '../scripts/store.mjs';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

function fixture() {
  const directory = resolve('.test-evidence', `retention-${randomUUID()}`);
  mkdirSync(directory, { recursive: true });
  return directory;
}

test('retention removes only matching old/over-budget files and protects retained files', () => {
  const directory = fixture();
  const now = Date.now();
  for (const name of ['000000000001.jsonl', '000000000002.jsonl', '000000000003.jsonl', 'config.jsonl']) {
    writeFileSync(resolve(directory, name), '1234567890');
  }
  utimesSync(resolve(directory, '000000000001.jsonl'), new Date(now - 8 * 86400_000), new Date(now - 8 * 86400_000));
  const removed = pruneLogs(directory, /^\d{12}\.jsonl$/, { keep: ['000000000003.jsonl'], maxBytes: 10, now });
  assert.deepEqual(removed, ['000000000001.jsonl', '000000000002.jsonl']);
  assert.equal(readFileSync(resolve(directory, 'config.jsonl'), 'utf8'), '1234567890');
  assert.ok(existsSync(resolve(directory, '000000000003.jsonl')));
});

test('retention refuses a linked log directory and leaves external files intact', () => {
  const directory = fixture();
  const outside = fixture();
  writeFileSync(resolve(outside, '000000000001.jsonl'), 'protected');
  const link = resolve(directory, 'linked');
  symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.deepEqual(pruneLogs(link, /^\d{12}\.jsonl$/, { maxBytes: 0 }), []);
  assert.equal(readFileSync(resolve(outside, '000000000001.jsonl'), 'utf8'), 'protected');
});

test('legacy snapshot remains untouched and two recovery segments preserve send guard during cleanup', () => {
  const directory = fixture();
  const path = resolve(directory, 'state.jsonl');
  const state = { pending: { claim: { phase: 'uncertain', turnId: 'failed' } }, activeAutoResume: 'claim', handled: ['already-sent'] };
  append(path, state);
  createStateWriter(path, { autoCleanup: true })(state);
  assert.ok(existsSync(path));
  const first = resolve(`${path}.journal`, '000000000001.jsonl');
  const old = new Date(Date.now() - 8 * 86400_000);
  utimesSync(first, old, old);
  createStateWriter(path, { autoCleanup: true })(state);
  assert.equal(existsSync(path), true);
  assert.ok(existsSync(first)); // Still the second recovery segment.
  createStateWriter(path, { autoCleanup: true })(state);
  assert.equal(existsSync(first), false);
  assert.ok(existsSync(path));
  assert.deepEqual(readState(path), state);
});

test('derived rollout fields no longer generate changing delay records', () => {
  const path = resolve(fixture(), 'state.jsonl');
  const state = { contextUsageByTarget: { a: { timestamp: '2026-10-16T00:00:00Z', activeTokens: 10,
    completionDelaySeconds: 1, ordinal: 10, totalTokens: 10, outputTokens: 2, windowTimestamp: 'old', source: 'rollout' } } };
  const write = createStateWriter(path);
  write(state);
  const segment = resolve(`${path}.journal`, '000000000001.jsonl');
  const size = statSync(segment).size;
  state.contextUsageByTarget.a.completionDelaySeconds = 999;
  write(state);
  assert.equal(statSync(segment).size, size);
  assert.deepEqual(readState(path).contextUsageByTarget.a, { timestamp: '2026-10-16T00:00:00Z', activeTokens: 10 });
  assert.equal(state.contextUsageByTarget.a.completionDelaySeconds, 999);
});

test('repeated errors are throttled, transition receipts are retained, and summary includes count', () => {
  const directory = fixture();
  let now = Date.now();
  const log = createEventLogger(directory, { clock: () => now });
  log('poll_error', { code: 'TIMEOUT' });
  for (let index = 0; index < 20; index++) { now += 100; log('poll_error', { code: 'TIMEOUT' }); }
  log('sending', { threadId: 'synthetic' });
  log('sent', { threadId: 'synthetic' });
  now += 300_000;
  log('poll_error', { code: 'TIMEOUT' });
  const rows = readdirSync(resolve(directory, 'event-logs')).flatMap(name => readFileSync(resolve(directory, 'event-logs', name), 'utf8').trim().split('\n').map(JSON.parse));
  assert.equal(rows.length, 4);
  assert.equal(rows.at(-1).suppressedRepeats, 20);
  assert.deepEqual(rows.map(row => row.event), ['poll_error', 'sending', 'sent', 'poll_error']);
});

test('event logger automatically expires old segments while leaving legacy logs and config untouched', () => {
  const directory = fixture();
  const logs = resolve(directory, 'event-logs');
  mkdirSync(logs);
  const now = Date.now();
  const old = new Date(now - 8 * 86400_000);
  const names = [1, 2, 3].map(index => `${now - 8 * 86400_000 + index}-00000000-0000-0000-0000-00000000000${index}.jsonl`);
  for (const name of names) { writeFileSync(resolve(logs, name), '{}\n'); utimesSync(resolve(logs, name), old, old); }
  for (const name of ['events.jsonl', 'config.jsonl', 'native-operations.jsonl']) writeFileSync(resolve(directory, name), 'untouched');
  createEventLogger(directory, { clock: () => now, autoCleanup: true })('worker_started', { pid: 1 });
  assert.equal(existsSync(resolve(logs, names[0])), false);
  assert.equal(existsSync(resolve(logs, names[1])), false);
  assert.equal(existsSync(resolve(logs, names[2])), true);
  for (const name of ['events.jsonl', 'config.jsonl', 'native-operations.jsonl']) assert.equal(readFileSync(resolve(directory, name), 'utf8'), 'untouched');
});

test('short-lived command loggers cannot prune the active watcher log', () => {
  const directory = fixture();
  let now = Date.now();
  const watch = createEventLogger(directory, { clock: () => now, autoCleanup: true });
  watch('worker_started');
  const logs = resolve(directory, 'event-logs');
  const active = resolve(logs, readdirSync(logs)[0]);
  const old = new Date(now - 8 * 86400_000);
  utimesSync(active, old, old);
  now++;
  createEventLogger(directory, { clock: () => now })('enabled');
  now++;
  createEventLogger(directory, { clock: () => now })('enabled');
  now++;
  createEventLogger(directory, { clock: () => now })('enabled');
  assert.ok(existsSync(active));
  now += 3600_000;
  watch.cleanup(); // Owner also protects its current segment during scheduled cleanup.
  assert.ok(existsSync(active));
  watch('sent');
  assert.match(readFileSync(active, 'utf8'), /worker_started/);
  assert.match(readFileSync(active, 'utf8'), /sent/);
});

test('a failed diagnostic append does not suppress its successful retry', t => {
  const directory = fixture();
  const log = createEventLogger(directory);
  const original = fs.appendFileSync;
  let fail = true;
  const mock = t.mock.method(fs, 'appendFileSync', (...args) => {
    if (fail && String(args[0]).includes('event-logs')) {
      fail = false;
      throw Object.assign(new Error('injected append failure'), { code: 'EACCES' });
    }
    return original(...args);
  });
  syncBuiltinESMExports();
  try {
    assert.throws(() => log('poll_error', { code: 'TIMEOUT' }), { code: 'EACCES' });
    log('poll_error', { code: 'TIMEOUT' });
    const files = readdirSync(resolve(directory, 'event-logs'));
    assert.equal(files.length, 1);
    assert.equal(JSON.parse(readFileSync(resolve(directory, 'event-logs', files[0]), 'utf8')).event, 'poll_error');
  } finally { mock.mock.restore(); syncBuiltinESMExports(); }
});
