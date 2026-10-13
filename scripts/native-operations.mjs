// Operation coordinator for an authenticated bridge transport. No text prompt substitutes native RPC.
export class NativeOperations {
  constructor({ request, snapshot, persist, ordinaryUsageAllowed, now = () => Date.now(),
    wait = ms => new Promise(resolve => setTimeout(resolve, ms)), timeoutMs = 120000 }) {
    Object.assign(this, { request, snapshot, persist, ordinaryUsageAllowed, now, wait, timeoutMs });
    this.claims = new Map();
    this.inFlight = new Map();
  }

  perform(operation) {
    const active = this.inFlight.get(operation.requestId);
    if (active) {
      if (active.identity !== JSON.stringify([operation.action, operation.threadId, operation.turnId])) {
        return Promise.reject(Error('Request identity conflict'));
      }
      return active.promise;
    }
    const promise = this.performOnce(operation);
    this.inFlight.set(operation.requestId, { identity: JSON.stringify([operation.action, operation.threadId, operation.turnId]), promise });
    promise.finally(() => this.inFlight.delete(operation.requestId)).catch(() => {});
    return promise;
  }

  async performOnce({ action, threadId, turnId, requestId }) {
    if (!['compact', 'interrupt'].includes(action) || !threadId || !turnId || !requestId) throw Error('Invalid native operation');
    if (this.claims.has(requestId)) {
      const prior = this.claims.get(requestId);
      if (prior.action !== action || prior.threadId !== threadId || prior.turnId !== turnId) throw Error('Request identity conflict');
      return { ...prior };
    }
    const before = await this.snapshot(threadId);
    if (!before || before.turnId !== turnId) return { status: 'target_changed' };
    if (action === 'compact' && (!before.safeBoundary || await this.ordinaryUsageAllowed() !== true)) return { status: 'not_ready' };
    if (action === 'interrupt' && ['completed', 'interrupted', 'failed'].includes(before.status)) return { status: 'already_ended' };
    const claim = { requestId, action, threadId, turnId, status: 'sending', claimedAt: this.now() };
    this.claims.set(requestId, claim);
    // Durability is required before any backend request. Persistence failures cannot send.
    await this.persist({ ...claim });
    try {
      await this.request(action === 'compact' ? 'thread/compact/start' : 'turn/interrupt',
        action === 'compact' ? { threadId } : { threadId, turnId }, { turnId });
      const deadline = this.now() + this.timeoutMs;
      while (this.now() <= deadline) {
        const after = await this.snapshot(threadId);
        if (!after || after.turnId !== turnId) break;
        if (action === 'interrupt' && after.status === 'interrupted') {
          Object.assign(claim, { status: 'completed', observedAt: this.now() }); break;
        }
        if (action === 'compact' && after.compactionCompletedAt > (before.compactionCompletedAt ?? 0)
          && after.usage && after.usage.observedAt >= after.compactionCompletedAt
          && after.usage.observedAt >= claim.claimedAt) {
          Object.assign(claim, { status: 'completed', after: { ...after.usage }, observedAt: this.now() }); break;
        }
        await this.wait(250);
      }
      if (claim.status !== 'completed') claim.status = 'uncertain';
    } catch { claim.status = 'uncertain'; }
    await this.persist({ ...claim });
    return { ...claim };
  }

  restore(records) {
    for (const record of records) {
      if (!record?.requestId || !['compact', 'interrupt'].includes(record.action)) continue;
      this.claims.set(record.requestId, { ...record,
        status: record.status === 'sending' ? 'uncertain' : record.status });
    }
  }
}
