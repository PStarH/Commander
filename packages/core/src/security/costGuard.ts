/**
 * CostGuard — Enterprise Economic Attack Detection & Auto Circuit-Breaker
 *
 * Detects and mitigates financial attacks against the AI agent system:
 * - Token floods (single request consuming excessive tokens)
 * - Tool call amplification loops (runaway tool recursion)
 * - Concurrent request bursts (distributed cost attacks)
 * - Expensive query patterns (known costly operations)
 * - Provider fallback exhaustion (forcing high-cost model tiers)
 * - Context window stuffing (gradual fill-up to maximize per-turn cost)
 *
 * Response tiers:
 * - THROTTLE: Reduce rate, delay processing
 * - QUARANTINE: Flag session for review, increase monitoring
 * - MELT: Immediate circuit break, deny service, notify SOC
 * - LOGONLY: Record for analysis, no action
 *
 * Integrates with:
 * - TokenGovernor: budget pressure awareness
 * - SecurityAuditLogger: event recording
 * - AuditChainLedger: tamper-evident incident chain
 */

import { reportSilentFailure } from '../silentFailureReporter';
import { type TaskCategory } from '../runtime/tokenGovernor';
import { getSecurityAuditLogger } from './securityAuditLogger';
import { getAuditChainLedger } from './auditChainLedger';
import { getGlobalLogger, getGlobalMetrics } from '../logging';
import { createTenantAwareSingleton } from '../runtime/tenantAwareSingleton';
import { getLiteLLMPricing } from './litellmPricing';

// ============================================================================
// Types
// ============================================================================

export type CostAttackType =
  | 'token_flood'
  | 'tool_loop'
  | 'concurrent_burst'
  | 'expensive_query'
  | 'context_stuffing'
  | 'provider_exhaustion'
  | 'model_degradation'
  | 'amplification_loop';

export type CostGuardAction = 'THROTTLE' | 'QUARANTINE' | 'MELT' | 'LOGONLY';

export type CostTier = 'free' | 'standard' | 'pro' | 'enterprise' | 'unlimited';

export interface CostGuardConfig {
  /** Per-request token limit (beyond this → THROTTLE) */
  maxTokensPerRequest: number;
  /** Per-request token limit that triggers MELT */
  meltTokensPerRequest: number;
  /** Max tool calls per session (beyond this → QUARANTINE) */
  maxToolCallsPerSession: number;
  /** Max tool calls per minute (beyond this → THROTTLE) */
  maxToolCallsPerMinute: number;
  /** Max concurrent requests per source (IP/user/tenant) */
  maxConcurrentRequests: number;
  /** Lookback window for burst detection (ms) */
  burstWindowMs: number;
  /** Request count threshold for concurrent burst */
  burstThreshold: number;
  /** Max cost per session in USD */
  maxCostPerSession: number;
  /** Max cost per day in USD */
  maxCostPerDay: number;
  /** Max cost per month in USD */
  maxCostPerMonth: number;
  /** Cost per 1K tokens by model tier */
  costPer1MTokens: Record<string, number>;
  /** Enable automatic MELT on critical threshold breach */
  enableAutoMelt: boolean;
  /** Enable quota enforcement */
  enableQuotaEnforcement: boolean;
  /** Cost tier limits */
  tierLimits: Record<CostTier, { daily: number; monthly: number; perRequest: number }>;
  /** Pattern signatures for expensive queries */
  expensiveQueryPatterns: RegExp[];
}

export interface CostGuardState {
  /** Current cost tier */
  tier: CostTier;
  /** Total cost this session */
  sessionCost: number;
  /** Total cost today */
  dailyCost: number;
  /** Total cost this month */
  monthlyCost: number;
  /** Active throttles */
  activeThrottles: Map<string, number>;
  /** Active quarantines */
  activeQuarantines: Set<string>;
  /** Active melts */
  activeMelts: Set<string>;
  /** Tool call count this session */
  sessionToolCalls: number;
  /** Tool calls in the last minute */
  recentToolCalls: number[];
  /** Request timestamps for burst detection */
  requestTimestamps: number[];
  /** Session token usage */
  sessionTokens: number;
  /** Daily token usage */
  dailyTokens: number;
}

