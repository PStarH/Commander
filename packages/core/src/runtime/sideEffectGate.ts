/**
 * SideEffectGate — Architecture V2 mandatory PEP for every external effect.
 *
 * Invariants:
 *   1. No tool/provider side effect without a valid ATR RunHandle.
 *   2. No side effect without a PolicyDecision (allow | require_approval).
 *   3. No side effect without scheduleAction (idempotency + ledger).
 *   4. Production fail-closed: never silently bypass ATR.
 *
 * Development may set COMMANDER_ATR_SOFT_BYPASS=1 to allow legacy paths
 * during strangler migration; that flag is ignored when NODE_ENV=production.
 */

import { createHash } from 'node:crypto';
import { getExecutionScheduler, type RunHandle, type ScheduleActionResult } from '../atr/scheduler';
import {
  PolicyHook,
  buildPolicyInput,
  decisionDenies,
  decisionRequiresApproval,
  type PolicyDecision,
  type PolicyHookOptions,
} from '../atr/policy';
import {
  SqliteInteractionStore,
  generateInteractionId,
  type DurableInteractionStore,
} from '../atr/durableInteractionStore';
import { getGlobalLogger } from '../logging';
import {
  isEffectBrokerCompatEnabled,
  requireEffectBrokerCompatAudit,
} from '../security/effectBroker';

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
  compensable: boolean;
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

function softBypassAllowed(failClosed: boolean): boolean {
  if (failClosed) return false;
  const compat = isEffectBrokerCompatEnabled();
  if (!compat) return false;
  requireEffectBrokerCompatAudit();
  return true;
}

function softAllowDecision(runId: string): PolicyDecision {
  return {
    effect: 'allow',
    reason: 'COMMANDER_ATR_SOFT_BYPASS',
    decisionPath: ['soft_bypass'],
    matchedRule: 'soft_bypass',
    riskScore: 0,
    budget: {
      tokensUsed: 0,
      tokensBudget: 0,
      actionsUsed: 0,
      actionsBudget: 0,
      estimatedCostUsd: 0,
    },
    latencyMs: 0,
    cached: false,
    cacheable: false,
    decisionId: 'soft_bypass',
    packVersion: 0,
    packName: 'soft_bypass',
    tenantId: null,
    runId,
  };
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
      if (softBypassAllowed(this.failClosed)) {
        getGlobalLogger().warn(
          'SideEffectGate',
          'SOFT BYPASS: no RunHandle — effect proceeds without ATR (dev only)',
          { toolName: req.toolName },
        );
        return {
          replayed: false,
          actionId: `bypass:${req.stepId}`,
          decision: softAllowDecision('unknown'),
          decisionId: 'soft_bypass',
        };
      }
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

    const input = buildPolicyInput({
      scheduler,
      runId: handle.runId,
      phase: 'tool',
      callSite: 'agent',
      tool: {
        name: req.toolName,
        externalSystem: req.externalSystem,
        riskLevel: req.compensable ? 'high' : 'medium',
        destructive: req.compensable,
        isReadOnly: !req.compensable,
        isIdempotent: true,
        category: 'unknown',
      },
      args: req.args,
    });

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
        compensable: req.compensable,
        tags: [...(req.tags ?? []), 'side_effect_gate', `decision:${id}`],
        description: req.description,
        tenantId: req.tenantId ?? handle.tenantId,
      });
    } catch (err) {
      if (softBypassAllowed(this.failClosed)) {
        getGlobalLogger().warn('SideEffectGate', 'SOFT BYPASS: scheduleAction threw', {
          toolName: req.toolName,
          error: (err as Error).message,
        });
        return {
          replayed: false,
          actionId: `bypass-err:${req.stepId}`,
          decision,
          decisionId: id,
        };
      }
      throw new SideEffectGateError(
        'SCHEDULE_FAILED',
        `scheduleAction failed for "${req.toolName}": ${(err as Error).message}`,
        decision,
      );
    }

    if (!scheduleResult) {
      if (softBypassAllowed(this.failClosed)) {
        return {
          replayed: false,
          actionId: `bypass-null:${req.stepId}`,
          decision,
          decisionId: id,
        };
      }
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
