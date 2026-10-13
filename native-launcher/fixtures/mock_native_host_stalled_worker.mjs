import net from 'node:net';
import { createInterface } from 'node:readline';

const host = net.createConnection(process.env.QUOTA_RESUME_HOST_PIPE);
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', line => {
  const normalized = line.replace(/^\uFEFF/, '');
  process.stdout.write(`stdio:${normalized}\n`);
  if (normalized === 'exit') process.exit(0);
});
host.on('error', () => {});
host.once('connect', () => {
  host.once('close', () => {
    process.stderr.write('mock host pipe closed; stdio process retained until graceful exit\n');
  });
  const worker = net.createConnection(process.env.QUOTA_RESUME_WORKER_PIPE);
  worker.on('error', () => {});
  worker.once('connect', () => {
    const partial = Buffer.from([64, 0, 0, 0, 0x7b]);
    worker.write(partial);
    setInterval(() => {}, 1000);
  });
});