export interface CostGuardDecision {
  action: CostGuardAction;
  attackType: CostAttackType | null;
  reason: string;
  details: {
    currentTokens?: number;
    limitTokens?: number;
    currentCost?: number;
    limitCost?: number;
    toolCalls?: number;
    maxToolCalls?: number;
    concurrentCount?: number;
    maxConcurrent?: number;
  };
  timestamp: string;
  /** How long the action lasts (ms), 0 = permanent */
  durationMs: number;
}

export interface CostGuardReport {
  sessionCost: number;
  dailyCost: number;
  monthlyCost: number;
  sessionTokens: number;
  dailyTokens: number;
  sessionToolCalls: number;
  activeThrottles: string[];
  activeQuarantines: string[];
  activeMelts: string[];
  recentDecisions: CostGuardDecision[];
  tier: CostTier;
  tierLimits: CostGuardConfig['tierLimits'][CostTier];
}

// ============================================================================
// Default Config
// ============================================================================

const DEFAULT_CONFIG: CostGuardConfig = {
  maxTokensPerRequest: 32_000,
  meltTokensPerRequest: 100_000,
  maxToolCallsPerSession: 500,
  maxToolCallsPerMinute: 30,
  maxConcurrentRequests: 10,
  burstWindowMs: 60_000,
  burstThreshold: 20,
  maxCostPerSession: 5.0,
  maxCostPerDay: 100.0,
  maxCostPerMonth: 1000.0,
  costPer1MTokens: {
    'gpt-4o': 5.0,
    'gpt-4o-mini': 0.15,
    'claude-3-opus': 15.0,
    'claude-3-sonnet': 3.0,
    'claude-3-haiku': 0.25,
    'gemini-1.5-pro': 3.5,
    'gemini-1.5-flash': 0.075,
    'deepseek-v3': 0.27,
    default: 5.0,
  },
  enableAutoMelt: true,
  enableQuotaEnforcement: true,
  tierLimits: {
    free: { daily: 1.0, monthly: 10.0, perRequest: 0.05 },
    standard: { daily: 10.0, monthly: 100.0, perRequest: 0.2 },
    pro: { daily: 50.0, monthly: 500.0, perRequest: 1.0 },
    enterprise: { daily: 500.0, monthly: 5000.0, perRequest: 5.0 },
    unlimited: { daily: Infinity, monthly: Infinity, perRequest: Infinity },
  },
  expensiveQueryPatterns: [
    /analyze.{0,20}(every|each|all).{0,30}(paragraph|line|sentence|file)/i,
    /search.{0,20}(all|every|each).{0,20}(page|result|link)/i,
    /(recursive|infinite|forever|endless).{0,10}(loop|search|call|query)/i,
    /process.{0,10}(massive|huge|enormous|entire).{0,20}(dataset|database|corpus)/i,
    /generate.{0,10}(all|every).{0,20}(combination|permutation|possibility)/i,
    /repeat.{0,10}(this|the above).{0,10}(until|forever|indefinitely)/i,
  ],
};

// ============================================================================
// Cost Estimator (token → dollar)
// ============================================================================

