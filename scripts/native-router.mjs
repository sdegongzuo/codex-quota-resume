// Pure routing core. Transport, Windows ACL and target authorization belong to the host.
// This module does not launch a backend or grant access to native methods.
export class NativeRouter {
  constructor({ backend, renderer }) {
    this.backend = backend;
    this.renderer = renderer;
    this.sequence = 0;
    this.pending = new Map();
    this.closed = false;
  }

  rendererMessage(message) {
    if (this.closed) throw new Error('native router closed');
    if (Object.hasOwn(message, 'id') && typeof message.method === 'string') {
      const id = `quota-router-${++this.sequence}`;
      this.pending.set(id, { id: message.id, destination: this.renderer });
      this.backend({ ...message, id });
    } else {
      // Responses to server-initiated approvals and notifications remain on the renderer route.
      this.backend(message);
    }
  }

  bridgeRequest(message, destination, authorize) {
    if (this.closed) throw new Error('native router closed');
    if (!Object.hasOwn(message, 'id') || !['thread/compact/start', 'turn/interrupt'].includes(message.method)) {
      throw new Error('native method not allowed');
    }
    const params = message.params;
    if (!params || typeof params.threadId !== 'string' || !params.threadId
      || (message.method === 'turn/interrupt' && (typeof params.turnId !== 'string' || !params.turnId))) {
      throw new Error('native target missing');
    }
    const allowedKeys = message.method === 'turn/interrupt' ? ['threadId', 'turnId'] : ['threadId'];
    if (Object.keys(params).some(key => !allowedKeys.includes(key))) throw new Error('native parameters not allowed');
    if (authorize(message) !== true) throw new Error('native target not authorized');
    const id = `quota-router-${++this.sequence}`;
    this.pending.set(id, { id: message.id, destination });
    this.backend({ ...message, id });
  }

  hostRequest(method, params = {}, timeoutMs = 20000) {
    if (method !== 'account/rateLimits/read') return Promise.reject(Error('Host method not allowed'));
    if (this.closed) return Promise.reject(Error('native router closed'));
    return new Promise((resolve, reject) => {
      const id = `quota-router-${++this.sequence}`;
      const timer = setTimeout(() => { this.pending.delete(id); reject(Error('Host request timeout')); }, timeoutMs);
      this.pending.set(id, { id, destination: response => {
        clearTimeout(timer);
        if (response.error) reject(Error('Host read failed')); else resolve(response.result);
      } });
      try { this.backend({ id, method, params }); }
      catch { clearTimeout(timer); this.pending.delete(id); reject(Error('Host request unavailable')); }
    });
  }

  backendMessage(message) {
    if (this.closed) return;
    if (Object.hasOwn(message, 'id') && !Object.hasOwn(message, 'method')) {
      const pending = this.pending.get(message.id);
      if (pending) {
        this.pending.delete(message.id);
        pending.destination({ ...message, id: pending.id });
      }
      // Unknown responses must never be delivered to a different caller.
      return;
    }
    this.renderer(message);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const request of pending) request.destination({ jsonrpc: '2.0', id: request.id,
      error: { code: -32000, message: 'Backend disconnected; operation outcome requires review' } });
  }
}
