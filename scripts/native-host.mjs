import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { NativeRouter } from './native-router.mjs';
import { NativeEvents } from './native-events.mjs';
import { NativeService } from './native-service.mjs';
import { attachNativeChannel } from './native-channel.mjs';
import { configuration } from './store.mjs';
import { nativeQuotaAllowed } from './native-quota.mjs';

// Stdio transport host. No bridge socket is opened until its authorization layer is implemented.
export function startNativeHost({ executable, args, input = process.stdin, output = process.stdout,
  errorOutput = process.stderr, environment = process.env, cwd = process.cwd(), authorized = () => false }) {
  if (!isAbsolute(executable ?? '')) throw new Error('Original CLI must be an absolute path');
  const resolved = realpathSync(executable);
  const backend = spawn(resolved, args, { cwd, env: { ...environment, CODEX_CLI_PATH: resolved },
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const send = message => backend.stdin.write(`${JSON.stringify(message)}\n`);
  const events = new NativeEvents({ authorized });
  const router = new NativeRouter({ backend: send,
    renderer: message => output.write(`${JSON.stringify(message)}\n`) });
  const rendererLines = createInterface({ input, crlfDelay: Infinity });
  const backendLines = createInterface({ input: backend.stdout, crlfDelay: Infinity });
  let finished = false;
  const abort = reason => {
    if (finished) return;
    errorOutput.write(`quota-resume native transport: ${reason}\n`);
    backend.stdin.end();
  };
  rendererLines.on('line', line => {
    if (!line.trim()) return;
    try {
      const message = JSON.parse(line);
      if (!message || typeof message !== 'object' || Array.isArray(message)) throw Error('Invalid envelope');
      events.observeRendererMessage(message);
      router.rendererMessage(message);
    } catch { abort('invalid renderer envelope'); }
  });
  backendLines.on('line', line => {
    if (!line.trim()) return;
    try {
      const message = JSON.parse(line);
      if (!message || typeof message !== 'object' || Array.isArray(message)) throw Error('Invalid envelope');
      events.observe(message);
      router.backendMessage(message);
    } catch { abort('invalid backend envelope'); }
  });
  backend.stderr.on('data', chunk => errorOutput.write(chunk));
  backend.stdin.on('error', () => abort('backend input unavailable'));
  rendererLines.on('close', () => backend.stdin.end());
  const completion = new Promise(resolve => {
    backend.on('error', () => { abort('backend launch failed'); });
    backend.on('close', (code, signal) => {
      finished = true;
      rendererLines.close(); backendLines.close(); router.close();
      input.pause();
      resolve({ code: code ?? 1, signal });
    });
  });
  return { backend, router, events, completion };
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(new URL(import.meta.url))) {
  try {
    const configPath = process.env.QUOTA_RESUME_CONFIG_PATH;
    const pipe = process.env.QUOTA_RESUME_HOST_PIPE;
    if (pipe && (!isAbsolute(configPath ?? '') || !/^d:[\\/]/i.test(configPath)
      || typeof process.env.QUOTA_RESUME_BRIDGE_TOKEN !== 'string'
      || process.env.QUOTA_RESUME_BRIDGE_TOKEN.length < 32)) throw Error('Native configuration incomplete');
    const readConfiguration = () => configPath ? configuration(configPath) : { targets: {} };
    const host = startNativeHost({ executable: process.env.QUOTA_RESUME_ORIGINAL_CLI,
      args: process.argv.slice(2), authorized: threadId => Object.hasOwn(readConfiguration().targets, threadId) });
    let channel;
    if (pipe) {
      const service = new NativeService({ token: process.env.QUOTA_RESUME_BRIDGE_TOKEN,
        router: host.router, events: host.events, configuration: readConfiguration,
        ordinaryUsageAllowed: async () => nativeQuotaAllowed(await host.router.hostRequest('account/rateLimits/read')) });
      channel = attachNativeChannel({ pipe, service });
    }
    process.exitCode = (await host.completion).code;
    channel?.close();
  } catch {
    process.stderr.write('quota-resume native host configuration invalid\n');
    process.exitCode = 1;
  }
}
