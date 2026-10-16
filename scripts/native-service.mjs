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
    if (!['snapshot', 'compact', 'interrupt', 'goal_get', 'goal_resume'].includes(message.command)
      || typeof message.threadId !== 'string' || !message.threadId) return denied();
    if (Object.keys(message).some(key => !['id', 'token', 'command', 'threadId', 'turnId'].includes(key))) return denied();
    const config = this.configuration();
    if (!Object.hasOwn(config.targets ?? {}, message.threadId)) return denied();
    const snapshot = this.events.snapshot(message.threadId);
    if (message.command === 'snapshot') {
      reply({ id: message.id, result: { ...(snapshot ?? {}), protocolVersion: 2, goalControl: true } }); return;
    }
    if (message.command === 'goal_get' || message.command === 'goal_resume') {
      const authorize = () => {
        const current = this.configuration();
        if (!Object.hasOwn(current.targets ?? {}, message.threadId)) return false;
        if (message.command === 'goal_get') return true;
        const latest = this.events.snapshot(message.threadId);
        return current.enabled === true && current.targets[message.threadId].enabled !== false
          && latest?.turnId === message.turnId && latest.status === 'failed';
      };
      const request = (method, params) => new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Error('Goal request timeout')), 20000);
        try { this.router.bridgeRequest({ id: message.id, method, params }, response => {
          clearTimeout(timer);
          if (response.error) reject(Error('Goal request failed')); else resolve(response.result);
        }, authorize); } catch (error) { clearTimeout(timer); reject(error); }
      });
      try {
        const before = await request('thread/goal/get', { threadId: message.threadId });
        if (!Object.hasOwn(before ?? {}, 'goal')) return denied();
        if (message.command === 'goal_get') {
          const goal = before.goal;
          if (goal !== null && (goal?.threadId !== message.threadId || typeof goal.status !== 'string')) return denied();
          reply({ id: message.id, result: { goal: goal === null ? null : { threadId: goal.threadId, status: goal.status } } });
          return;
        }
        if (before.goal?.threadId !== message.threadId
          || !['paused', 'blocked', 'usageLimited', 'active'].includes(before.goal.status)
          || await this.ordinaryUsageAllowed() !== true || !authorize()) return denied();
        const result = await request('thread/goal/set', { threadId: message.threadId, status: 'active', origin: 'user' });
        if (result?.goal?.threadId !== message.threadId || result.goal.status !== 'active') return denied();
        reply({ id: message.id, result: { goal: { threadId: message.threadId, status: 'active' } } });
      } catch { denied(); }
      return;
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