function estimateCost(
  tokens: number,
  model: string,
  config: CostGuardConfig,
  cacheHitRatio = 0,
): number {
  const litellm = getLiteLLMPricing();

  // Try cache-aware estimate first
  if (cacheHitRatio > 0) {
    const cacheRate = litellm.getCacheReadCostPer1MTokens(model);
    const fullRate =
      litellm.getCostPer1MTokens(model) ??
      config.costPer1MTokens[model] ??
      config.costPer1MTokens['default'] ??
      5.0;
    if (cacheRate !== undefined) {
      const blendedRate = cacheHitRatio * cacheRate + (1 - cacheHitRatio) * fullRate;
      return (tokens / 1_000_000) * blendedRate;
    }
    // No cache entry, fall through to full-rate estimate
  }

  const litellmRate = litellm.getCostPer1MTokens(model);
  if (litellmRate !== undefined) {
    return (tokens / 1_000_000) * litellmRate;
  }
  const rate = config.costPer1MTokens[model] ?? config.costPer1MTokens['default'] ?? 5.0;
  return (tokens / 1_000_000) * rate;
}

// ============================================================================
// CostGuard
// ============================================================================

export class CostGuard {
  private config: CostGuardConfig;
  private state: CostGuardState;
  private decisions: CostGuardDecision[] = [];
  private readonly maxDecisions = 200;
  private dailyResetTimer: ReturnType<typeof setInterval> | null = null;
  private sessionStartTime: number;

  constructor(config?: Partial<CostGuardConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.sessionStartTime = Date.now();
    this.state = this.createFreshState();
  }

  private createFreshState(): CostGuardState {
    return {
      tier: 'standard',
      sessionCost: 0,
      dailyCost: 0,
      monthlyCost: 0,
      activeThrottles: new Map(),
      activeQuarantines: new Set(),
      activeMelts: new Set(),
      sessionToolCalls: 0,
      recentToolCalls: [],
      requestTimestamps: [],
      sessionTokens: 0,
      dailyTokens: 0,
    };
  }

  // ── Configuration ─────────────────────────────────────────────────

  /** Set the cost tier for the current tenant/user. */
  setTier(tier: CostTier): void {
    this.state.tier = tier;
  }

  /** Get current tier. */
  getTier(): CostTier {
    return this.state.tier;
  }

  /** Reconfigure at runtime. */
  reconfigure(config: Partial<CostGuardConfig>): void {
    this.config = { ...this.config, ...config };
  }

  // ── Core: Evaluate Request ─────────────────────────────────────────

