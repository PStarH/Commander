/**
 * SubAgentGuard — enforce lifetime limits on sub-agent executions.
 *
 * Closes the "runaway sub-agent" gap from the reversibility audit. Sub-agents
 * can recursively spawn; without enforcement a single bad task can spawn N
 * sub-agents that each consume M tokens = NM cost explosion.
 *
 * Limits (all configurable per call):
 *   - maxSteps        → hard cap on internal LLM steps
 *   - maxTokens       → hard cap on token usage
 *   - maxWallClockMs  → hard cap on elapsed time
 *   - onNoProgress(n) → callback fired when N consecutive steps add no new evidence
 *
 * The guard is a thin wrapper; the actual sub-agent loop calls `guard.check()`
 * at each step boundary. Violations throw SubAgentLimitError.
 */

export class SubAgentLimitError extends Error {
  readonly reason: 'max_steps' | 'max_tokens' | 'max_wall_clock' | 'no_progress';
  readonly limit: number;
  readonly observed: number;
  constructor(reason: SubAgentLimitError['reason'], limit: number, observed: number) {
    super(`Sub-agent limit violated (${reason}): ${observed} >= ${limit}`);
    this.name = 'SubAgentLimitError';
    this.reason = reason;
    this.limit = limit;
    this.observed = observed;
  }
}

export interface SubAgentLimits {
  maxSteps?: number;
  maxTokens?: number;
  maxWallClockMs?: number;
  noProgressThreshold?: number;
}

export interface SubAgentState {
  steps: number;
  tokens: number;
  startedAt: number;
  evidenceCount: number;
}

export class SubAgentGuard {
  private state: SubAgentState;
  private limits: Required<SubAgentLimits>;

  constructor(limits: SubAgentLimits = {}) {
    this.limits = {
      maxSteps: limits.maxSteps ?? 50,
      maxTokens: limits.maxTokens ?? 100_000,
      maxWallClockMs: limits.maxWallClockMs ?? 5 * 60 * 1000,
      noProgressThreshold: limits.noProgressThreshold ?? 10,
    };
    this.state = {
      steps: 0,
      tokens: 0,
      startedAt: Date.now(),
      evidenceCount: 0,
    };
  }

  check(currentEvidenceCount: number): void {
    this.state.steps += 1;
    if (this.state.steps > this.limits.maxSteps) {
      throw new SubAgentLimitError('max_steps', this.limits.maxSteps, this.state.steps);
    }
    const elapsed = Date.now() - this.state.startedAt;
    if (elapsed > this.limits.maxWallClockMs) {
      throw new SubAgentLimitError('max_wall_clock', this.limits.maxWallClockMs, elapsed);
    }
    if (this.state.tokens > this.limits.maxTokens) {
      throw new SubAgentLimitError('max_tokens', this.limits.maxTokens, this.state.tokens);
    }
    if (currentEvidenceCount > this.state.evidenceCount) {
      this.state.evidenceCount = currentEvidenceCount;
    } else {
      const stall = this.state.steps - this.state.evidenceCount;
      if (stall >= this.limits.noProgressThreshold) {
        throw new SubAgentLimitError('no_progress', this.limits.noProgressThreshold, stall);
      }
    }
  }

  recordTokens(used: number): void {
    this.state.tokens += used;
    if (this.state.tokens > this.limits.maxTokens) {
      throw new SubAgentLimitError('max_tokens', this.limits.maxTokens, this.state.tokens);
    }
  }

  getState(): Readonly<SubAgentState> {
    return { ...this.state, startedAt: this.state.startedAt };
  }

  getLimits(): Readonly<Required<SubAgentLimits>> {
    return { ...this.limits };
  }
}
