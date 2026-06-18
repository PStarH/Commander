import type { ApprovalRequest, ApprovalDecision, ApprovalSystem } from '../../../sandbox/approval';
import type { PolicyHook } from './scheduler';
import type { PolicyInput, PolicyDecision, RiskLevel, ToolCategory } from '../types';
import type { RunHandle } from '../../scheduler';

const GATE_TO_CATEGORY: Record<string, ToolCategory> = {
  sandbox_escape: 'shell',
  network: 'network',
  file_write: 'file_write',
  file_read: 'file_read',
  shell_exec: 'shell',
  destructive: 'destructive',
  mcp: 'api',
};

const RISK_TO_LEVEL: Record<string, RiskLevel> = {
  low: 'low',
  medium: 'medium',
  high: 'high',
  critical: 'high',
};

export interface PolicyBackedContext {
  hook: PolicyHook;
  run: RunHandle;
  tenant: {
    id: string | null;
    config: PolicyInput['tenant']['config'];
  };
  metrics: PolicyInput['metrics'];
}

export function approvalRequestToPolicyInput(
  req: ApprovalRequest,
  ctx: PolicyBackedContext,
): PolicyInput {
  const category = GATE_TO_CATEGORY[req.gate.category] ?? 'unknown';
  const destructive = req.gate.category === 'destructive' || req.gate.riskLevel === 'critical';
  const isReadOnly = req.gate.category === 'file_read';
  const toolArgs = req.toolArgs ?? {};
  const externalSystem = (toolArgs['externalSystem'] as string) ?? undefined;
  const isIdempotent = typeof toolArgs['idempotencyKey'] === 'string';
  const leaseToken = ctx.run.leaseToken;
  const fencingEpoch = ctx.run.fencingEpoch;

  return {
    phase: 'tool',
    run: {
      id: ctx.run.runId,
      state: ctx.run.state,
      fencingEpoch,
      intentHash: ctx.run.intentHash,
      tenantId: ctx.run.tenantId ?? ctx.tenant.id ?? undefined,
      agentId: req.agentId,
      goal: (ctx.run.metadata?.['goal'] as string) ?? req.toolName,
      createdAt: Date.parse(ctx.run.createdAt) || Date.now(),
      actionsSoFar: [],
    },
    tool: {
      name: req.toolName,
      externalSystem,
      riskLevel: RISK_TO_LEVEL[req.gate.riskLevel] ?? 'medium',
      destructive,
      isReadOnly,
      isIdempotent,
      category,
    },
    action: {
      args: toolArgs,
      idempotencyKey: (toolArgs['idempotencyKey'] as string) ?? `legacy:${req.id}`,
      stepNumber: -1,
      callSite: 'http',
      leaseToken,
      fencingEpoch,
    },
    tenant: ctx.tenant,
    metrics: ctx.metrics,
    time: {
      now: req.timestamp,
      hourOfDay: new Date(req.timestamp).getHours(),
      isWeekend: [0, 6].includes(new Date(req.timestamp).getDay()),
    },
  };
}

export function policyDecisionToApproval(decision: PolicyDecision): {
  decision: ApprovalDecision;
  reason: string;
} {
  if (decision.effect === 'allow') {
    return { decision: 'approved', reason: decision.reason };
  }
  if (decision.effect === 'deny') {
    return { decision: 'denied', reason: decision.reason };
  }
  if (decision.effect === 'deny_class') {
    return {
      decision: 'denied',
      reason: `policy:${decision.denyClass}: ${decision.reason}`,
    };
  }
  return {
    decision: 'denied',
    reason: `policy:require_approval: ${decision.reason || 'deferred'}`,
  };
}

export type PolicyBackedEvaluate = (
  req: ApprovalRequest,
) => Promise<{ decision: ApprovalDecision; reason: string }>;

export function wrapApprovalWithPolicy(
  legacy: ApprovalSystem,
  ctx: PolicyBackedContext,
): PolicyBackedEvaluate {
  return async (req: ApprovalRequest) => {
    const input = approvalRequestToPolicyInput(req, ctx);
    const decision = ctx.hook.evaluate(input);

    if (
      decision.effect === 'deny' ||
      decision.effect === 'deny_class' ||
      decision.effect === 'require_approval'
    ) {
      return policyDecisionToApproval(decision);
    }
    return legacy.evaluate(req);
  };
}
