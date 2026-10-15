import { readFileSync, writeFileSync, mkdirSync, existsSync, realpathSync, appendFileSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { Desktop, safeDesktopDiagnostic } from './desktop.mjs';
import { tick } from './engine.mjs';
import { configuration, records, append, migrateState, shouldLaunchWatcher } from './store.mjs';
import { startPanel } from './panel.mjs';
import { connectNativeWorker } from './native-worker.mjs';

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
const nativeOperationsPath = resolve(dataDir, 'native-operations.jsonl');
let nativeConnection = null;
let nativeDescriptor = null;
async function nativeBridge(config) {
  if (!config.nativeBridge) return null;
  const identity = JSON.stringify(config.nativeBridge);
  if (nativeDescriptor === identity && nativeConnection) return nativeConnection;
  const desktop = new Desktop(config);
  try {
    nativeConnection = await connectNativeWorker({ descriptor: config.nativeBridge, targets: config.targets,
      history: records(nativeOperationsPath), persist: record => append(nativeOperationsPath, record),
      ordinaryUsageAllowed: async () => (await desktop.call('get_usage_limits')).ordinaryUsageAllowed === true });
    nativeDescriptor = identity;
    return nativeConnection;
  } catch { nativeConnection = null; return null; }
}

function launchWatcher() {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'watch', '--data-dir', dataDir],
    { detached: true, windowsHide: true, stdio: 'ignore' });
  child.on('error', error => log('launch_error', { code: error.code ?? 'unknown' }));
  child.unref();
}

function enable(threadId, fromHook = false, refreshOnly = false) {
  const old = configuration(configPath);
  const desktop = new Desktop({ callerThread: threadId });
  if (fromHook) append(configPath, { type: 'register', threadId, pipe: desktop.pipe,
    hostId: desktop.hostId ?? 'local', armedAt: old.targets[threadId]?.armedAt ?? now() });
  else append(configPath, { type: 'enable', threadId, pipe: desktop.pipe,
    hostId: desktop.hostId ?? 'local', armedAt: refreshOnly && old.targets[threadId]
      ? old.targets[threadId].armedAt : now() });
  if (process.env.QUOTA_RESUME_WORKER_PIPE && process.env.QUOTA_RESUME_BRIDGE_TOKEN) {
    append(configPath, { type: 'nativeBridge', value: { pipe: process.env.QUOTA_RESUME_WORKER_PIPE,
      token: process.env.QUOTA_RESUME_BRIDGE_TOKEN } });
  }
  if (shouldLaunchWatcher(fromHook, old.enabled)) launchWatcher();
  log('enabled', { threadId });
  if (!fromHook) console.log(JSON.stringify({ enabled: true, threadId, dataDir }));
}

