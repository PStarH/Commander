# RFC: Agent Transaction Runtime (ATR) Layer

This document defines the Agent Transaction Runtime (ATR) layer for Commander. ATR transforms Commander from a standard agent framework into a policy-aware saga runtime, ensuring that complex multi-step agent actions remain reliable, reversible, and compliant with organizational safety policies.

## 1. Saga API

The Saga API provides a mechanism for coordinating multi-step tool executions that must either succeed entirely or be rolled back upon failure. It uses a Temporal-inspired functional approach rather than a declarative DSL.

### TypeScript Interfaces

```typescript
export interface IntentRecord {
  readonly id: string;
  readonly runId: string;
  readonly stepIndex: number;
  readonly toolName: string;
  readonly arguments: Record<string, unknown>;
  readonly timestamp: string;
  readonly status: 'pending' | 'completed' | 'failed' | 'compensated';
}

export interface Saga {
  readonly id: string;
  readonly runId: string;
  readonly state: 'active' | 'committing' | 'rolling_back' | 'completed' | 'aborted';
  readonly intents: IntentRecord[];
}

export interface SagaCoordinator {
  /** Begin a new saga context for the current run */
  begin(runId: string): Promise<Saga>;

  /** 
   * Execute a step within the saga. 
   * Records intent before execution and manages compensation registration.
   */
  step<T>(
    sagaId: string, 
    toolName: string, 
    args: Record<string, unknown>,
    execute: (args: Record<string, unknown>) => Promise<T>
  ): Promise<T>;

  /** Commit the saga, marking all actions as final */
  commit(sagaId: string): Promise<void>;

  /** 
   * Roll back the saga by executing compensations in LIFO order.
   * Triggered automatically on step failure or manually.
   */
  rollback(sagaId: string): Promise<void>;
}
```

### Design Rationale

The Saga API builds upon the existing `compensationRegistry.ts`. It introduces an "Intent-First" pattern where every tool call is recorded as a `IntentRecord` before execution begins. This ensures that even if the process crashes mid-execution, the `stateCheckpointer.ts` can recover the intent and determine if a rollback is necessary.

We use LIFO (Last-In, First-Out) reversal for compensations, matching the Temporal pattern. Each compensation is wrapped in its own try/catch block to ensure one failed compensation doesn't block the rest of the rollback chain, although it will be recorded in the `DeadLetterQueue`.

Idempotency is enforced using the Stripe-inspired key shape: `atp:${runId}:${stepIndex}:${toolName}:${argHash.slice(0,12)}`.

### Worked Example: PR Deployment Flow

```typescript
async function deployFeature(saga: SagaCoordinator, runId: string) {
  const s = await saga.begin(runId);
  try {
    // Step 1: GitHub PR
    const pr = await saga.step(s.id, 'github.create_pr', { title: 'Add ATR' }, async (a) => {
      return await github.create_pr(a);
    });

    // Step 2: Jira Issue
    await saga.step(s.id, 'jira.create_issue', { summary: `Deploy PR ${pr.id}` }, async (a) => {
      return await jira.create_issue(a);
    });

    // Step 3: Slack Notification
    await saga.step(s.id, 'slack.send_message', { text: 'Starting deploy' }, async (a) => {
      return await slack.send_message(a);
    });

    // Step 4: DB Update
    await saga.step(s.id, 'database.update', { status: 'deploying' }, async (a) => {
      return await db.update(a);
    });

    // Step 5: Terraform Apply (Fails)
    await saga.step(s.id, 'terraform.apply', { plan: 'prod' }, async (a) => {
      throw new Error('Cloud provider timeout');
    });

    await saga.commit(s.id);
  } catch (err) {
    await saga.rollback(s.id);
    // Rollback order: db.update (undo) -> slack.send_message (undo) -> jira (delete) -> github (close PR)
  }
}
```

### Open Questions

