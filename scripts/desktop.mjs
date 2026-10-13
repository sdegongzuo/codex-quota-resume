import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { observeRolloutUsage } from './rollout-usage.mjs';

// 使用本机 Codex 插件提供的命名管道；不读取凭据、不启动第二个聊天执行器。
export class Desktop {
  constructor({ pipe = process.env.CODEX_APP_TOOLS_PIPE_PATH,
    callerThread = process.env.CODEX_THREAD_ID, hostId = process.env.CODEX_APP_TOOLS_CALLER_HOST_ID, native } = {}) {
    if (!pipe || !callerThread) throw new Error('需要在 Codex 聊天中启动，以取得桌面管道和当前聊天 ID');
    this.pipe = pipe;
    this.callerThread = callerThread;
    this.hostId = hostId;
    this.nextId = 0;
    this.native = native;
  }

  async nativeSnapshot(threadId) {
    if (this.native?.verified !== true) return null;
    return this.native.snapshot(threadId);
  }

  compactionAdapterForTarget(threadId, turnId) {
    if (this.native?.verified !== true || this.native.compactionVerified !== true || !threadId || !turnId) return null;
    return { verified: true, compact: async ({ requestId }) => {
      const result = await this.native.perform({ action: 'compact', threadId, turnId,
        requestId: `compact:${threadId}:${turnId}:${requestId}` });
      return { completed: result.status === 'completed', after: result.after
        ? { ...result.after, observedAt: result.after.observedAt / 1000 } : null };
    } };
  }

  request(method, params) {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(this.pipe);
      const id = ++this.nextId;
      let buffer = Buffer.alloc(0);
      const finish = (error, result) => {
        clearTimeout(timer);
        socket.destroy();
        if (error) reject(error); else resolve(result);
      };
      const timer = setTimeout(() => finish(new Error(`桌面接口超时: ${method}`)), 20000);
      socket.on('error', error => finish(error));
      socket.on('end', () => finish(new Error('桌面连接已关闭')));
      socket.on('connect', () => {
        const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
        const frame = Buffer.alloc(body.length + 4);
        frame.writeUInt32LE(body.length);
        body.copy(frame, 4);
        socket.write(frame);
      });
      socket.on('data', chunk => {
        buffer = Buffer.concat([buffer, chunk]);
        if (buffer.length < 4) return;
        const length = buffer.readUInt32LE();
        if (length > 16 * 1024 * 1024) return finish(new Error('桌面响应过大'));
        if (buffer.length < length + 4) return;
        try {
          const message = JSON.parse(buffer.subarray(4, length + 4).toString());
          if (message.id !== id) return finish(new Error('桌面响应 ID 不匹配'));
          if (message.error) finish(new Error(message.error.message));
          else finish(null, message.result);
        } catch (error) { finish(error); }
      });
    });
  }

  async call(name, args = {}) {
    if (!this.tools) this.tools = (await this.request('tools/list', { threadStartKind: 'all' })).tools;
    const tool = this.tools.find(tool => tool.name === name);
    if (!tool) throw new Error(`当前 Codex 不支持桌面工具: ${name}`);
    const result = await this.request('tools/call', {
      namespace: tool.namespace, tool: name, arguments: args,
      callerSource: 'codex', threadId: this.callerThread, hostId: this.hostId,
      callId: `quota-resume-${randomUUID()}`, turnId: `quota-resume-${randomUUID()}`,
    });
    const texts = (result.contentItems ?? []).filter(x => x.type === 'inputText').map(x => x.text);
    if (!result.success) throw new Error(texts.join('\n') || '桌面工具失败');
    for (const value of texts) {
      try { return JSON.parse(value); } catch { /* 部分版本返回纯文本 */ }
    }
    if (name === 'send_message_to_thread') return { accepted: true };
    throw new Error(`桌面工具未返回结构化数据: ${name}`);
  }

  async capabilities() {
    if (!this.tools) this.tools = (await this.request('tools/list', { threadStartKind: 'all' })).tools;
    const names = this.tools.map(tool => tool.name);
    return {
      usage: names.includes('get_usage_limits') ? 'available' : 'unavailable',
      threadSnapshot: names.includes('read_thread') ? 'available' : 'unavailable',
      activeContextUsage: 'available',
      contextUsageSource: 'rollout_jsonl_read_only',
      compaction: 'unsupported',
      liveTurnEvents: 'unsupported',
      discoveredTools: names,
      limitation: '活动用量只读自白名单会话 rollout 的单次 usage 与 model_context_window；压缩及实时 turn 事件仍不支持。',
    };
  }

  async contextUsage(targets, options = {}) {
    const codexHome = process.env.CODEX_HOME ?? join(homedir(), '.codex');
    const sessionsRoot = options.sessionsRoot ?? join(codexHome, 'sessions');
    if (!existsSync(sessionsRoot)) return Object.fromEntries(Object.keys(targets ?? {}).map(id => [id,
      { status: 'unavailable', reason: 'sessions directory unavailable' }]));
    return observeRolloutUsage({ sessionsRoot, targets, nowMs: options.nowMs,
      staleAfterSeconds: options.staleAfterSeconds });
  }
}

if (process.argv.includes('--probe')) {
  const desktop = new Desktop();
  const capabilities = await desktop.capabilities();
  const usage = await desktop.call('get_usage_limits');
  console.log('capabilities:', JSON.stringify(capabilities));
  console.log('usage:', JSON.stringify({ ordinaryUsageAllowed: usage.ordinaryUsageAllowed,
    primary: usage.rateLimits?.primary, secondary: usage.rateLimits?.secondary }));
  const thread = await desktop.call('read_thread', { threadId: desktop.callerThread, turnLimit: 1, includeOutputs: false });
  console.log('thread:', JSON.stringify({ kind: thread.thread?.kind,
    status: thread.thread?.status, latestTurnStatus: thread.turns?.[0]?.status }));
}
