import { reportSilentFailure } from '../../silentFailureReporter';
import { createHash, randomBytes } from 'crypto';
import {
  type PolicyDecision,
  type PolicyEffect,
  type PolicyInput,
  type PolicyPackAst,
  type PolicyRuleAst,
  type PolicyEngineOptions,
  type PolicyEngineStats,
  type PolicyDenyClass,
  type LiteralValue,
  type BudgetSnapshot,
} from './types';
import { defaultBuiltins } from './builtins';
import { evaluateExpr } from './evaluator';
import { detectCycles } from './conflictAnalyzer';

const DEFAULT_MAX_DEPTH = 32;
const DEFAULT_TIMEOUT_MS = 50;

export class PolicyEngine {
  private readonly maxDepth: number;
  private readonly timeoutMs: number;
  private readonly statsImpl: PolicyEngineStats = {
    evaluations: 0,
    cacheHits: 0,
    cacheMisses: 0,
    denials: 0,
    allows: 0,
    approvals: 0,
    denyClasses: {},
    avgLatencyMs: 0,
    p99LatencyMs: 0,
    maxLatencyMs: 0,
    errors: 0,
    cyclesDetected: 0,
    timeouts: 0,
  };
  private totalLatencyMs = 0;
  private readonly packAst: PolicyPackAst;
  private readonly cycles: Set<string>;

  constructor(
    pack: PolicyPackAst,
    private readonly opts: PolicyEngineOptions = {},
  ) {
    this.maxDepth = opts.maxEvaluationDepth ?? DEFAULT_MAX_DEPTH;
    this.timeoutMs = opts.evaluationTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.packAst = pack;
    const cycleResult = detectCycles(pack);
    this.cycles = cycleResult.cycles;
    this.statsImpl.cyclesDetected = cycleResult.cycles.size;
  }

  getPack(): PolicyPackAst {
    return this.packAst;
  }

  getStats(): PolicyEngineStats {
    return { ...this.statsImpl, denyClasses: { ...this.statsImpl.denyClasses } };
  }

  resetStats(): void {
    this.statsImpl.evaluations = 0;
    this.statsImpl.cacheHits = 0;
    this.statsImpl.cacheMisses = 0;
    this.statsImpl.denials = 0;
    this.statsImpl.allows = 0;
    this.statsImpl.approvals = 0;
    this.statsImpl.denyClasses = {};
    this.statsImpl.avgLatencyMs = 0;
    this.statsImpl.p99LatencyMs = 0;
    this.statsImpl.maxLatencyMs = 0;
    this.statsImpl.errors = 0;
    this.statsImpl.timeouts = 0;
    this.totalLatencyMs = 0;
  }

  evaluate(input: PolicyInput): PolicyDecision {
    const start = process.hrtime.bigint();
    const decisionId = `pd_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`;
    const budget: BudgetSnapshot = {
      tokensUsed: input.metrics.tokensUsedThisRun,
      tokensBudget: input.tenant.config.tokenBudget,
      actionsUsed: input.metrics.actionsThisRun,
      actionsBudget: input.tenant.config.maxActionsPerRun,
      estimatedCostUsd: input.metrics.estimatedCostUsd,
    };

    try {
      if (this.cycles.size > 0) {
        return this.failClosed(input, decisionId, budget, 'cycle_detected_in_pack', start, false);
      }

      if (input.action.fencingEpoch !== input.run.fencingEpoch) {
        return this.failClosed(input, decisionId, budget, 'stale_lease', start, false);
      }

      const result = this.evaluateRules(input);

      const afterBudget = this.applyBudgetGate(result, input);
      const riskScore = this.computeRiskScore(input, afterBudget.effect);

      const decision: PolicyDecision = {
        effect: afterBudget.effect,
        reason: afterBudget.reason,
        denyClass: afterBudget.denyClass,
        decisionPath: afterBudget.decisionPath,
        matchedRule: afterBudget.matchedRule,
        riskScore,
        budget,
        latencyMs: this.elapsedMs(start),
        cached: false,
        cacheable: this.isCacheable(afterBudget.effect, input),
        decisionId,
        packVersion: this.packAst.version,
        packName: this.packAst.name,
        tenantId: input.tenant.id,
        runId: input.run.id,
      };

      this.recordStats(decision);
      return decision;
    } catch (err) {
      this.statsImpl.errors++;
      return this.failClosed(
        input,
        decisionId,
        budget,
        `engine_error: ${(err as Error).message ?? 'unknown'}`,
        start,
        false,
      );
    }
  }

