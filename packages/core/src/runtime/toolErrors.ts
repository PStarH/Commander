/**
 * ATR tool errors stay name-based instead of relying on `instanceof`.
 *
 * Why: cross-serialization boundaries erase prototype chains. Inngest has the
 * same gotcha with `step.run` payloads: once an error is serialized and later
 * deserialized, `instanceof` checks can fail because the original prototype is
 * gone. Commander’s saga journal does the same thing via the state checkpointer:
 * errors are persisted across restarts and may be re-thrown later, so the
 * durable discriminator must be the serialized `name` field, not class identity.
 */

export interface ToolNotFoundErrorProps {
  toolName: string;
  availableTools: string[];
}

export class ToolNotFoundError extends Error {
  readonly name = 'ToolNotFoundError';
  readonly toolName: string;
  readonly availableTools: string[];

  constructor(props: ToolNotFoundErrorProps) {
    super(`Tool "${props.toolName}" was not found. Available tools: ${props.availableTools.join(', ') || 'none'}`);
    this.toolName = props.toolName;
    this.availableTools = [...props.availableTools];
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface ToolTimeoutErrorProps {
  toolName: string;
  timeoutMs: number;
  elapsedMs: number;
}

export class ToolTimeoutError extends Error {
  readonly name = 'ToolTimeoutError';
  readonly toolName: string;
  readonly timeoutMs: number;
  readonly elapsedMs: number;

  constructor(props: ToolTimeoutErrorProps) {
    super(`Tool "${props.toolName}" timed out after ${props.elapsedMs}ms (limit: ${props.timeoutMs}ms)`);
    this.toolName = props.toolName;
    this.timeoutMs = props.timeoutMs;
    this.elapsedMs = props.elapsedMs;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface ToolCompensationErrorProps {
  actionId: string;
  toolName: string;
  cause: string;
}

export class ToolCompensationError extends Error {
  readonly name = 'ToolCompensationError';
  readonly actionId: string;
  readonly toolName: string;
  readonly cause: string;

  constructor(props: ToolCompensationErrorProps) {
    super(`Compensation failed for tool "${props.toolName}" (action ${props.actionId}): ${props.cause}`);
    this.actionId = props.actionId;
    this.toolName = props.toolName;
    this.cause = props.cause;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface ToolPolicyDeniedErrorProps {
  toolName: string;
  args: Record<string, unknown>;
  reason: string;
  policyRuleId: string;
}

export class ToolPolicyDeniedError extends Error {
  readonly name = 'ToolPolicyDeniedError';
  readonly toolName: string;
  readonly args: Record<string, unknown>;
  readonly reason: string;
  readonly policyRuleId: string;

  constructor(props: ToolPolicyDeniedErrorProps) {
    super(`Policy denied tool "${props.toolName}" by rule ${props.policyRuleId}: ${props.reason}`);
    this.toolName = props.toolName;
    this.args = { ...props.args };
    this.reason = props.reason;
    this.policyRuleId = props.policyRuleId;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface ToolIdempotencyConflictErrorProps {
  idempotencyKey: string;
  existingStatusCode: number;
}

export class ToolIdempotencyConflictError extends Error {
  readonly name = 'ToolIdempotencyConflictError';
  readonly idempotencyKey: string;
  readonly existingStatusCode: number;

  constructor(props: ToolIdempotencyConflictErrorProps) {
    super(`Idempotency conflict for key "${props.idempotencyKey}" (existing status: ${props.existingStatusCode})`);
    this.idempotencyKey = props.idempotencyKey;
    this.existingStatusCode = props.existingStatusCode;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function getErrorName(err: unknown): string {
  return err instanceof Error ? err.name : 'UnknownError';
}

export function isToolError(err: unknown, expectedName: string): boolean {
  return getErrorName(err) === expectedName;
}

/*
Saga usage example:

try {
  await compensate(action);
} catch (err) {
  if (isToolError(err, 'ToolCompensationError')) {
    // Retry if the failure looks transient; abort if the journal already
    // recorded repeated attempts or the cause is deterministic.
  } else {
    // Treat as an unexpected fatal failure and abort the saga.
  }
}
*/