async function watch() {
  // 用本机端口互斥，无需删除锁文件；同一数据目录只允许一个后台程序。
  const port = 44000 + createHash('sha256').update(dataDir.toLowerCase()).digest().readUInt16LE() % 10000;
  let stopRequested = false;
  const lock = net.createServer(socket => {
    socket.setTimeout(300, () => socket.end('codex-quota-resume\n'));
    socket.on('data', data => {
      if (data.toString().trim() === 'codex-quota-resume:stop') {
        stopRequested = true;
        socket.end('codex-quota-resume:stopping\n');
      } else socket.end('codex-quota-resume\n');
    });
  });
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
  const migrated = migrateState(records(statePath).at(-1) ?? { pending: {}, handled: [] }, configuration(configPath));
  const state = migrated.state;
  if (migrated.changed) append(statePath, state);
  log('worker_started', { pid: process.pid });
  try {
    while (!stopRequested) {
      const config = configuration(configPath);
      try {
          await tick({ desktop: new Desktop({ ...config, native: await nativeBridge(config) }), config, state, now: now(),
          persist: () => append(statePath, state), log,
          registerTarget: entry => {
            const current = configuration(configPath);
            if (!current.enabled || Object.hasOwn(current.targets, entry.threadId)) return false;
            append(configPath, { type: 'discover', ...entry });
            log('target_discovered', { threadId: entry.threadId });
          },
          stillEnabled: (threadId, armedAt, itemId) => {
            const current = configuration(configPath);
            return current.enabled && current.targets[threadId]?.enabled !== false
              && current.targets[threadId]?.armedAt === armedAt
              && current.items?.[itemId]?.enabled !== false;
          },
          acknowledgeManualResolution: (itemId, requestedAt) => append(configPath, {
            type: 'item', id: itemId, value: {
              manualResolutionRequestedAt: null, manualResolutionHandledAt: requestedAt,
            },
          }) });
        const failedTargets = Object.keys(state.readFailuresByTarget ?? {});
        const requiredFailure = state.catalogReadFailure ?? state.usageReadFailure;
        const firstTargetFailure = state.readFailuresByTarget?.[failedTargets[0]];
        state.connection = { status: requiredFailure ? 'unavailable' : failedTargets.length ? 'degraded' : 'available',
          observedAt: now(),
          ...(requiredFailure ?? firstTargetFailure ? safeDesktopDiagnostic(requiredFailure ?? firstTargetFailure,
            (requiredFailure ?? firstTargetFailure).method) : {}),
          reason: requiredFailure ? `桌面读取失败：${requiredFailure.method} / ${requiredFailure.code}`
            + (state.catalogFallbackUsed ? '；已用本地日志收集中断，自动发送暂停' : '')
            : failedTargets.length ? `${failedTargets.length} 个聊天读取失败：${firstTargetFailure.method} / ${firstTargetFailure.code}；其他聊天继续监测` : null };
        append(statePath, state);
      } catch (error) {
        const diagnostic = safeDesktopDiagnostic(error);
        state.connection = { status: 'unavailable', observedAt: now(), ...diagnostic,
          reason: `桌面读取失败：${diagnostic.method} / ${diagnostic.code}` };
        try { append(statePath, state); } catch (persistError) {
          log('connection_state_persist_error', { code: persistError.code ?? 'WRITE_ERROR' });
        }
        log('poll_error', { ...diagnostic, reason: '桌面连接或数据读取失败' });
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
} else if (command === 'refresh') {
  enable(option('--thread') ?? process.env.CODEX_THREAD_ID, true, true);
  console.log(JSON.stringify({ refreshed: true, enabled: configuration(configPath).enabled, dataDir }));
} else if (command === 'disable') {
  append(configPath, { type: 'disable' });
  log('disabled');
  console.log('已关闭自动继续；后台保留只读额度监测，stop 可停止后台。');
} else if (command === 'stop') {
  const runtime = load(runtimePath, null);
  if (!runtime?.alive || !Number.isInteger(runtime.port)) {
  console.log('后台程序当前未运行。');
  } else {
    await new Promise((resolvePromise, reject) => {
      const socket = net.createConnection({ host: '127.0.0.1', port: runtime.port });
      const timer = setTimeout(() => { socket.destroy(); reject(new Error('停止请求超时')); }, 2000);
      socket.once('connect', () => socket.write('codex-quota-resume:stop'));
      socket.on('data', data => {
        clearTimeout(timer);
        const reply = data.toString().trim();
        socket.destroy();
        if (reply === 'codex-quota-resume:stopping') { console.log('后台程序已收到安全停止请求。'); resolvePromise(); }
        else reject(new Error('后台程序未确认停止请求。'));
      });
      socket.on('error', error => { clearTimeout(timer); reject(error); });
    });
  }
} else if (command === 'resolve') {
  const id = option('--item');
  const state = records(statePath).at(-1) ?? { pending: {} };
  const item = state.pending?.[id];
  if (!id || !item || !['sending', 'uncertain'].includes(item.phase)) {
    throw new Error('用法: resolve --item <sending/uncertain任务ID>');
  }
  append(configPath, { type: 'item', id, value: { manualResolutionRequestedAt: now() } });
  console.log(JSON.stringify({ requested: true, id,
    note: '请先确认原会话没有运行中的轮次；后台确认安全后仅解除槽位，不会重发。' }));
} else if (command === 'target') {
  const threadId = option('--thread');
  const enabled = process.argv[3] === 'enable';
  if (!threadId || !['enable', 'disable'].includes(process.argv[3])) throw new Error('用法: target enable|disable --thread <会话ID>');
  append(configPath, { type: 'target', threadId, value: { enabled } });
  if (enabled) launchWatcher();
  console.log(JSON.stringify({ threadId, enabled }));
} else if (command === 'settings') {
  const ratio = Number(option('--threshold'));
  const settings = {};
  if (option('--threshold') !== undefined) {
    if (!(ratio >= 0.1 && ratio <= 0.9)) throw new Error('--threshold 必须是 0.1 到 0.9 的比例，如 0.6');
    settings.compactionThresholdRatio = ratio;
  }
  const config = configuration(configPath);
  append(configPath, { type: 'settings', value: settings });
    console.log(JSON.stringify({ compactionThresholdRatio: settings.compactionThresholdRatio ?? config.compactionThresholdRatio,
      resumeBufferSeconds: settings.resumeBufferSeconds ?? config.resumeBufferSeconds,
      recoveryRetrySeconds: settings.recoveryRetrySeconds ?? config.recoveryRetrySeconds,
      intervalSeconds: settings.intervalSeconds ?? config.intervalSeconds }, null, 2));
} else if (command === 'panel') {
  // The panel needs quota observations even when automatic actions are disabled.
  launchWatcher();
  const initialNative = await nativeBridge(configuration(configPath));
  const nativeVerified = initialNative?.verified === true;
  const compactionVerified = initialNative?.compactionVerified === true;
  const capabilities = { usage: 'verified', threadSnapshot: 'verified',
    activeContextUsage: 'available', contextUsageSource: 'rollout_jsonl_read_only',
    nativeBridge: nativeVerified ? 'authenticated' : 'unavailable',
    compaction: compactionVerified ? 'connected_unverified' : 'unsupported',
    liveTurnEvents: nativeVerified ? 'metadata_connected_unverified' : 'unsupported',
    limitation: nativeVerified
      ? (compactionVerified
        ? '原生桥接及压缩关联协议已接入，真实压缩和中止效果等待自然额度周期验收。'
        : '原生桥接可读取轮次元数据；当前 host 未加载新版压缩关联协议，自动压缩暂不可用。额度恢复续跑独立运行。')
      : '已监测会话可读取单次上下文用量；当前没有通过认证的原生桥接，压缩与中止不可用，后端轮次元数据尚未接入。' };
  const panel = startPanel({ configPath, statePath, capabilities,
      port: Number(option('--port') ?? 0), accessToken: process.env.CODEX_QUOTA_RESUME_PANEL_TOKEN,
      onGlobalEnabled: async () => launchWatcher(),
      onStop: nativeVerified ? async operation => {
        const native = await nativeBridge(configuration(configPath));
        if (!native) return { status: 'connection_unavailable' };
        return native.perform({ ...operation, action: 'interrupt' });
      } : null });
  await new Promise(resolvePromise => panel.server.once('listening', resolvePromise));
  console.log(JSON.stringify({ url: panel.getUrl(), host: '127.0.0.1', port: panel.server.address().port,
    dataDir, capabilities }, null, 2));
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
    settings: { compactionThresholdRatio: config.compactionThresholdRatio,
      resumeBufferSeconds: config.resumeBufferSeconds, recoveryRetrySeconds: config.recoveryRetrySeconds },
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
  console.error('用法: node scripts/control.mjs enable|refresh|disable|target|settings|panel|status|probe|resolve|watch|hook [--data-dir 目录]');
  process.exitCode = 1;
}