  private evaluateRules(input: PolicyInput): {
    effect: PolicyEffect;
    reason: string;
    denyClass?: PolicyDenyClass;
    decisionPath: string[];
    matchedRule: string | null;
  } {
    const decisionPath: string[] = [];
    const allowDefault = this.packAst.defaults.allow;
    const approvalDefault = this.packAst.defaults.require_approval;

    let allow = allowDefault;
    let requireApproval = approvalDefault;
    let denySeen = false;
    let denyReason = 'default_deny';
    let requireApprovalReason = 'default_no_approval';
    let denyClass: PolicyDenyClass | undefined;
    let denyClassReason: string | undefined;
    let matchedRule: string | null = null;

    const sortedRules = [...this.packAst.rules].sort((a, b) => a.priority - b.priority);

    for (const rule of sortedRules) {
      if (this.cycles.has(rule.name)) continue;

      const ruleResult = this.evaluateRule(rule, input);
      if (!ruleResult.fired) continue;

      decisionPath.push(rule.name);
      matchedRule = rule.name;

      if (rule.effect === 'deny_class' && rule.denyClass) {
        denyClass = rule.denyClass;
        denyClassReason = rule.name;
        continue;
      }

      if (rule.effect === 'deny') {
        if (!denySeen) {
          denySeen = true;
          denyReason = rule.name;
        }
        continue;
      }

      if (rule.effect === 'require_approval') {
        if (!requireApproval) {
          requireApproval = true;
          requireApprovalReason = rule.name;
        }
        continue;
      }

      if (rule.effect === 'allow') {
        if (!allow) {
          allow = true;
        }
      }
    }

    if (denyClass) {
      return {
        effect: 'deny_class',
        reason: `deny_class: ${denyClass}${denyClassReason ? ` (rule: ${denyClassReason})` : ''}`,
        denyClass,
        decisionPath,
        matchedRule,
      };
    }

    if (denySeen) {
      return {
        effect: 'deny',
        reason: `deny (rule: ${denyReason})`,
        decisionPath,
        matchedRule,
      };
    }

    if (requireApproval) {
      return {
        effect: 'require_approval',
        reason: `require_approval (rule: ${requireApprovalReason})`,
        decisionPath,
        matchedRule,
      };
    }

    if (allow) {
      return {
        effect: 'allow',
        reason: 'explicit_allow',
        decisionPath,
        matchedRule,
      };
    }

    return {
      effect: 'deny',
      reason: 'default_deny',
      decisionPath,
      matchedRule: null,
    };
  }

  private evaluateRule(
    rule: PolicyRuleAst,
    input: PolicyInput,
  ): { fired: boolean; value?: LiteralValue } {
    const builtins = defaultBuiltins;
    try {
      const value = evaluateExpr(rule.body, input, builtins, this.maxDepth);
      return { fired: Boolean(value) };
    } catch (err) {
      reportSilentFailure(err, 'engine:256');
      return { fired: false };
    }
  }

  private applyBudgetGate(
    result: {
      effect: PolicyEffect;
      reason: string;
      decisionPath: string[];
      matchedRule: string | null;
      denyClass?: PolicyDenyClass;
    },
    input: PolicyInput,
  ): {
    effect: PolicyEffect;
    reason: string;
    decisionPath: string[];
    matchedRule: string | null;
    denyClass?: PolicyDenyClass;
  } {
    if (result.effect === 'deny' || result.effect === 'deny_class') return result;

    if (input.metrics.tokensUsedThisRun > input.tenant.config.tokenBudget) {
      return {
        effect: 'deny',
        reason: 'budget_hard_cap_exceeded',
        decisionPath: [...result.decisionPath, 'budget_gate:tokens'],
        matchedRule: result.matchedRule,
      };
    }

    if (input.metrics.actionsThisRun > input.tenant.config.maxActionsPerRun) {
      return {
        effect: 'deny',
        reason: 'rate_limit_exceeded',
        decisionPath: [...result.decisionPath, 'budget_gate:actions'],
        matchedRule: result.matchedRule,
      };
    }

    if (result.effect === 'allow' && input.tool.destructive && !input.tool.isIdempotent) {
      return {
        effect: 'deny',
        reason: 'destructive_without_idempotency',
        decisionPath: [...result.decisionPath, 'g_idemp_1'],
        matchedRule: result.matchedRule,
      };
    }

    return result;
  }

