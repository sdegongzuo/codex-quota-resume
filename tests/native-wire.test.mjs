import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeNativeFrame, NativeFrameDecoder, MAX_NATIVE_FRAME } from '../scripts/native-wire.mjs';

test('native frames decode split headers, UTF8 bodies and multiple coalesced messages', () => {
  const messages = [{ id: 1, name: '会话' }, { id: 2, result: {} }];
  const received = [], decoder = new NativeFrameDecoder(m => received.push(m));
  const bytes = Buffer.concat(messages.map(encodeNativeFrame));
  for (let i = 0; i < bytes.length; i++) decoder.push(bytes.subarray(i, i + 1));
  decoder.end();
  assert.deepEqual(received, messages);
  const joined = [], second = new NativeFrameDecoder(m => joined.push(m));
  second.push(bytes); second.end();
  assert.deepEqual(joined, messages);
});

test('oversize, incomplete and non-object frames fail closed', () => {
  const header = Buffer.alloc(4); header.writeUInt32LE(MAX_NATIVE_FRAME + 1);
  const decoder = new NativeFrameDecoder(() => {});
  assert.throws(() => decoder.push(header), /frame size/);
  assert.throws(() => decoder.push(Buffer.alloc(0)), /closed/);
  const incomplete = new NativeFrameDecoder(() => {});
  incomplete.push(Buffer.from([1, 0]));
  assert.throws(() => incomplete.end(), /Incomplete/);
  const invalid = new NativeFrameDecoder(() => {});
  assert.throws(() => invalid.push(encodeNativeFrame([])), /envelope/);
});
