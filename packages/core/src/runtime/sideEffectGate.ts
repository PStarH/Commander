/**
 * SideEffectGate — Architecture V2 mandatory PEP for every external effect.
 *
 * Invariants:
 *   1. No tool/provider side effect without a valid ATR RunHandle.
 *   2. No side effect without a PolicyDecision (allow | require_approval).
 *   3. No side effect without scheduleAction (idempotency + ledger).
 *   4. Production fail-closed: never silently bypass ATR.
 *
 * WS2 §9: the soft bypass and compat shim are removed. This gate is now a
 * fail-closed ATR/policy PEP. Full convergence to delegate through the unified
 * EffectBroker.admit/execute is deferred to the StepExecutor redirect phase.
 */

import { createHash } from 'node:crypto';
import {
  getExecutionScheduler,
  type ExecutionScheduler,
  type RunHandle,
  type ScheduleActionResult,
} from '../atr/scheduler';
import {
  PolicyHook,
  buildPolicyInput,
  decisionDenies,
  decisionRequiresApproval,
  type PolicyDecision,
  type PolicyHookOptions,
  type PolicyInput,
} from '../atr/policy';
import type { ToolEffectClassification } from './runtimeHelpers';
import {
  SqliteInteractionStore,
  generateInteractionId,
  type DurableInteractionStore,
} from '../atr/durableInteractionStore';

export class SideEffectGateError extends Error {
  readonly code:
    | 'NO_RUN_HANDLE'
    | 'POLICY_DENIED'
    | 'POLICY_REQUIRES_APPROVAL'
    | 'SCHEDULE_FAILED'
    | 'ATR_REQUIRED';

  constructor(
    code: SideEffectGateError['code'],
    message: string,
    readonly decision?: PolicyDecision,
    readonly interactionId?: string,
  ) {
    super(message);
    this.name = 'SideEffectGateError';
    this.code = code;
  }
}

export interface SideEffectRequest {
  runHandle: RunHandle | null | undefined;
  toolName: string;
  externalSystem: string;
  args: Record<string, unknown>;
  /** Tool call / step id for idempotency. */
  stepId: string;
  effect: ToolEffectClassification;
  tenantId?: string;
  tags?: string[];
  description?: string;
}

export interface SideEffectAdmission {
  replayed: boolean;
  actionId: string;
  cachedResult?: string;
  cachedError?: string;
  decision: PolicyDecision;
  decisionId: string;
}

export interface SideEffectGateOptions {
  policy?: PolicyHookOptions;
  /** Force fail-closed even outside production. */
  failClosed?: boolean;
  /** Durable store for approval interactions. Defaults to an in-memory SQLite store. */
  interactionStore?: DurableInteractionStore;
}

export function buildSideEffectPolicyInput(
  req: SideEffectRequest & { runHandle: RunHandle },
  scheduler: ExecutionScheduler,
): PolicyInput {
  return buildPolicyInput({
    scheduler,
    runId: req.runHandle.runId,
    phase: 'tool',
    callSite: 'agent',
    tool: {
      name: req.toolName,
      externalSystem: req.externalSystem,
      riskLevel: req.effect.riskLevel,
      destructive: req.effect.destructive,
      isReadOnly: req.effect.isReadOnly,
      isIdempotent: true,
      category: req.effect.category,
    },
    args: req.args,
  });
}

export class SideEffectGate {
  private readonly policy: PolicyHook;
  private readonly failClosed: boolean;
  private readonly interactionStore: DurableInteractionStore;

  constructor(opts: SideEffectGateOptions = {}) {
    this.policy = new PolicyHook(opts.policy);
    // Fail-closed in production or in V2 mode unless explicitly overridden.
    const productionOrV2 =
      process.env.NODE_ENV === 'production' || process.env.COMMANDER_V2_MODE === '1';
    this.failClosed = opts.failClosed ?? productionOrV2;
    this.interactionStore = opts.interactionStore ?? new SqliteInteractionStore();
  }

  /**
   * Admit an external effect: policy PDP → ATR scheduleAction.
   */
  async admit(req: SideEffectRequest): Promise<SideEffectAdmission> {
    if (!req.runHandle) {
      // WS2 §9: soft bypass removed — always fail closed.
      throw new SideEffectGateError(
        'NO_RUN_HANDLE',
        `Side effect "${req.toolName}" rejected: no ATR RunHandle (Architecture V2 invariant)`,
      );
    }

    const handle = req.runHandle;
    const scheduler = getExecutionScheduler();

    const idempotencyKey = createHash('sha256')
      .update(
        JSON.stringify({
          runId: handle.runId,
          stepId: req.stepId,
          toolName: req.toolName,
          args: req.args,
          intentHash: handle.intentHash,
        }),
      )
      .digest('hex');

    const input = buildSideEffectPolicyInput({ ...req, runHandle: handle }, scheduler);

    const decision = this.policy.evaluate(input);
    const id = decision.decisionId;

    if (decisionDenies(decision)) {
      throw new SideEffectGateError(
        'POLICY_DENIED',
        `Side effect "${req.toolName}" denied by policy` +
          (decision.matchedRule ? ` (rule=${decision.matchedRule})` : ''),
        decision,
      );
    }

    if (decisionRequiresApproval(decision)) {
      const interaction = await this.interactionStore.create({
        interactionId: generateInteractionId(),
        actionId: `pending:${req.stepId}`,
        runId: handle.runId,
        tenantId: req.tenantId ?? handle.tenantId ?? 'unknown',
        toolName: req.toolName,
        externalRequestHash: idempotencyKey,
        status: 'pending',
        createdAt: new Date().toISOString(),
      });
      throw new SideEffectGateError(
        'POLICY_REQUIRES_APPROVAL',
        `Side effect "${req.toolName}" requires human approval (interactionId=${interaction.interactionId})`,
        decision,
        interaction.interactionId,
      );
    }

    let scheduleResult: ScheduleActionResult | null;
    try {
      scheduleResult = scheduler.scheduleAction({
        runId: handle.runId,
        leaseToken: handle.leaseToken,
        fencingEpoch: handle.fencingEpoch,
        toolName: req.toolName,
        externalSystem: req.externalSystem,
        args: req.args,
        idempotencyKey,
        compensable: req.effect.compensable,
        tags: [...(req.tags ?? []), 'side_effect_gate', `decision:${id}`],
        description: req.description,
        tenantId: req.tenantId ?? handle.tenantId,
      });
    } catch (err) {
      // WS2 §9: soft bypass removed — scheduleAction failures always throw.
      throw new SideEffectGateError(
        'SCHEDULE_FAILED',
        `scheduleAction failed for "${req.toolName}": ${(err as Error).message}`,
        decision,
      );
    }

    if (!scheduleResult) {
      // WS2 §9: soft bypass removed — null scheduleResult always throws.
      throw new SideEffectGateError(
        'SCHEDULE_FAILED',
        `scheduleAction rejected "${req.toolName}" (fenced or ledger error)`,
        decision,
      );
    }

    return {
      replayed: scheduleResult.replayed,
      actionId: scheduleResult.actionId,
      cachedResult: scheduleResult.cachedResult,
      cachedError: scheduleResult.cachedError,
      decision,
      decisionId: id,
    };
  }
}

let gateSingleton: SideEffectGate | null = null;

export function getSideEffectGate(): SideEffectGate {
  if (!gateSingleton) {
    gateSingleton = new SideEffectGate();
  }
  return gateSingleton;
}

export function resetSideEffectGate(): void {
  gateSingleton = null;
}

export function setSideEffectGate(gate: SideEffectGate): void {
  gateSingleton = gate;
}
