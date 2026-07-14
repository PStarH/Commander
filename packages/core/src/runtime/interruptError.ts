/**
 * Thrown by tools to request human input mid-execution.
 * The runtime catches this and returns 'waiting_for_human' (HITL) or
 * 'interrupted' (generic pause). On resume, the human's input becomes
 * the tool's return value via AgentExecutionContext.resumeWith.
 */
export class InterruptError extends Error {
  readonly reason: string;
  readonly value: unknown;
  /** When true, runtime maps this to durable waiting_for_human + ATR PAUSED. */
  readonly humanInputRequired: boolean;

  constructor(reason: string, value?: unknown, humanInputRequired = false) {
    super(`Interrupt: ${reason}`);
    this.name = 'InterruptError';
    this.reason = reason;
    this.value = value ?? reason;
    this.humanInputRequired = humanInputRequired;
  }
}

/**
 * First-class HITL signal. Prefer this over InterruptError for human waits
 * so the kernel can persist WAITING_FOR_HUMAN / PAUSED correctly.
 */
export class HumanInteractionRequired extends InterruptError {
  constructor(prompt: string, value?: unknown) {
    super(prompt, value ?? { prompt }, true);
    this.name = 'HumanInteractionRequired';
  }
}