  private computeRiskScore(input: PolicyInput, effect: PolicyEffect): number {
    let score = 0;
    if (input.tool.destructive) score += 30;
    if (input.tool.externalSystem) score += 20;
    score += Math.min(input.metrics.destructiveThisRun * 10, 30);
    if (input.tool.isReadOnly) score -= 20;
    if (input.tool.category === 'shell') score += 5;
    if (input.tool.category === 'network' && input.tenant.config.allowNetwork === false)
      score += 10;
    if (effect === 'require_approval') score += 5;
    return Math.max(0, Math.min(100, score));
  }

  private isCacheable(effect: PolicyEffect, input: PolicyInput): boolean {
    if (input.phase !== 'tool') return false;
    if (effect === 'deny_class') return false;
    if (input.action.callSite === 'plugin') return false;
    return true;
  }

  private recordStats(decision: PolicyDecision): void {
    this.statsImpl.evaluations++;
    this.totalLatencyMs += decision.latencyMs;
    this.statsImpl.avgLatencyMs = this.totalLatencyMs / this.statsImpl.evaluations;
    if (decision.latencyMs > this.statsImpl.maxLatencyMs) {
      this.statsImpl.maxLatencyMs = decision.latencyMs;
    }
    if (decision.latencyMs > (this.opts.evaluationTimeoutMs ?? DEFAULT_TIMEOUT_MS) * 0.99) {
      this.statsImpl.timeouts++;
    }
    if (decision.effect === 'allow') this.statsImpl.allows++;
    else if (decision.effect === 'deny') this.statsImpl.denials++;
    else if (decision.effect === 'require_approval') this.statsImpl.approvals++;
    else if (decision.effect === 'deny_class' && decision.denyClass) {
      this.statsImpl.denyClasses[decision.denyClass] =
        (this.statsImpl.denyClasses[decision.denyClass] ?? 0) + 1;
      this.statsImpl.denials++;
    }
  }

  private failClosed(
    input: PolicyInput,
    decisionId: string,
    budget: BudgetSnapshot,
    reason: string,
    start: bigint,
    cached: boolean,
  ): PolicyDecision {
    this.statsImpl.errors++;
    return {
      effect: 'deny',
      reason,
      decisionPath: ['engine:fail_closed'],
      matchedRule: null,
      riskScore: 100,
      budget,
      latencyMs: this.elapsedMs(start),
      cached,
      cacheable: false,
      decisionId,
      packVersion: this.packAst.version,
      packName: this.packAst.name,
      tenantId: input.tenant.id,
      runId: input.run.id,
    };
  }

  private elapsedMs(start: bigint): number {
    const ns = process.hrtime.bigint() - start;
    return Number(ns) / 1_000_000;
  }
}

export function hashPolicyInput(input: PolicyInput): string {
  const obj = {
    phase: input.phase,
    runId: input.run.id,
    fencingEpoch: input.run.fencingEpoch,
    toolName: input.tool.name,
    toolCategory: input.tool.category,
    stepNumber: input.action.stepNumber,
    argsHash: hashArgs(input.action.args),
  };
  return createHash('sha256').update(JSON.stringify(obj)).digest('hex');
}

function hashArgs(args: Record<string, unknown>): string {
  return createHash('sha256').update(canonicalJson(args)).digest('hex');
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return (
    '{' +
    keys
      .map((k) => JSON.stringify(k) + ':' + canonicalJson((value as Record<string, unknown>)[k]))
      .join(',') +
    '}'
  );
}
