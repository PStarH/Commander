import { createHash } from 'crypto';
import type { ExecutionScheduler, RunHandle } from '../../scheduler';
import type { PolicyInput, PolicyDecision, PolicyEngineOptions, PolicyEffect } from '../types';
import { PolicyEngine } from '../engine';
import { DecisionCache } from '../cache';
import { parsePolicyPack } from '../loader';
import { canonicalJson } from '../engine';
import { DEFAULT_CODING_PACK, READ_ONLY_PACK, DESTRUCTIVE_OPS_PACK, LEGACY_EXEC_PACK } from '../packs/defaultCoding';
import { getSecurityAuditLogger } from '../../../security/securityAuditLogger';

export interface PolicyHookOptions extends PolicyEngineOptions {
  pack?: 'default' | 'readonly' | 'destructive' | 'legacyExec' | { source: string; name: string; version: number };
  enableAudit?: boolean;
}

export class PolicyHook {
  private readonly engine: PolicyEngine;
  private readonly cache = new DecisionCache();
  private readonly enableAudit: boolean;
  private readonly packName: string;
  private readonly packVersion: number;

  constructor(opts: PolicyHookOptions = {}) {
    this.enableAudit = opts.enableAudit ?? true;
    const packChoice = opts.pack ?? 'default';
    let source: string;
    let name: string;
    let version: number;
    if (typeof packChoice === 'string') {
      switch (packChoice) {
        case 'readonly':
          source = READ_ONLY_PACK; name = 'readonly'; version = 1; break;
        case 'destructive':
          source = DESTRUCTIVE_OPS_PACK; name = 'destructive'; version = 1; break;
        case 'legacyExec':
          source = LEGACY_EXEC_PACK; name = 'legacyExec'; version = 1; break;
        default:
          source = DEFAULT_CODING_PACK; name = 'defaultCoding'; version = 1; break;
      }
    } else {
      source = packChoice.source; name = packChoice.name; version = packChoice.version;
    }
    const parsed = parsePolicyPack(source, name, version);
    if (parsed.errors.length > 0) {
      throw new Error(`pack_parse_failed: ${parsed.errors.join('; ')}`);
    }
    const critical = parsed.conflicts.find((c) => c.severity === 'critical');
    if (critical) {
      throw new Error(`pack_conflict_critical: ${critical.ruleA} vs ${critical.ruleB}`);
    }
    this.engine = new PolicyEngine(parsed.pack, opts);
    this.packName = name;
    this.packVersion = version;
  }

  evaluate(input: PolicyInput): PolicyDecision {
    const cacheKey = this.cacheKey(input);
    if (input.phase === 'tool') {
      const hit = this.cache.get(cacheKey);
      if (hit) {
        if (this.enableAudit) this.auditDecision(hit, 'cache_hit');
        return hit;
      }
    }
    const decision = this.engine.evaluate(input);
    if (input.phase === 'tool' && decision.cacheable) {
      this.cache.set(cacheKey, decision);
    }
    if (this.enableAudit) this.auditDecision(decision, 'evaluated');
    return decision;
  }

  invalidateRun(runId: string): number {
    return this.cache.invalidateByRun(runId);
  }

  invalidateTenant(tenantId: string | null): number {
    return this.cache.invalidateByTenant(tenantId);
  }

  invalidatePack(): number {
    return this.cache.invalidateByPackVersion(this.packVersion);
  }

  getStats() {
    return {
      ...this.engine.getStats(),
      cacheSize: this.cache.size(),
      cacheHitRate: this.cache.hitRate(),
    };
  }

  getPackName(): string { return this.packName; }
  getPackVersion(): number { return this.packVersion; }

  private cacheKey(input: PolicyInput): string {
    const obj = {
      tenant: input.tenant.id,
      run: input.run.id,
      pack: this.packVersion,
      phase: input.phase,
      step: input.action.stepNumber,
      tool: input.tool.name,
      toolCat: input.tool.category,
      args: input.action.args,
      destructive: input.tool.destructive,
      ext: input.tool.externalSystem,
      leaseEpoch: input.action.fencingEpoch,
    };
    return createHash('sha256').update(canonicalJson(obj)).digest('hex');
  }

