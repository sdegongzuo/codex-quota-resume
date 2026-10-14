import test from 'node:test';
import assert from 'node:assert/strict';
import { panelConnection } from '../scripts/panel.mjs';

test('过期成功状态不能继续显示后台检查成功', () => {
  const result = panelConnection({ status: 'available', observedAt: 100, reason: null }, 200);
  assert.equal(result.status, 'stale');
  assert.match(result.reason, /未更新/);
});

test('新鲜部分失败和具体方法错误码保持可见', () => {
  assert.equal(panelConnection({ status: 'degraded', observedAt: 190, reason: '1 个聊天失败' }, 200).status, 'degraded');
  const result = panelConnection({ status: 'unavailable', observedAt: 190,
    method: 'read_thread', code: 'DESKTOP_TOOL_FAILED', reason: '读取失败', token: 'private' }, 200);
  assert.equal(result.method, 'read_thread');
  assert.equal(result.code, 'DESKTOP_TOOL_FAILED');
  assert.equal(result.token, undefined);
});
