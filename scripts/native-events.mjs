// Retain only state metadata for explicitly authorized targets; never store item bodies.
export class NativeEvents {
  constructor({ authorized, now = () => Date.now() }) {
    this.authorized = authorized;
    this.now = now;
    this.targets = new Map();
  }

  observe(message) {
    const method = message?.method;
    if (!['turn/started', 'turn/completed', 'item/started', 'item/completed', 'thread/tokenUsage/updated'].includes(method)) return;
    const p = message?.params;
    if (!p || typeof p.threadId !== 'string' || this.authorized(p.threadId) !== true) return;
    const turnId = method.startsWith('turn/') ? p.turn?.id : p.turnId;
    if (typeof turnId !== 'string' || !turnId) return;
    let state = this.targets.get(p.threadId);
    if (method === 'turn/started') {
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
      if (method === 'item/started') state.activeItems.set(p.item.id, p.item.type);
      else {
        state.activeItems.delete(p.item.id);
        if (p.item.type === 'contextCompaction') {
          state.compactionCompletedAt = this.now();
          state.usage = null; // Pre-compaction usage cannot confirm the result.
        }
      }
    } else {
      const tokens = p.tokenUsage?.last?.totalTokens;
      const windowTokens = p.tokenUsage?.modelContextWindow;
      if (!Number.isSafeInteger(tokens) || tokens < 0 || !Number.isSafeInteger(windowTokens) || windowTokens <= 0) return;
      state.usage = { activeTokens: tokens, windowTokens, observedAt: this.now() };
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
      usage: state.usage ? { ...state.usage } : null };
  }
}
