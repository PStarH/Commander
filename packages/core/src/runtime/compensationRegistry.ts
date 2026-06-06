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
}

export type CompensationHandler = (
  action: CompensableAction,
) => Promise<{ success: boolean; error?: string }>;

export class CompensationRegistry {
  private handlers = new Map<string, CompensationHandler>();
  private pendingActions = new Map<string, CompensableAction>();
  private compensationAttempts = new Map<string, number>();
  private compensated = new Set<string>();
  private observability?: {
    onSuccess?: (action: CompensableAction) => void;
    onFailed?: (action: CompensableAction, err: string) => void;
    onExhausted?: (action: CompensableAction, err: string) => void;
  };

  register(toolName: string, handler: CompensationHandler): void {
    this.handlers.set(toolName, handler);
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

  /** Compensate ALL pending actions (in reverse order, max 3 attempts each) */
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
        this.pendingActions.delete(id);
        this.compensationAttempts.delete(id);
        failed++;
        const errMsg = `Compensation exhausted after 3 attempts: ${action.toolName}`;
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

  private addToCompensated(actionId: string): void {
    this.compensated.add(actionId);
    // Cap at 1000 entries — drop oldest to prevent unbounded growth in long sessions
    if (this.compensated.size > 1000) {
      const first = this.compensated.values().next().value;
      if (first) this.compensated.delete(first);
    }
  }

  getPendingCount(): number { return this.pendingActions.size; }
  getCompensatedCount(): number { return this.compensated.size; }
  clear(): void {
    this.pendingActions.clear();
    this.compensated.clear();
    this.compensationAttempts.clear();
  }
}
