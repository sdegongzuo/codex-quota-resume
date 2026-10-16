import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { Desktop } from '../scripts/desktop.mjs';

test('目标控制要求认证桥接能力，明确null才能认定没有目标', async () => {
  const desktop = new Desktop({ pipe: 'fixture', callerThread: 'owner' });
  await assert.rejects(desktop.getTargetGoal('target'), { code: 'DESKTOP_TOOL_UNAVAILABLE' });
  desktop.native = { verified: true, goalControlVerified: false, getGoal: async () => ({ goal: null }) };
  await assert.rejects(desktop.getTargetGoal('target'), { code: 'DESKTOP_TOOL_UNAVAILABLE' });
  desktop.native.goalControlVerified = true;
  assert.equal(await desktop.getTargetGoal('target'), null);
  desktop.native.getGoal = async () => ({});
  await assert.rejects(desktop.getTargetGoal('target'), { code: 'DESKTOP_INVALID_RESPONSE' });
  desktop.native.resumeGoal = async () => ({ goal: { threadId: 'other', status: 'active' } });
  await assert.rejects(desktop.resumeTargetGoal('target', 'failed'), { code: 'DESKTOP_INVALID_RESPONSE' });
});

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

test('工具失败保留具体方法与安全错误码，诊断不保存返回正文', async () => {
  const desktop = new Desktop({ pipe: 'fixture', callerThread: 'owner-chat' });
  desktop.tools = [{ name: 'read_thread', namespace: 'codex_app' }];
  desktop.request = async () => ({ success: false,
    contentItems: [{ type: 'inputText', text: 'private-token-and-user-content' }] });
  await assert.rejects(desktop.call('read_thread', { threadId: 'target' }), error => {
    assert.equal(error.tool, 'read_thread');
    assert.equal(error.code, 'DESKTOP_TOOL_FAILED');
    assert.equal(JSON.stringify(error.diagnostic).includes('private-token'), false);
    assert.deepEqual(error.diagnostic, { method: 'read_thread', code: 'DESKTOP_TOOL_FAILED' });
    return true;
  });
});

test('连接失败诊断区分工具发现与实际调用', async () => {
  const desktop = new Desktop({ pipe: 'fixture', callerThread: 'owner-chat' });
  desktop.request = async () => { throw Object.assign(Error('pipe-secret'), { code: 'ENOENT' }); };
  await assert.rejects(desktop.call('get_usage_limits'), error => {
    assert.deepEqual(error.diagnostic, { method: 'tools/list', code: 'ENOENT' });
    return true;
  });
});
