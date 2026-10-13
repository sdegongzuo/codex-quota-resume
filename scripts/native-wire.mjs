export const MAX_NATIVE_FRAME = 1024 * 1024;

export function encodeNativeFrame(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  if (!body.length || body.length > MAX_NATIVE_FRAME) throw Error('Invalid native frame size');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}

export class NativeFrameDecoder {
  constructor(deliver) { this.deliver = deliver; this.buffer = Buffer.alloc(0); this.failed = false; }
  push(chunk) {
    if (this.failed) throw Error('Native decoder closed');
    this.buffer = Buffer.concat([this.buffer, chunk]);
    try {
      while (this.buffer.length >= 4) {
        const length = this.buffer.readUInt32LE(0);
        if (!length || length > MAX_NATIVE_FRAME) throw Error('Invalid native frame size');
        if (this.buffer.length < length + 4) return;
        const message = JSON.parse(this.buffer.subarray(4, length + 4).toString('utf8'));
        if (!message || typeof message !== 'object' || Array.isArray(message)) throw Error('Invalid native frame envelope');
        this.buffer = this.buffer.subarray(length + 4);
        this.deliver(message);
      }
    } catch (error) { this.failed = true; this.buffer = Buffer.alloc(0); throw error; }
  }
  end() {
    if (this.buffer.length) { this.failed = true; throw Error('Incomplete native frame'); }
  }
}