  /**
   * Evaluate a request before processing. Returns a decision.
   * Called at the start of every agent run / LLM call.
   */
  evaluateRequest(params: {
    /** Estimated or actual token count for this request */
    tokens: number;
    /** Model being used */
    model: string;
    /** Source identifier (userId, IP, tenantId) */
    source: string;
    /** The user's input/prompt for pattern analysis */
    input?: string;
    /** Task category for cost estimation */
    taskCategory?: TaskCategory;
    /** Fraction of tokens expected to hit cache (0-1), for cache-aware cost estimation */
    cacheHitRatio?: number;
  }): CostGuardDecision {
    const { tokens, model, source, input } = params;
    const now = Date.now();

    // 0. Clean expired throttles
    this.cleanExpiredThrottles(now);

    // 1. Check if source is already melted
    if (this.state.activeMelts.has(source)) {
      return this.decide(
        'MELT',
        'token_flood',
        'Source is circuit-broken (MELT)',
        {
          currentTokens: tokens,
          limitTokens: 0,
        },
        0,
      );
    }

    // 1. Detect token flood
    if (tokens > this.config.meltTokensPerRequest) {
      this.applyAction(
        'MELT',
        source,
        'token_flood',
        `Request tokens (${tokens}) exceed MELT threshold (${this.config.meltTokensPerRequest})`,
      );
      return this.decide(
        'MELT',
        'token_flood',
        `MELT: ${tokens} tokens exceeds ${this.config.meltTokensPerRequest} limit`,
        { currentTokens: tokens, limitTokens: this.config.meltTokensPerRequest },
        0,
      );
    }

    if (tokens > this.config.maxTokensPerRequest) {
      return this.decide(
        'THROTTLE',
        'token_flood',
        `THROTTLE: ${tokens} tokens exceeds ${this.config.maxTokensPerRequest} limit`,
        { currentTokens: tokens, limitTokens: this.config.maxTokensPerRequest },
        30_000,
      );
    }

    // 2. Detect concurrent burst
    this.state.requestTimestamps.push(now);
    const windowStart = now - this.config.burstWindowMs;
    this.state.requestTimestamps = this.state.requestTimestamps.filter((t) => t > windowStart);
    const concurrentCount = this.state.requestTimestamps.length;

    if (concurrentCount > this.config.burstThreshold * 2) {
      this.applyAction(
        'MELT',
        source,
        'concurrent_burst',
        `Burst ${concurrentCount} requests in ${this.config.burstWindowMs}ms (MELT threshold: ${this.config.burstThreshold * 2})`,
      );
      return this.decide(
        'MELT',
        'concurrent_burst',
        `MELT: ${concurrentCount} requests detected in burst window`,
        { concurrentCount, maxConcurrent: this.config.burstThreshold * 2 },
        0,
      );
    }

    if (concurrentCount > this.config.burstThreshold) {
      return this.decide(
        'THROTTLE',
        'concurrent_burst',
        `THROTTLE: ${concurrentCount} requests in burst window`,
        { concurrentCount, maxConcurrent: this.config.burstThreshold },
        60_000,
      );
    }

    // 3. Detect context stuffing (large context window usage over time)
    if (this.state.sessionTokens > 200_000 && tokens > 10_000) {
      return this.decide(
        'QUARANTINE',
        'context_stuffing',
        `Session tokens (${this.state.sessionTokens}) with large request (${tokens} tokens)`,
        { currentTokens: this.state.sessionTokens, limitTokens: 200_000 },
        300_000,
      );
    }

    // 4. Detect expensive query patterns
    if (input) {
      for (const pattern of this.config.expensiveQueryPatterns) {
        if (pattern.test(input)) {
          return this.decide(
            'QUARANTINE',
            'expensive_query',
            `Query matches expensive pattern: ${pattern.source}`,
            {},
            300_000,
          );
        }
      }
    }

    // 5. Quota enforcement (only for requests that passed all other checks)
    if (this.config.enableQuotaEnforcement) {
      const limits = this.config.tierLimits[this.state.tier];
      const estimatedCost = estimateCost(tokens, model, this.config, params.cacheHitRatio ?? 0);

      if (this.state.dailyCost + estimatedCost > limits.daily) {
        return this.decide(
          'THROTTLE',
          'token_flood',
          `Daily cost limit reached: $${this.state.dailyCost.toFixed(2)} + $${estimatedCost.toFixed(4)} > $${limits.daily.toFixed(2)}`,
          { currentCost: this.state.dailyCost, limitCost: limits.daily },
          86_400_000,
        );
      }

      if (estimatedCost > limits.perRequest) {
        return this.decide(
          'THROTTLE',
          'expensive_query',
          `Per-request cost $${estimatedCost.toFixed(4)} exceeds tier limit $${limits.perRequest.toFixed(2)}`,
          { currentCost: estimatedCost, limitCost: limits.perRequest },
          30_000,
        );
      }
    }

    // Update state — only for requests that passed all checks.
    // Cost tracking happens exclusively in recordActualCost.
    // We track sessionTokens for context stuffing detection and
    // requestTimestamps for burst detection only.
    this.state.sessionTokens += tokens;

    return this.decide('LOGONLY', null, 'Clean request', {}, 0);
  }

  // ── Core: Evaluate Tool Call ──────────────────────────────────────

