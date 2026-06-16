export interface CompensableAction {
  /** Unique identifier for this specific action instance */
  actionId: string;
  /** Tool name that produced the side-effect */
  toolName: string;
  /** Arguments used for the action */
  args: Record<string, unknown>;
  /** Short description of what side-effect to undo */
  description: string;
  /** Tags for matching compensation handlers */
  tags: string[];
  /** Run ID for cross-process correlation (populated by agentRuntime) */
  runId?: string;
  /** Agent ID for cross-process correlation (populated by agentRuntime) */
  agentId?: string;
}

export type CompensationHandler = (
  action: CompensableAction,
) => Promise<{ success: boolean; error?: string }>;

import type { CompensationQueue } from '../atr/compensationQueue';

export class CompensationRegistry {
  private handlers = new Map<string, CompensationHandler>();
  private pendingActions = new Map<string, CompensableAction>();
  private compensationAttempts = new Map<string, number>();
  private compensated = new Set<string>();
  private queue?: CompensationQueue;
  private observability?: {
    onSuccess?: (action: CompensableAction) => void;
    onFailed?: (action: CompensableAction, err: string) => void;
    onExhausted?: (action: CompensableAction, err: string) => void;
  };

  register(toolName: string, handler: CompensationHandler): void {
    this.handlers.set(toolName, handler);
  }

  /** Wire the durable compensation queue for cross-process crash-safe retry.
   *  Without this, exhausted compensations are dropped after 3 in-memory attempts.
   *  With the queue, exhausted items are persisted to SQLite with exponential backoff
   *  and can be recovered by a new process after a crash. */
  setCompensationQueue(queue: CompensationQueue): void {
    this.queue = queue;
  }

  setObservability(obs: {
    onSuccess?: (action: CompensableAction) => void;
    onFailed?: (action: CompensableAction, err: string) => void;
    onExhausted?: (action: CompensableAction, err: string) => void;
  }): void {
    this.observability = obs;
  }

  recordAction(action: CompensableAction): void {
    this.pendingActions.set(action.actionId, action);
  }

  /** Compensate a single action by its actionId */
  async compensate(actionId: string): Promise<{ success: boolean; error?: string }> {
    const action = this.pendingActions.get(actionId);
    if (!action) return { success: true };
    const handler = this.handlers.get(action.toolName);
    if (!handler) {
      this.pendingActions.delete(actionId);
      this.addToCompensated(actionId);
      return { success: true };
    }
    try {
      const result = await handler(action);
      if (result.success) {
        this.pendingActions.delete(actionId);
        this.compensationAttempts.delete(actionId);
        this.addToCompensated(actionId);
        try { this.observability?.onSuccess?.(action); } catch { /* best-effort */ }
      } else {
        try { this.observability?.onFailed?.(action, result.error ?? 'unknown'); } catch { /* best-effort */ }
      }
      return result;
    } catch (err) {
      const errStr = String(err);
      try { this.observability?.onFailed?.(action, errStr); } catch { /* best-effort */ }
      return { success: false, error: errStr };
    }
  }

  /** Compensate ALL pending actions (in reverse order, max 3 attempts each).
   *  Exhausted items are enqueued to the durable CompensationQueue if wired. */
  async compensateAll(): Promise<{ succeeded: number; failed: number; errors: string[] }> {
    const ids = Array.from(this.pendingActions.keys()).reverse();
    let succeeded = 0;
    let failed = 0;
    const errors: string[] = [];
    for (const id of ids) {
      const action = this.pendingActions.get(id);
      if (!action) continue;
      const attempts = this.compensationAttempts.get(id) ?? 0;
      if (attempts >= 3) {
        // Enqueue to durable queue for cross-process retry instead of dropping
        if (this.queue && action.runId) {
          try {
            this.queue.enqueue({
              id: action.actionId,
              runId: action.runId,
              agentId: action.agentId,
              toolName: action.toolName,
              args: action.args,
              compensationHandlerKey: action.toolName,
              maxAttempts: 10,
            });
          } catch { /* queue down; proceed with drop */ }
        }
        this.pendingActions.delete(id);
        this.compensationAttempts.delete(id);
        failed++;
        const errMsg = `Compensation exhausted after 3 attempts: ${action.toolName}${this.queue ? ' (queued for durable retry)' : ''}`;
        errors.push(errMsg);
        try { this.observability?.onExhausted?.(action, errMsg); } catch { /* best-effort */ }
        continue;
      }
      this.compensationAttempts.set(id, attempts + 1);
      const result = await this.compensate(id);
      if (result.success) { this.compensationAttempts.delete(id); succeeded++; }
      else { failed++; if (result.error) errors.push(result.error); }
    }
    return { succeeded, failed, errors };
  }

  /** Process due items from the durable compensation queue.
   *  Claims items one at a time and retries the registered handler.
   *  Call periodically (e.g., on process startup, or every N minutes).
   *  Returns the number of items processed. */
  async processQueue(): Promise<number> {
    if (!this.queue) return 0;
    let processed = 0;
    const maxBatch = 10; // prevent unbounded processing in one call
    for (let i = 0; i < maxBatch; i++) {
      const item = this.queue.claimNext();
      if (!item) break;

      const handler = this.handlers.get(item.compensationHandlerKey);
      if (!handler) {
        this.queue.markEscalated(item.id, `No handler registered for "${item.compensationHandlerKey}"`);
        processed++;
        continue;
      }

      try {
        const args = JSON.parse(item.args) as Record<string, unknown>;
        const action: CompensableAction = {
          actionId: item.id,
          toolName: item.toolName,
          args: args as Record<string, unknown>,
          description: `[queue:${item.runId}] ${item.toolName}`,
          tags: ['compensation_queue', item.toolName],
          runId: item.runId,
          agentId: item.agentId,
        };
        const result = await handler(action);
        if (result.success) {
          this.queue.markCompleted(item.id);
        } else {
          const outcome = this.queue.markFailed(item.id, result.error ?? 'unknown', item.attemptCount);
          if (outcome === 'escalated') {
            try { this.observability?.onExhausted?.(action, `Queue compensation exhausted: ${result.error}`); } catch { /* best-effort */ }
          }
        }
      } catch (err) {
        const errStr = err instanceof Error ? err.message : String(err);
        const outcome = this.queue.markFailed(item.id, errStr, item.attemptCount);
        if (outcome === 'escalated') {
          try { this.observability?.onExhausted?.({ actionId: item.id, toolName: item.toolName, args: {}, description: '', tags: [] }, `Queue compensation error: ${errStr}`); } catch { /* best-effort */ }
        }
      }
      processed++;
    }
    return processed;
  }

  private addToCompensated(actionId: string): void {
    this.compensated.add(actionId);
    // Cap at 1000 entries — drop oldest to prevent unbounded growth in long sessions
    if (this.compensated.size > 1000) {
      const first = this.compensated.values().next().value;
      if (first) this.compensated.delete(first);
    }
  }

  /** Look up a compensation handler by tool name. Returns undefined if not registered. */
  getHandler(toolName: string): CompensationHandler | undefined {
    return this.handlers.get(toolName);
  }

  getPendingCount(): number { return this.pendingActions.size; }
  getCompensatedCount(): number { return this.compensated.size; }
  clear(): void {
    this.pendingActions.clear();
    this.compensated.clear();
    this.compensationAttempts.clear();
  }
}
