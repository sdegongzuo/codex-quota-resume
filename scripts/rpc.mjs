import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export class Rpc {
  constructor(codex = 'codex', standaloneReadOnly = false) {
    this.nextId = 0;
    this.pending = new Map();
    this.child = spawn(codex, standaloneReadOnly ? ['app-server'] : ['app-server', 'proxy'], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.stderr = '';
    this.child.stderr.on('data', data => { this.stderr = (this.stderr + data).slice(-2000); });
    createInterface({ input: this.child.stdout }).on('line', line => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
      else pending.resolve(message.result);
    });
    const fail = error => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      this.pending.clear();
    };
    this.child.on('error', fail);
    this.child.on('exit', code => fail(new Error(`Codex 连接退出 ${code}: ${this.stderr}`)));
    this.child.stdin.on('error', fail);
  }

  call(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`接口超时: ${method}`));
      }, 20000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }

  async initialize() {
    await this.call('initialize', {
      clientInfo: { name: 'codex_quota_resume', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    });
    this.child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
  }

  close() { this.child.stdin.end(); }
}

if (process.argv.includes('--probe')) {
  const rpc = new Rpc();
  try {
    await rpc.initialize();
    const limits = await rpc.call('account/rateLimits/read');
    const threads = await rpc.call('thread/list', { limit: 2, sortKey: 'updated_at' });
    console.log(JSON.stringify({ ordinaryUsageAllowed: limits.ordinaryUsageAllowed,
      buckets: Object.keys(limits.rateLimitsByLimitId ?? {}),
      windows: [limits.rateLimits.primary, limits.rateLimits.secondary],
      threads: threads.data?.map(t => ({ id: t.id, status: t.status, direct: t.canAcceptDirectInput, source: t.source })) }, null, 2));
  } finally { rpc.close(); }
}