  /**
   * Evaluate a tool call for economic attack patterns.
   * Detects tool call loops, amplification, and excessive recursion.
   */
  evaluateToolCall(params: {
    toolName: string;
    source: string;
    /** Tool call count in current sequence */
    sequenceCallCount?: number;
  }): CostGuardDecision {
    const { toolName, source } = params;
    const now = Date.now();

    // Check MELT and clean expired throttles
    this.cleanExpiredThrottles(now);
    if (this.state.activeMelts.has(source)) {
      return this.decide('MELT', 'tool_loop', 'Source is melted', {}, 0);
    }

    // Track tool calls
    this.state.sessionToolCalls++;
    this.state.recentToolCalls.push(now);

    // Clean old tool call records
    const oneMinuteAgo = now - 60_000;
    this.state.recentToolCalls = this.state.recentToolCalls.filter((t) => t > oneMinuteAgo);
    const callsPerMinute = this.state.recentToolCalls.length;

    // 6. Detect tool call loops (excessive calls per session)
    if (this.state.sessionToolCalls > this.config.maxToolCallsPerSession * 2) {
      this.applyAction(
        'MELT',
        source,
        'tool_loop',
        `Session tool calls (${this.state.sessionToolCalls}) exceed 2x max (${this.config.maxToolCallsPerSession})`,
      );
      return this.decide(
        'MELT',
        'tool_loop',
        `MELT: ${this.state.sessionToolCalls} tool calls this session`,
        {
          toolCalls: this.state.sessionToolCalls,
          maxToolCalls: this.config.maxToolCallsPerSession,
        },
        0,
      );
    }

    if (this.state.sessionToolCalls > this.config.maxToolCallsPerSession) {
      return this.decide(
        'QUARANTINE',
        'tool_loop',
        `QUARANTINE: ${this.state.sessionToolCalls} tool calls exceeds ${this.config.maxToolCallsPerSession}`,
        {
          toolCalls: this.state.sessionToolCalls,
          maxToolCalls: this.config.maxToolCallsPerSession,
        },
        300_000,
      );
    }

    // 7. Detect tool call amplification (high rate)
    if (callsPerMinute > this.config.maxToolCallsPerMinute * 3) {
      this.applyAction(
        'MELT',
        source,
        'amplification_loop',
        `Tool call amplification: ${callsPerMinute}/min (3x limit)`,
      );
      return this.decide(
        'MELT',
        'amplification_loop',
        `MELT: ${callsPerMinute} tool calls/minute`,
        { toolCalls: callsPerMinute, maxToolCalls: this.config.maxToolCallsPerMinute * 3 },
        0,
      );
    }

    if (callsPerMinute > this.config.maxToolCallsPerMinute) {
      return this.decide(
        'THROTTLE',
        'amplification_loop',
        `THROTTLE: ${callsPerMinute} tool calls/minute exceeds ${this.config.maxToolCallsPerMinute}`,
        { toolCalls: callsPerMinute, maxToolCalls: this.config.maxToolCallsPerMinute },
        30_000,
      );
    }

    return this.decide('LOGONLY', null, `Tool call: ${toolName}`, {}, 0);
  }

  // ── Core: Evaluate Provider Switch ─────────────────────────────────

  /**
   * Evaluate a model provider switch for economic attack.
   * Detects provider fallback exhaustion (forcing expensive models).
   */
  evaluateProviderSwitch(params: {
    fromModel: string;
    toModel: string;
    reason: string;
    source: string;
  }): CostGuardDecision {
    const { fromModel, toModel, reason } = params;
    const fromCost = estimateCost(1000, fromModel, this.config);
    const toCost = estimateCost(1000, toModel, this.config);

    // Detect aggressive cost escalation
    if (toCost > fromCost * 5) {
      return this.decide(
        'QUARANTINE',
        'model_degradation',
        `Provider switch cost escalation: $${fromCost}→$${toCost} per 1K tokens (reason: ${reason})`,
        {},
        300_000,
      );
    }

    return this.decide(
      'LOGONLY',
      null,
      `Provider switch: ${fromModel}→${toModel} (${reason})`,
      {},
      0,
    );
  }

  // ── State Management ──────────────────────────────────────────────

