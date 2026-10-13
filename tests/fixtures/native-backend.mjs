// Isolated synthetic backend for native transport acceptance. Never connects to Codex.
import { createInterface } from 'node:readline';
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = message => process.stdout.write(JSON.stringify(message) + '\n');
let turnId = 'synthetic-turn1';
lines.on('line', line => {
  const message = JSON.parse(line);
  if (message.method === 'probe/info') {
    send({ id: message.id, result: { pipe: process.env.QUOTA_RESUME_WORKER_PIPE } });
  } else if (message.method === 'probe/seed' || message.method === 'probe/busy') {
    turnId = message.method === 'probe/busy' ? 'synthetic-turn2' : 'synthetic-turn1';
    send({ method: 'turn/started', params: { threadId: 'synthetic-target', turn: { id: turnId } } });
    if (message.method === 'probe/seed') send({ method: 'turn/completed', params: {
      threadId: 'synthetic-target', turn: { id: turnId, status: 'completed' } } });
    send({ id: message.id, result: {} });
  } else if (message.method === 'account/rateLimits/read') {
    send({ id: message.id, result: { rateLimits: { primary: { windowDurationMins: 300, usedPercent: 10 } } } });
  } else if (message.method === 'thread/compact/start') {
    send({ id: message.id, result: {} });
    send({ method: 'item/completed', params: { threadId: 'synthetic-target', turnId,
      item: { id: 'synthetic-compaction', type: 'contextCompaction' } } });
    send({ method: 'thread/tokenUsage/updated', params: { threadId: 'synthetic-target', turnId,
      tokenUsage: { last: { totalTokens: 10 }, modelContextWindow: 100 } } });
  } else if (message.method === 'turn/interrupt') {
    send({ id: message.id, result: {} });
    send({ method: 'turn/completed', params: { threadId: 'synthetic-target',
      turn: { id: turnId, status: 'interrupted' } } });
  } else send({ id: message.id, error: { code: -32601, message: 'Synthetic method unavailable' } });
});