  private auditDecision(decision: PolicyDecision, source: 'evaluated' | 'cache_hit'): void {
    try {
      const audit = getSecurityAuditLogger();
      audit.logEvent({
        type: 'policy_decision' as never,
        severity: this.severityFor(decision.effect),
        source: `PolicyEngine:${this.packName}@${this.packVersion}`,
        message: `${decision.effect}: ${decision.reason} (${source})`,
        details: {
          decisionId: decision.decisionId,
          effect: decision.effect,
          denyClass: decision.denyClass,
          reason: decision.reason,
          decisionPath: decision.decisionPath,
          matchedRule: decision.matchedRule,
          riskScore: decision.riskScore,
          latencyMs: decision.latencyMs,
          cached: decision.cached,
          source,
        },
        context: {
          runId: decision.runId,
          tenantId: decision.tenantId ?? undefined,
        },
      });
    } catch {
      void 0;
    }
  }

  private severityFor(effect: PolicyEffect): 'low' | 'medium' | 'high' | 'critical' {
    if (effect === 'allow') return 'low';
    if (effect === 'require_approval') return 'medium';
    if (effect === 'deny') return 'high';
    return 'critical';
  }
}

export interface PolicyInputForSchedulerArgs {
  scheduler: ExecutionScheduler;
  runId: string;
  tool?: {
    name: string;
    externalSystem?: string;
    riskLevel: 'low' | 'medium' | 'high';
    destructive: boolean;
    isReadOnly: boolean;
    isIdempotent: boolean;
    category: 'shell' | 'network' | 'file_write' | 'file_read' | 'destructive' | 'mcp' | 'compute' | 'api' | 'unknown';
  };
  args?: Record<string, unknown>;
  stepNumber?: number;
  callSite?: 'agent' | 'http' | 'plugin' | 'scheduler';
  phase: 'begin' | 'tool' | 'lifecycle';
}

export function buildPolicyInput(args: PolicyInputForSchedulerArgs): PolicyInput {
  const tx = args.scheduler.getRun({ runId: args.runId });
  const now = new Date();
  return {
    phase: args.phase,
    run: {
      id: args.runId,
      state: tx?.state ?? 'PENDING',
      fencingEpoch: tx?.fencingEpoch ?? 0,
      intentHash: tx?.intentHash ?? '',
      tenantId: tx?.tenantId,
      agentId: 'atr-policy-hook',
      goal: '',
      metadata: tx?.metadata as Record<string, unknown> | undefined,
      createdAt: tx?.createdAt ? Date.parse(tx.createdAt) : now.getTime(),
      actionsSoFar: (tx?.actions ?? []).map((a) => ({
        actionId: a.actionId,
        toolName: a.toolName,
        externalSystem: a.externalSystem,
        destructive: a.tags.includes('destructive'),
        riskLevel: (a.tags.includes('high') ? 'high' : a.tags.includes('low') ? 'low' : 'medium') as 'low' | 'medium' | 'high',
        idempotencyKey: a.idempotencyKey,
        executedAt: a.executedAt ? Date.parse(a.executedAt) : undefined,
        result: a.result,
        error: a.error,
      })),
    },
    tool: args.tool ?? {
      name: 'lifecycle',
      riskLevel: 'low',
      destructive: false,
      isReadOnly: true,
      isIdempotent: true,
      category: 'compute',
    },
    action: {
      args: args.args ?? {},
      idempotencyKey: '',
      stepNumber: args.stepNumber ?? 0,
      callSite: args.callSite ?? 'agent',
      leaseToken: '',
      fencingEpoch: tx?.fencingEpoch ?? 0,
    },
    tenant: {
      id: tx?.tenantId ?? null,
      config: {
        tokenBudget: 1_000_000,
        maxConcurrency: 5,
        maxRunsPerMinute: 60,
        maxActionsPerRun: 100,
        allowShell: false,
        allowNetwork: false,
        requiresApprovalBypass: false,
      },
    },
    metrics: {
      tokensUsedThisRun: 0,
      tokensUsedThisHour: 0,
      actionsThisRun: tx?.actions.length ?? 0,
      destructiveThisRun: (tx?.actions ?? []).filter((a) => a.tags.includes('destructive')).length,
      estimatedCostUsd: 0,
    },
    time: {
      now: now.getTime(),
      hourOfDay: now.getUTCHours(),
      isWeekend: now.getUTCDay() === 0 || now.getUTCDay() === 6,
    },
  };
}

export function isEffectTerminal(effect: PolicyEffect): boolean {
  return effect === 'deny' || effect === 'deny_class';
}

export function decisionDenies(decision: PolicyDecision): boolean {
  return decision.effect === 'deny' || decision.effect === 'deny_class';
}

export function decisionRequiresApproval(decision: PolicyDecision): boolean {
  return decision.effect === 'require_approval';
}

void (null as unknown as RunHandle);
