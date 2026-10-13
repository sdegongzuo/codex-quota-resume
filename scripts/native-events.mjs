// Retain only state metadata for explicitly authorized targets; never store item bodies.
export class NativeEvents {
  constructor({ authorized, now = () => Date.now() }) {
    this.authorized = authorized;
    this.now = now;
    this.targets = new Map();
    this.compactions = new Map();
    this.sequence = 0;
  }

  beginCompaction(threadId, operationId, baselineTurnId) {
    const before = this.snapshot(threadId);
    const previous = this.compactions.get(threadId);
    if (!before?.safeBoundary || before.turnId !== baselineTurnId
      || (previous && ['awaiting_turn', 'running'].includes(previous.status))) return false;
    this.compactions.set(threadId, { operationId, baselineTurnId, status: 'awaiting_turn',
      reservedSequence: this.sequence });
    return true;
  }

  invalidateCompaction(threadId, operationId) {
    const receipt = this.compactions.get(threadId);
    if (receipt && (operationId === undefined || receipt.operationId === operationId)) receipt.status = 'uncertain';
  }

  observeRendererMessage(message) {
    // A concurrent frontend mutation makes the next backend turn ambiguous.
    if (['turn/start', 'turn/steer', 'turn/interrupt', 'thread/compact/start', 'thread/resume',
      'thread/revert', 'thread/rollback', 'review/start'].includes(message?.method)) {
      this.invalidateCompaction(message.params?.threadId);
    }
  }

  observe(message) {
    const method = message?.method;
    if (!['turn/started', 'turn/completed', 'item/started', 'item/completed', 'thread/tokenUsage/updated'].includes(method)) return;
    const p = message?.params;
    if (!p || typeof p.threadId !== 'string' || this.authorized(p.threadId) !== true) return;
    const turnId = method.startsWith('turn/') ? p.turn?.id : p.turnId;
    if (typeof turnId !== 'string' || !turnId) return;
    const sequence = ++this.sequence;
    const receipt = this.compactions.get(p.threadId);
    let state = this.targets.get(p.threadId);
    if (method === 'turn/started') {
      if (receipt?.status === 'awaiting_turn' && turnId !== receipt.baselineTurnId) {
        Object.assign(receipt, { turnId, status: 'running' });
      } else if (receipt && ['awaiting_turn', 'running'].includes(receipt.status)) {
        receipt.status = 'uncertain';
      }
      state = { turnId, status: 'inProgress', activeItems: new Map(), observedAt: this.now() };
      this.targets.set(p.threadId, state);
      return;
    }
    // Do not infer ownership or safety from a usage event for an unknown turn.
    if (!state || state.turnId !== turnId) return;
    state.observedAt = this.now();
    if (method === 'turn/completed') {
      if (!['completed', 'interrupted', 'failed'].includes(p.turn?.status)) return;
      state.status = p.turn.status;
      state.activeItems.clear();
    } else if (method === 'item/started' || method === 'item/completed') {
      if (typeof p.item?.id !== 'string' || typeof p.item?.type !== 'string') return;
      if (method === 'item/started') {
        state.activeItems.set(p.item.id, p.item.type);
        if (p.item.type === 'contextCompaction') {
          state.compactionStartedAt = this.now();
          state.compactionStartSequence = sequence;
          state.usage = null;
          if (receipt?.status === 'running' && receipt.turnId === turnId && !receipt.itemId) {
            Object.assign(receipt, { itemId: p.item.id, startedSequence: sequence });
          } else if (receipt?.status === 'running') receipt.status = 'uncertain';
        } else if (receipt?.status === 'running') receipt.status = 'uncertain';
      }
      else {
        state.activeItems.delete(p.item.id);
        if (p.item.type === 'contextCompaction') {
          state.compactionCompletedAt = this.now();
          // v0.162 recomputes usage after installing history, before item/completed.
          // Only usage observed after the matching item/started can survive completion.
          if (!state.compactionStartSequence || state.usageSequence <= state.compactionStartSequence) state.usage = null;
          if (receipt?.status === 'running' && receipt.turnId === turnId && receipt.itemId === p.item.id) {
            Object.assign(receipt, { status: 'completed', completedSequence: sequence });
          }
        }
      }
    } else {
      const tokens = p.tokenUsage?.last?.totalTokens;
      const windowTokens = p.tokenUsage?.modelContextWindow;
      if (!Number.isSafeInteger(tokens) || tokens < 0 || !Number.isSafeInteger(windowTokens) || windowTokens <= 0) return;
      state.usage = { activeTokens: tokens, windowTokens, observedAt: this.now() };
      state.usageSequence = sequence;
    }
  }

  snapshot(threadId) {
    if (this.authorized(threadId) !== true) return null;
    const state = this.targets.get(threadId);
    if (!state) return null;
    return { turnId: state.turnId, status: state.status, observedAt: state.observedAt,
      activeItemCount: state.activeItems.size,
      safeBoundary: state.status === 'completed' || state.status === 'interrupted' || state.status === 'failed',
      compactionCompletedAt: state.compactionCompletedAt,
      compactionStartedAt: state.compactionStartedAt,
      compactionReceipt: this.compactions.has(threadId) ? { ...this.compactions.get(threadId) } : null,
      usageSequence: state.usageSequence,
      usage: state.usage ? { ...state.usage } : null };
  }
}