1. Should we support "nested sagas" where a sub-agent starts its own transaction within a parent saga?
2. How do we handle "zombie" sagas where the coordinator process dies and never calls commit or rollback?

## 2. Policy DSL v0

Policy DSL v0 allows defining safety rules that govern tool execution. It integrates into the `beforeToolResolve` hook in `pluginManager.ts` to block unsafe actions before they reach the `toolExecutor.ts`.

### TypeScript Interfaces

```typescript
export type PolicyEffect = 'allow' | 'deny' | 'require_approval';

export interface PolicyContext {
  readonly toolName: string;
  readonly args: Record<string, unknown>;
  readonly agentId: string;
  readonly runId: string;
  readonly riskScore: number;
  readonly isMutation: boolean;
  readonly isFirstTimeTool: boolean;
}

export interface PolicyRule {
  readonly id: string;
  readonly description: string;
  readonly when: (ctx: PolicyContext) => boolean;
  readonly then: PolicyEffect;
}

export interface PolicyEngine {
  /** Evaluate current tool call against all registered rules */
  evaluate(ctx: PolicyContext): PolicyEffect;
  
  /** Calculate risk score for a tool call */
  calculateRisk(ctx: Partial<PolicyContext>): number;
}
```

### Design Rationale

The v0 engine is a pure TypeScript rule-based system. While future versions (v1.5) will use OPA WASM for sub-1ms evaluations, v0 focuses on establishing the `PolicyContext` shape.

The risk score formula provides a quantitative basis for `require_approval` effects:
`Risk = 0 (base) + 2 (if mutation) + 3 (if external side effect) + 5 (if touches production) + (cost/100) + 1 (if first-time tool)`.

### Worked Example: Default Rules

```typescript
const defaultRules: PolicyRule[] = [
  {
    id: 'protect-main',
    description: 'Prevent direct commits to main branch',
    when: (ctx) => ctx.toolName === 'github.commit' && ctx.args.branch === 'main',
    then: 'deny'
  },
  {
    id: 'terraform-prod-gate',
    description: 'Require approval for production infrastructure changes',
    when: (ctx) => ctx.toolName === 'terraform.apply' && ctx.args.env === 'prod',
    then: 'require_approval'
  },
  {
    id: 'spending-limit',
    description: 'Gate charges over $1000',
    when: (ctx) => ctx.toolName === 'stripe.charge' && (ctx.args.amount as number) > 100000,
    then: 'require_approval'
  },
  {
    id: 'db-delete-protection',
    description: 'Require approval for database deletions',
    when: (ctx) => ctx.toolName === 'database.delete',
    then: 'require_approval'
  },
  {
    id: 'first-time-tool-gate',
    description: 'Gate usage of tools never seen before in this project',
    when: (ctx) => ctx.isFirstTimeTool,
    then: 'require_approval'
  }
];
```

### Open Questions

1. Should policies be able to modify tool arguments (e.g., forcing a `dryRun: true` flag) instead of just blocking?
2. How do we persist the "first-time tool" state across different agent runs?

## 3. Reversibility Library Schema

The Reversibility Library defines how side effects are undone. It extends the `CompensableAction` pattern with structured manifests that include expiry and irreversibility metadata.

### TypeScript Interfaces

```typescript
export interface CompensationManifest {
  /** Whether the tool action can be undone */
  readonly reversible: boolean;
  
  /** Human-readable description of what will happen during reversal */
  readonly description: string;
  
  /** 
   * The tool and arguments required to undo the action.
   * If reversible is false, this is undefined.
   */
  readonly compensation?: {
    readonly toolName: string;
    readonly args: (originalArgs: Record<string, unknown>) => Record<string, unknown>;
  };
  
  /** Reason why an action cannot be undone */
  readonly irreversibleReason?: string;
  
  /** Optional expiry in seconds after which compensation is no longer possible */
  readonly expirySeconds?: number;
}

export interface ReversibilityLibrary {
  /** Register a manifest for a specific tool */
  register(toolName: string, manifest: CompensationManifest): void;
  
  /** Retrieve manifest for a tool */
  getManifest(toolName: string): CompensationManifest | undefined;
}
```

