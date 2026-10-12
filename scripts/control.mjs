import { readFileSync, writeFileSync, mkdirSync, existsSync, realpathSync, appendFileSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { Desktop } from './desktop.mjs';
import { tick } from './engine.mjs';
import { configuration, records, append } from './store.mjs';

const option = name => {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
};
let dataDir = resolve(option('--data-dir') ?? process.env.CODEX_QUOTA_RESUME_DATA
  ?? resolve(process.env.CODEX_HOME ?? resolve(homedir(), '.codex'), 'plugins', 'data', 'codex-quota-resume'));
let ancestor = dataDir;
while (!existsSync(ancestor)) ancestor = dirname(ancestor);
dataDir = resolve(realpathSync(ancestor), relative(ancestor, dataDir));
if (process.platform === 'win32' && /^c:[\\/]/i.test(dataDir)) {
  throw new Error('数据目录在 C 盘。请用 --data-dir 或 CODEX_QUOTA_RESUME_DATA 指定 D 盘目录。');
}
mkdirSync(dataDir, { recursive: true });
const configPath = resolve(dataDir, 'config.jsonl');
const statePath = resolve(dataDir, 'state.jsonl');
const runtimePath = resolve(dataDir, 'runtime.json');
const load = (path, fallback) => existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : fallback;
const save = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const log = (event, details = {}) => appendFileSync(resolve(dataDir, 'events.jsonl'),
  JSON.stringify({ time: new Date().toISOString(), event, ...details }) + '\n');
const now = () => Math.floor(Date.now() / 1000);
const command = process.argv[2];

function enable(threadId, fromHook = false, refreshOnly = false) {
  const old = configuration(configPath);
  if (fromHook && !old.enabled) return;
  const desktop = new Desktop({ callerThread: threadId });
  append(configPath, { type: 'enable', threadId, pipe: desktop.pipe,
    hostId: desktop.hostId ?? 'local', armedAt: refreshOnly && old.targets[threadId]
      ? old.targets[threadId].armedAt : now() });
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'watch', '--data-dir', dataDir],
    { detached: true, windowsHide: true, stdio: 'ignore' });
  child.on('error', error => log('launch_error', { code: error.code ?? 'unknown' }));
  child.unref();
  log('enabled', { threadId });
  if (!fromHook) console.log(JSON.stringify({ enabled: true, threadId, dataDir }));
}

async function watch() {
  // 用本机端口互斥，无需删除锁文件；同一数据目录只允许一个后台程序。
  const port = 44000 + createHash('sha256').update(dataDir.toLowerCase()).digest().readUInt16LE() % 10000;
  const lock = net.createServer(socket => socket.end('codex-quota-resume\n'));
  try {
    await new Promise((resolvePromise, reject) => {
      lock.once('error', reject);
      lock.listen({ host: '127.0.0.1', port, exclusive: true }, resolvePromise);
    });
  } catch (error) {
    if (error.code === 'EADDRINUSE') return;
    throw error;
  }
  save(runtimePath, { pid: process.pid, port, startedAt: now(), alive: true });
  const state = records(statePath).at(-1) ?? { pending: {}, handled: [] };
  log('worker_started', { pid: process.pid });
  try {
    while (true) {
      const config = configuration(configPath);
      if (!config.enabled) break;
      // 已处理的失败保留在 handled；后续新的失败可以独立进入等待。
      for (const [id, pending] of Object.entries(state.pending)) {
        if (['sent', 'cancelled'].includes(pending.phase)) delete state.pending[id];
      }
      try {
        await tick({ desktop: new Desktop(config), config, state, now: now(),
          persist: () => append(statePath, state), log,
          stillEnabled: (threadId, armedAt) => {
            const current = configuration(configPath);
            return current.enabled && current.targets[threadId]?.armedAt === armedAt;
          } });
      } catch (error) {
        log('poll_error', { code: error.code ?? 'RPC_ERROR', reason: '桌面连接或数据读取失败' });
      }
      await new Promise(resolvePromise => setTimeout(resolvePromise, config.intervalSeconds * 1000));
    }
  } finally {
    save(runtimePath, { pid: process.pid, port, alive: false, stoppedAt: now() });
    lock.close();
    log('worker_stopped');
  }
}

if (command === 'enable') {
  enable(option('--thread') ?? process.env.CODEX_THREAD_ID);
} else if (command === 'disable') {
  append(configPath, { type: 'disable' });
  log('disabled');
  console.log('已关闭自动继续；后台程序会在下一轮检查时自行退出。');
} else if (command === 'status') {
  const config = configuration(configPath);
  const runtime = load(runtimePath, null);
  let running = false;
  if (runtime?.alive) {
    running = await new Promise(resolvePromise => {
      const socket = net.createConnection({ host: '127.0.0.1', port: runtime.port });
      const timer = setTimeout(() => { socket.destroy(); resolvePromise(false); }, 1000);
      socket.on('error', () => { clearTimeout(timer); resolvePromise(false); });
      socket.on('data', data => {
        clearTimeout(timer); socket.destroy();
        resolvePromise(data.toString() === 'codex-quota-resume\n');
      });
    });
  }
  console.log(JSON.stringify({ enabled: config.enabled, targets: config.targets,
    running, runtime, state: records(statePath).at(-1) ?? null, dataDir }, null, 2));
} else if (command === 'watch') {
  await watch();
} else if (command === 'probe') {
  const desktop = new Desktop();
  const usage = await desktop.call('get_usage_limits');
  const snapshot = await desktop.call('read_thread', { threadId: desktop.callerThread, turnLimit: 1, includeOutputs: false });
  console.log(JSON.stringify({ ordinaryUsageAllowed: usage.ordinaryUsageAllowed,
    primary: usage.rateLimits?.primary, secondary: usage.rateLimits?.secondary,
    kind: snapshot.thread?.kind, status: snapshot.thread?.status, latestTurnStatus: snapshot.turns?.[0]?.status }, null, 2));
} else if (command === 'hook') {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const event = JSON.parse(input);
  if (!event.agent_id && !event.agent_type) {
    enable(process.env.CODEX_THREAD_ID ?? event.session_id, true, event.hook_event_name === 'SessionStart');
  }
  console.log('{}');
} else {
  console.error('用法: node scripts/control.mjs enable|disable|status|probe|watch|hook [--data-dir 目录]');
  process.exitCode = 1;
}
