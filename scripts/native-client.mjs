import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { encodeNativeFrame, NativeFrameDecoder } from './native-wire.mjs';

export class NativeClient {
  constructor({ pipe, token, connect = () => net.createConnection(pipe), timeoutMs = 20000 }) {
    if (typeof pipe !== 'string' || !pipe.startsWith('\\\\.\\pipe\\quota-resume-')
      || typeof token !== 'string' || token.length < 32) throw Error('Native bridge configuration missing');
    Object.assign(this, { connect, token, timeoutMs });
  }

  command(command, threadId, turnId) {
    if (!['snapshot', 'compact', 'interrupt', 'goal_get', 'goal_resume'].includes(command) || typeof threadId !== 'string' || !threadId) {
      return Promise.reject(Error('Invalid native bridge command'));
    }
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      let socket, retryTimer, attempts = 0, sent = false;
      let settled = false;
      const finish = (error, result) => {
        if (settled) return;
        settled = true; clearTimeout(timer); clearTimeout(retryTimer); socket?.destroy();
        if (error) reject(error); else resolve(result);
      };
      const timer = setTimeout(() => finish(Error('Native bridge timeout; operation may require review')), this.timeoutMs);
      const decoder = new NativeFrameDecoder(message => {
        if (message.id !== id) return finish(Error('Native bridge response identity mismatch'));
        if (message.error) return finish(Error('Native bridge request rejected'));
        finish(null, message.result);
      });
      const connect = () => {
        if (settled) return;
        const current = this.connect(); socket = current; attempts++;
        current.once('connect', () => {
          if (current !== socket || settled) return;
          try {
            const frame = encodeNativeFrame({ id, token: this.token, command, threadId, ...(turnId ? { turnId } : {}) });
            sent = true; current.write(frame);
          } catch { finish(Error('Native bridge request encoding failed')); }
        });
        current.on('data', chunk => {
          if (current !== socket || settled) return;
          try { decoder.push(chunk); } catch { finish(Error('Invalid native bridge response')); }
        });
        current.on('error', () => {
          if (current !== socket || settled) return;
          // Named-pipe instances may be recreated between clients. Retry connection only;
          // once any request bytes may have been sent, its outcome requires review.
          if (!sent && attempts < 4) {
            socket = null; current.destroy(); retryTimer = setTimeout(connect, attempts * 25);
          } else finish(Error('Native bridge connection unavailable'));
        });
        current.on('end', () => { if (current === socket && !settled) finish(Error('Native bridge closed before response')); });
      };
      connect();
    });
  }
}
