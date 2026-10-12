import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { Desktop } from '../scripts/desktop.mjs';

test('命名管道分片响应与工具路由保持原聊天身份', async () => {
  const pipe = process.platform === 'win32' ? `\\\\.\\pipe\\quota-test-${randomUUID()}` : undefined;
  if (!pipe) return;
  const received = [];
  const server = net.createServer(socket => {
    let buffer = Buffer.alloc(0);
    socket.on('data', data => {
      buffer = Buffer.concat([buffer, data]);
      if (buffer.length < 4 || buffer.length < 4 + buffer.readUInt32LE()) return;
      const request = JSON.parse(buffer.subarray(4, 4 + buffer.readUInt32LE()).toString());
      received.push(request);
      const result = request.method === 'tools/list'
        ? { tools: [{ name: 'get_usage_limits', namespace: 'codex_app' }] }
        : { success: true, contentItems: [{ type: 'inputText', text: '{"ordinaryUsageAllowed":true}' }] };
      const body = Buffer.from(JSON.stringify({ id: request.id, result }));
      const frame = Buffer.alloc(4 + body.length);
      frame.writeUInt32LE(body.length); body.copy(frame, 4);
      socket.write(frame.subarray(0, 2));
      setTimeout(() => socket.write(frame.subarray(2)), 5);
    });
  });
  await new Promise(resolve => server.listen(pipe, resolve));
  try {
    const app = new Desktop({ pipe, callerThread: 'owner-chat', hostId: 'local' });
    const result = await app.call('get_usage_limits');
    assert.equal(result.ordinaryUsageAllowed, true);
    assert.equal(received[1].params.threadId, 'owner-chat');
    assert.equal(received[1].params.namespace, 'codex_app');
    assert.equal(received[1].params.tool, 'get_usage_limits');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('缺少 Codex 桌面身份时明确失败', () => {
  assert.throws(() => new Desktop({ pipe: '', callerThread: '' }), /需要在 Codex 聊天中启动/);
});
