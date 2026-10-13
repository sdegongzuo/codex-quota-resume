import net from 'node:net';

const maxFrame = 1024 * 1024;
const encode = value => {
  const payload = Buffer.from(value, 'utf8');
  const frame = Buffer.allocUnsafe(4 + payload.length);
  frame.writeUInt32LE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
};

function connect(pipe) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(pipe);
    socket.once('connect', () => resolve(socket));
    socket.once('error', reject);
  });
}

async function connectWorker(pipe) {
  let lastError;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try { return await connect(pipe); }
    catch (error) {
      lastError = error;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  throw lastError ?? Error('worker pipe did not become available');
}

function framedEcho(socket, expected) {
  return new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0);
    const onData = chunk => {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length < 4) return;
      const length = buffered.readUInt32LE(0);
      if (length > maxFrame) return reject(Error('oversized host frame'));
      if (buffered.length < length + 4) return;
      const request = buffered.subarray(4, length + 4).toString('utf8');
      socket.off('data', onData);
      socket.write(encode(JSON.stringify({ id: JSON.parse(request).id, result: expected })), error => {
        if (error) return reject(error);
        resolve();
      });
    };
    socket.on('data', onData);
    socket.once('error', reject);
  });
}

try {
  const host = await connect(process.env.QUOTA_RESUME_HOST_PIPE);
  process.stderr.write('mock host connected\n');
  for (const marker of ['first-✓', 'second-雪']) {
    const worker = await connectWorker(process.env.QUOTA_RESUME_WORKER_PIPE);
    process.stderr.write('mock worker connected\n');
    worker.write(encode(JSON.stringify({ id: marker, method: 'mock.echo' })));
    process.stderr.write('mock worker request sent\n');
    await framedEcho(host, marker);
    process.stderr.write('mock host response sent\n');
    const response = await new Promise((resolve, reject) => {
      let buffered = Buffer.alloc(0);
      worker.on('data', chunk => {
        buffered = Buffer.concat([buffered, chunk]);
        if (buffered.length < 4) return;
        const length = buffered.readUInt32LE(0);
        if (length > maxFrame) return reject(Error('oversized worker frame'));
        if (buffered.length < length + 4) return;
        resolve(JSON.parse(buffered.subarray(4, length + 4).toString('utf8')));
      });
      worker.once('error', reject);
    });
    if (response.id !== marker || response.result !== marker) throw Error('broker response mismatch');
    process.stderr.write('mock worker response received\n');
    worker.end();
  }
  host.end();
} catch (error) {
  process.stderr.write(`mock native host failed: ${error.message}\n`);
  process.exitCode = 1;
}