  /** Record actual cost after LLM call completes. This is the SINGLE source of truth for cost tracking. */
  recordActualCost(tokens: number, model: string): void {
    const cost = estimateCost(tokens, model, this.config);
    // Session counters: replace estimate with actual
    this.state.sessionTokens = tokens;
    this.state.sessionCost = cost;
    // Daily/monthly counters: add actual (evaluateRequest already added the token estimate,
    // so we subtract the session estimate and add actual for daily/monthly)
    // Actually, since evaluateRequest tracks sessionTokens but not costs, daily is tracked
    // here as well. To avoid double-counting tokens: evaluateRequest tracks only
    // sessionTokens for context stuffing detection; recordActualCost is the cost authority.
    // Daily token count = last recorded actual
    this.state.dailyTokens += tokens;
    this.state.dailyCost += cost;
    this.state.monthlyCost += cost;
  }

  /** Reset session state (called on new session). */
  resetSession(): void {
    this.state.sessionCost = 0;
    this.state.sessionToolCalls = 0;
    this.state.sessionTokens = 0;
    this.state.recentToolCalls = [];
    this.state.requestTimestamps = [];
    this.sessionStartTime = Date.now();
  }

  /** Reset daily counters (called at midnight). */
  resetDaily(): void {
    this.state.dailyCost = 0;
    this.state.dailyTokens = 0;
  }

  /** Get current report. */
  getReport(): CostGuardReport {
    return {
      sessionCost: this.state.sessionCost,
      dailyCost: this.state.dailyCost,
      monthlyCost: this.state.monthlyCost,
      sessionTokens: this.state.sessionTokens,
      sessionToolCalls: this.state.sessionToolCalls,
      dailyTokens: this.state.dailyTokens,
      activeThrottles: [...this.state.activeThrottles.keys()],
      activeQuarantines: [...this.state.activeQuarantines],
      activeMelts: [...this.state.activeMelts],
      recentDecisions: [...this.decisions].reverse().slice(0, 20),
      tier: this.state.tier,
      tierLimits: this.config.tierLimits[this.state.tier],
    };
  }

  /** Check if a source is currently throttled. */
  isThrottled(source: string): boolean {
    return this.state.activeThrottles.has(source);
  }

  /** Check if a source is currently quarantined. */
  isQuarantined(source: string): boolean {
    return this.state.activeQuarantines.has(source);
  }

  /** Check if a source is currently melted. */
  isMelted(source: string): boolean {
    return this.state.activeMelts.has(source);
  }

  /** Manually lift a MELT for a source. */
  liftMelt(source: string): boolean {
    const existed = this.state.activeMelts.delete(source);
    if (existed) {
      const audit = getSecurityAuditLogger();
      audit.logEvent({
        type: 'config_change',
        severity: 'high',
        source: 'CostGuard',
        message: `MELT lifted for source: ${source}`,
      });
    }
    return existed;
  }

  /** Manually lift a quarantine. */
  liftQuarantine(source: string): boolean {
    return this.state.activeQuarantines.delete(source);
  }

  /** Get state (for testing/debugging). */
  getState(): CostGuardState {
    return this.state;
  }

  /** Get all decisions. */
  getDecisions(): CostGuardDecision[] {
    return [...this.decisions];
  }

  // ── Internal ──────────────────────────────────────────────────────

  /** Clean expired throttles. */
  private cleanExpiredThrottles(now: number): void {
    for (const [source, timestamp] of this.state.activeThrottles) {
      if (now - timestamp > 120_000) {
        // Throttles expire after 2 min max
        this.state.activeThrottles.delete(source);
      }
    }
    // Also clean expired quarantines (5 min max)
    // Quarantines don't have timestamps, so we skip for now — they require manual lift
  }

