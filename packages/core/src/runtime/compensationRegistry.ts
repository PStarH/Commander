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
  private compensated = new Set<string>();

  register(toolName: string, handler: CompensationHandler): void {
    this.handlers.set(toolName, handler);
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
      this.compensated.add(actionId);
      return { success: true };
    }
    try {
      const result = await handler(action);
      if (result.success) {
        this.pendingActions.delete(actionId);
        this.compensated.add(actionId);
      }
      return result;
    } catch (err) {
      return { success: false, error: String(err) };
    }
  }

  /** Compensate ALL pending actions (in reverse order) */
  async compensateAll(): Promise<{ succeeded: number; failed: number; errors: string[] }> {
    const ids = Array.from(this.pendingActions.keys()).reverse();
    let succeeded = 0;
    let failed = 0;
    const errors: string[] = [];
    for (const id of ids) {
      const result = await this.compensate(id);
      if (result.success) succeeded++;
      else { failed++; if (result.error) errors.push(result.error); }
    }
    return { succeeded, failed, errors };
  }

  getPendingCount(): number { return this.pendingActions.size; }
  getCompensatedCount(): number { return this.compensated.size; }
  clear(): void {
    this.pendingActions.clear();
    this.compensated.clear();
  }
}
