import { timingSafeEqual } from 'node:crypto';

// Authenticated command boundary. The Windows broker must enforce logon ACL before calling this.
export class NativeService {
  constructor({ token, router, events, configuration, ordinaryUsageAllowed }) {
    if (typeof token !== 'string' || token.length < 32) throw Error('Native bridge token missing');
    Object.assign(this, { token, router, events, configuration, ordinaryUsageAllowed });
  }

  async dispatch(message, reply) {
    const denied = () => reply({ id: message?.id ?? null, error: { code: -32600, message: 'Native bridge request rejected' } });
    if (!message || typeof message !== 'object' || Array.isArray(message)
      || !['string', 'number'].includes(typeof message.id) || typeof message.token !== 'string') return denied();
    const provided = Buffer.from(message.token), expected = Buffer.from(this.token);
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return denied();
    if (!['snapshot', 'compact', 'interrupt'].includes(message.command)
      || typeof message.threadId !== 'string' || !message.threadId) return denied();
    if (Object.keys(message).some(key => !['id', 'token', 'command', 'threadId', 'turnId'].includes(key))) return denied();
    const config = this.configuration();
    if (!Object.hasOwn(config.targets ?? {}, message.threadId)) return denied();
    const snapshot = this.events.snapshot(message.threadId);
    if (message.command === 'snapshot') {
      reply({ id: message.id, result: { ...(snapshot ?? {}), protocolVersion: 2 } }); return;
    }
    if (!snapshot || typeof message.turnId !== 'string' || snapshot.turnId !== message.turnId) return denied();
    if (message.command === 'compact') {
      if (config.enabled !== true || config.targets[message.threadId].enabled === false || !snapshot.safeBoundary) return denied();
      try { if (await this.ordinaryUsageAllowed() !== true) return denied(); }
      catch { return denied(); }
    }
    if (message.command === 'interrupt' && snapshot.status !== 'inProgress') {
      reply({ id: message.id, result: { alreadyEnded: true } }); return;
    }
    // Re-read authorization after any asynchronous quota check, immediately before routing.
    const authorize = () => {
      const current = this.configuration();
      const currentSnapshot = this.events.snapshot(message.threadId);
      return Object.hasOwn(current.targets ?? {}, message.threadId)
        && currentSnapshot?.turnId === message.turnId
        && (message.command === 'interrupt' ? currentSnapshot.status === 'inProgress' : current.enabled === true
          && current.targets[message.threadId].enabled !== false && currentSnapshot.safeBoundary === true);
    };
    try {
      if (message.command === 'compact' && (authorize() !== true
        || this.events.beginCompaction?.(message.threadId, message.id, message.turnId) !== true)) return denied();
      this.router.bridgeRequest({ id: message.id,
        method: message.command === 'compact' ? 'thread/compact/start' : 'turn/interrupt',
        params: message.command === 'compact' ? { threadId: message.threadId }
          : { threadId: message.threadId, turnId: message.turnId } }, response => {
        if (message.command === 'compact') {
          if (response.error) this.events.invalidateCompaction(message.threadId, message.id);
          else response = { ...response, result: { ...response.result, operationId: message.id } };
        }
        reply(response);
      }, authorize);
    } catch {
      if (message.command === 'compact') this.events.invalidateCompaction?.(message.threadId, message.id);
      denied();
    }
  }
}