  private decide(
    action: CostGuardAction,
    attackType: CostAttackType | null,
    reason: string,
    details: CostGuardDecision['details'],
    durationMs: number,
  ): CostGuardDecision {
    const decision: CostGuardDecision = {
      action,
      attackType,
      reason,
      details,
      timestamp: new Date().toISOString(),
      durationMs,
    };

    this.decisions.push(decision);
    if (this.decisions.length > this.maxDecisions) {
      this.decisions.shift();
    }

    // Log all non-LOGONLY decisions to audit trail
    if (action !== 'LOGONLY') {
      const audit = getSecurityAuditLogger();
      const severity = action === 'MELT' ? 'critical' : action === 'QUARANTINE' ? 'high' : 'medium';
      audit.logEvent({
        type: 'security_scan',
        severity,
        source: 'CostGuard',
        message: `[${action}] ${attackType}: ${reason}`,
        details: { ...details, action, attackType, durationMs },
      });

      // Record to audit chain for tamper-evident trail
      try {
        const chain = getAuditChainLedger();
        chain.append({
          event: 'costguard_action',
          action,
          attackType,
          reason,
          details,
          timestamp: decision.timestamp,
        });
      } catch (err) {
        reportSilentFailure(err, 'costGuard:721');
        /* non-critical */
      }
    }

    // Report metrics
    try {
      const metrics = getGlobalMetrics();
      metrics.incrementCounter('costguard.decisions', 1, {
        action,
        attackType: attackType ?? 'none',
      });
      if (action === 'MELT') {
        metrics.incrementCounter('costguard.melts', 1, { attackType: attackType ?? 'unknown' });
      }
    } catch (err) {
      reportSilentFailure(err, 'costGuard:737');
      /* non-critical */
    }

    return decision;
  }

  private applyAction(
    action: CostGuardAction,
    source: string,
    attackType: CostAttackType,
    message: string,
  ): void {
    switch (action) {
      case 'MELT':
        this.state.activeMelts.add(source);
        if (this.config.enableAutoMelt) {
          getGlobalLogger().critical('CostGuard', `🚨 AUTO-MELT: ${message}`, {
            source,
            attackType,
          });
        }
        break;
      case 'QUARANTINE':
        this.state.activeQuarantines.add(source);
        getGlobalLogger().warn('CostGuard', `⚠️ QUARANTINE: ${message}`, {
          source,
          attackType,
        });
        break;
      case 'THROTTLE':
        this.state.activeThrottles.set(source, Date.now());
        getGlobalLogger().warn('CostGuard', `⏱️ THROTTLE: ${message}`, {
          source,
          attackType,
        });
        break;
    }
  }

  /** Start daily reset timer (optional — call from agent runtime init). */
  startDailyReset(): void {
    if (this.dailyResetTimer) return;
    // Calculate ms until next midnight
    const now = new Date();
    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    const msUntilMidnight = midnight.getTime() - now.getTime();

    this.dailyResetTimer = setTimeout(() => {
      this.resetDaily();
      // Recurse every 24h
      this.dailyResetTimer = setInterval(() => this.resetDaily(), 86_400_000);
      if (this.dailyResetTimer) this.dailyResetTimer.unref();
    }, msUntilMidnight);
    if (this.dailyResetTimer) this.dailyResetTimer.unref();
  }

  /** Stop daily reset timer. */
  stopDailyReset(): void {
    if (this.dailyResetTimer) {
      clearInterval(this.dailyResetTimer);
      this.dailyResetTimer = null;
    }
  }

  /** Reset entire state (for test isolation). */
  reset(): void {
    this.stopDailyReset();
    this.state = this.createFreshState();
    this.decisions = [];
    this.sessionStartTime = Date.now();
  }
}

// ============================================================================
// Singleton
// ============================================================================

const costGuardSingleton = createTenantAwareSingleton(() => new CostGuard());

/** Get the global CostGuard (single-tenant) or tenant-scoped (multi-tenant). */
export function getCostGuard(config?: Partial<CostGuardConfig>): CostGuard {
  if (config) {
    const guard = costGuardSingleton.get();
    guard.reconfigure(config);
    return guard;
  }
  return costGuardSingleton.get();
}

/** Reset the CostGuard singleton (for test isolation). */
export function resetCostGuard(): void {
  costGuardSingleton.reset();
}