### Design Rationale

This library provides the "knowledge" used by the `SagaCoordinator`. By separating the manifest from the tool implementation, we can define reversibility for 3rd party tools (like GitHub or Stripe) without modifying their source.

For actions like `sendgrid.send_email`, we explicitly mark them as irreversible. This allows the `SagaCoordinator` to warn the agent or user *before* execution that this step cannot be rolled back.

### Worked Example: Manifests

```typescript
const manifests: Record<string, CompensationManifest> = {
  'github.create_pr': {
    reversible: true,
    description: 'Close the created pull request',
    compensation: {
      toolName: 'github.close_pr',
      args: (orig) => ({ pr_number: orig.pr_number })
    }
  },
  'sendgrid.send_email': {
    reversible: false,
    description: 'Emails cannot be unsent',
    irreversibleReason: 'Email already sent to recipient'
  },
  'stripe.charge': {
    reversible: true,
    description: 'Refund the transaction amount',
    compensation: {
      toolName: 'stripe.refund',
      args: (orig) => ({ charge_id: orig.charge_id })
    },
    expirySeconds: 15552000 // 180 days
  }
};
```

### Open Questions

1. How do we handle "partial" reversibility where only some arguments can be undone?
2. Should we support manual compensation steps where a human must perform the rollback?

## 4. Error Taxonomy

To ensure reliable serialization across distributed boundaries (like Inngest or Temporal), we use a string-based error taxonomy. We avoid `instanceof` checks because class prototypes are often lost during JSON serialization.

### TypeScript Interfaces

```typescript
export abstract class ATRError extends Error {
  /** String identifier for the error type, used instead of instanceof */
  abstract readonly name: string;
  readonly timestamp: string = new Date().toISOString();
  
  constructor(message: string, public readonly context?: Record<string, unknown>) {
    super(message);
  }
}

export class ToolNotFoundError extends ATRError {
  readonly name = 'ToolNotFoundError';
}

export class ToolTimeoutError extends ATRError {
  readonly name = 'ToolTimeoutError';
}

export class ToolCompensationError extends ATRError {
  readonly name = 'ToolCompensationError';
}

export class ToolPolicyDeniedError extends ATRError {
  readonly name = 'ToolPolicyDeniedError';
}

export class ToolIdempotencyConflictError extends ATRError {
  readonly name = 'ToolIdempotencyConflictError';
}
```

### Design Rationale

The Inngest serialization gotcha: Inngest (and many other queue systems) serializes error objects to JSON. Upon retrieval, `err instanceof ToolNotFoundError` will return `false` because the prototype chain is gone. By enforcing a `readonly name` field, we can use `if (err.name === 'ToolPolicyDeniedError')` which is safe across all serialization boundaries.

Each error includes a `context` object to provide structured data (like the failed `toolName` or `policyId`) back to the calling agent.

### Open Questions

1. Should we include a `retryable: boolean` flag in the base `ATRError`?
2. How do we map standard Node.js errors (like `ETIMEDOUT`) into this taxonomy?

## M1 Implementation Order

1. **Error Foundation**: Implement the `Error Taxonomy` in a new `packages/core/src/runtime/errors.ts` file.
2. **Reversibility Registry**: Create the `ReversibilityLibrary` and register manifests for the top 5 most used mutation tools.
3. **Saga Coordinator**: Implement `SagaCoordinator` using the existing `CompensationRegistry` as the underlying storage.
4. **Policy Engine v0**: Implement the `PolicyEngine` and hook it into `pluginManager.ts` using the `beforeToolResolve` hook.
5. **Integration**: Update `agentRuntime.ts` to wrap its tool execution loop in a Saga context.
