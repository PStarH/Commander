import { reportSilentFailure } from '../silentFailureReporter';
import { getSecurityAuditLogger } from './securityAuditLogger';
import { getMetricsCollector } from '../runtime/metricsCollector';
import type { ContentThreat } from '../contentScanner';

/** Linear fork-bomb detector — avoids ReDoS on untrusted tool text. */
function containsForkBombPattern(text: string): boolean {
  const idx = text.indexOf(':()');
  if (idx < 0) return false;
  const window = text.slice(idx, idx + 64);
  return (
    window.includes('{') && window.includes(':|') && window.includes('&') && window.includes('}')
  );
}

export type GuardianInterventionType =
  | 'semantic_drift'
  | 'anomaly'
  | 'safety_violation'
  | 'cost_overrun'
  | 'goal_hijack'
  | 'behavioral_baseline_deviation'
  | 'tool_usage_spike'
  | 'data_exfiltration'
  | 'dangerous_tool_call';

export interface GuardianAction {
  agentId: string;
  runId?: string;
  timestamp: number;
  type: 'llm_call' | 'tool_call' | 'tool_result' | 'state_change';
  content: string;
  metadata?: Record<string, unknown>;
}

export interface GuardianEvidencePack {
  id: string;
  agentId: string;
  runId?: string;
  interventionType: GuardianInterventionType;
  triggerAction: GuardianAction;
  context: GuardianAction[];
  riskScore: number;
  detectedAt: number;
  recommendation: string;
}

export interface BehavioralBaseline {
  /** Average tokens per LLM call */
  avgTokensPerCall: number;
  /** Average token usage per minute */
  avgTokensPerMinute: number;
  /** Tool call frequency (calls per minute) */
  avgToolCallsPerMinute: number;
  /** Tool type distribution (toolName → frequency) — read-only for consumers */
  toolDistribution: ReadonlyMap<string, number>;
  /** Baseline established at */
  establishedAt: number;
  /** Number of observations used to build baseline */
  observationCount: number;
  /** Exponential moving average alpha (0-1) */
  alpha: number;
}

export interface GuardianConfig {
  enabled: boolean;
  semanticDriftThreshold: number;
  anomalyWindowSize: number;
  anomalyStddevMultiplier: number;
  maxConsecutiveAnomalies: number;
  costPerTokenUsd: number;
  maxCostPerRunUsd: number;
  /** Enable behavioral baseline modeling */
  enableBehavioralBaselines: boolean;
  /** Baseline EMA alpha (learning rate, 0.1 = slow adaptation, 0.5 = fast) */
  baselineAlpha: number;
  /** Minimum observations before baselines are considered reliable */
  baselineMinObservations: number;
  /** Deviation multiplier for baseline alerts (e.g., 3.0 = 3x baseline triggers alert) */
  baselineDeviationMultiplier: number;
  /** Enable output data exfiltration detection */
  enableDataExfiltrationDetection: boolean;
}

const DEFAULT_CONFIG: GuardianConfig = {
  enabled: true,
  semanticDriftThreshold: 0.7,
  anomalyWindowSize: 20,
  anomalyStddevMultiplier: 2.5,
  maxConsecutiveAnomalies: 3,
  costPerTokenUsd: 0.000002,
  maxCostPerRunUsd: 5.0,
  enableBehavioralBaselines: true,
  baselineAlpha: 0.3,
  baselineMinObservations: 10,
  baselineDeviationMultiplier: 3.0,
  enableDataExfiltrationDetection: true,
};

export class GuardianAgent {
  private config: GuardianConfig;
  private actionHistory = new Map<string, GuardianAction[]>();
  private interventionCount = 0;
  private pausedAgents = new Set<string>();
  private tokenUsage = new Map<string, number>();
  private consecutiveAnomalies = new Map<string, number>();
  /** Behavioral baselines per agent */
  private baselines = new Map<string, BehavioralBaseline>();
  /** Token usage timestamps for rate calculation */
  private tokenTimestamps = new Map<string, number[]>();

  constructor(config: Partial<GuardianConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  monitor(action: GuardianAction): GuardianInterventionType | null {
    if (!this.config.enabled) return null;

    this.appendToHistory(action);

    // Update behavioral baseline with this observation
    if (this.config.enableBehavioralBaselines) {
      this.updateBaseline(action);
    }

    const drift = this.detectSemanticDrift(action);
    if (drift) return this.intervene('semantic_drift', action);

    const anomaly = this.detectAnomaly(action.agentId);
    if (anomaly) return this.intervene('anomaly', action);

    const safety = this.detectSafetyViolation(action);
    if (safety) return this.intervene('safety_violation', action);

    // Dangerous tool call detection — scan tool_call arguments for destructive commands
    // This closes the critical gap where GuardianAgent only checked tool_result,
    // allowing agents to execute `shell_execute({ command: 'rm -rf /' })` unchecked.
    if (action.type === 'tool_call') {
      const dangerous = this.detectDangerousToolCall(action);
      if (dangerous) return this.intervene('dangerous_tool_call', action);
    }

    const cost = this.detectCostOverrun(action);
    if (cost) return this.intervene('cost_overrun', action);

    // Behavioral baseline deviation check
    if (this.config.enableBehavioralBaselines) {
      const deviation = this.detectBaselineDeviation(action.agentId, action);
      if (deviation) return this.intervene('behavioral_baseline_deviation', action);
    }

    // Tool usage spike detection
    const toolSpike = this.detectToolUsageSpike(action);
    if (toolSpike) return this.intervene('tool_usage_spike', action);

    // Data exfiltration detection on tool results
    if (this.config.enableDataExfiltrationDetection && action.type === 'tool_result') {
      const exfil = this.detectDataExfiltration(action.content);
      if (exfil) return this.intervene('data_exfiltration', action);
    }

    return null;
  }

  recordTokens(agentId: string, tokens: number): void {
    const prev = this.tokenUsage.get(agentId) ?? 0;
    this.tokenUsage.set(agentId, prev + tokens);
  }

  isPaused(agentId: string): boolean {
    return this.pausedAgents.has(agentId);
  }

  resume(agentId: string): void {
    this.pausedAgents.delete(agentId);
    this.pauseTimestamps.delete(agentId);
    this.pauseReasons.delete(agentId);
  }

  /** Map of agentId → timestamp when paused */
  private pauseTimestamps = new Map<string, number>();
  /** Map of agentId → intervention type that caused the pause */
  private pauseReasons = new Map<string, GuardianInterventionType>();
  /** Auto-resume timeout in ms (default: 5 minutes for non-critical interventions) */
  private static readonly AUTO_RESUME_MS = 5 * 60 * 1000;
  /** Intervention types that should NOT auto-resume (require manual intervention) */
  private static readonly NO_AUTO_RESUME: Set<GuardianInterventionType> = new Set([
    'dangerous_tool_call',
    'safety_violation',
    'data_exfiltration',
  ]);

  /**
   * Check and auto-resume agents that have been paused for non-critical
   * interventions beyond the auto-resume timeout.
   *
   * This prevents permanent agent death from false positives in anomaly
   * detection, semantic drift, or cost overrun checks. Critical interventions
   * (dangerous_tool_call, safety_violation, data_exfiltration) never auto-resume.
   *
   * Should be called periodically (e.g., every 30 seconds) from a health check.
   */
  checkAutoResume(): number {
    const now = Date.now();
    let resumed = 0;
    for (const [agentId, pausedAt] of this.pauseTimestamps) {
      const reason = this.pauseReasons.get(agentId);
      // Skip critical interventions — these require manual resume
      if (reason && GuardianAgent.NO_AUTO_RESUME.has(reason)) continue;

      if (now - pausedAt >= GuardianAgent.AUTO_RESUME_MS) {
        this.resume(agentId);
        resumed++;
        try {
          getSecurityAuditLogger().logEvent({
            type: 'config_change',
            severity: 'low',
            source: 'guardian_agent',
            message: `Agent ${agentId} auto-resumed after ${(GuardianAgent.AUTO_RESUME_MS / 1000 / 60).toFixed(0)}min timeout (was paused for ${reason})`,
            details: { agentId, previousReason: reason },
          });
        } catch {
          /* best-effort */
        }
      }
    }
    return resumed;
  }

  getEvidencePacks(agentId?: string): GuardianEvidencePack[] {
    const packs: GuardianEvidencePack[] = [];
    const history = agentId
      ? (this.actionHistory.get(agentId) ?? [])
      : Array.from(this.actionHistory.values()).flat();
    void history;
    return packs;
  }

  getStats(): {
    totalActions: number;
    totalInterventions: number;
    pausedAgents: number;
    perAgentTokens: Map<string, number>;
  } {
    let totalActions = 0;
    for (const actions of this.actionHistory.values()) {
      totalActions += actions.length;
    }
    return {
      totalActions,
      totalInterventions: this.interventionCount,
      pausedAgents: this.pausedAgents.size,
      perAgentTokens: new Map(this.tokenUsage),
    };
  }

  /** Get behavioral baseline for an agent. */
  getBaseline(agentId: string): BehavioralBaseline | undefined {
    return this.baselines.get(agentId);
  }

  /** Get all behavioral baselines. */
  getAllBaselines(): Map<string, BehavioralBaseline> {
    return new Map(this.baselines);
  }

  reset(): void {
    this.actionHistory.clear();
    this.interventionCount = 0;
    this.pausedAgents.clear();
    this.tokenUsage.clear();
    this.consecutiveAnomalies.clear();
    this.baselines.clear();
    this.tokenTimestamps.clear();
  }

  private appendToHistory(action: GuardianAction): void {
    const history = this.actionHistory.get(action.agentId) ?? [];
    history.push(action);
    if (history.length > this.config.anomalyWindowSize * 2) {
      history.splice(0, history.length - this.config.anomalyWindowSize * 2);
    }
    this.actionHistory.set(action.agentId, history);
  }

  private detectSemanticDrift(action: GuardianAction): boolean {
    if (action.type !== 'llm_call') return false;
    const history = this.actionHistory.get(action.agentId) ?? [];
    const recentLLMs = history
      .filter((a) => a.type === 'llm_call')
      .slice(-this.config.anomalyWindowSize);
    if (recentLLMs.length < 3) return false;

    const goalAction = recentLLMs[0];
    const currentLength = action.content.length;
    const goalLength = goalAction.content.length;
    if (goalLength === 0) return false;

    const lengthRatio = currentLength / goalLength;
    const drifted = lengthRatio > 3 || lengthRatio < 0.1;
    if (drifted) {
      const audit = getSecurityAuditLogger();
      audit.logEvent({
        type: 'content_threat',
        severity: 'high',
        source: 'guardian_agent',
        message: `Semantic drift detected for agent ${action.agentId}`,
        details: { agentId: action.agentId, lengthRatio, driftDetected: true },
      });
    }
    return drifted;
  }

  private detectAnomaly(agentId: string): boolean {
    const history = this.actionHistory.get(agentId) ?? [];
    const recent = history.slice(-this.config.anomalyWindowSize);
    if (recent.length < 5) return false;

    const toolCalls = recent.filter((a) => a.type === 'tool_call');
    const toolRate = toolCalls.length / recent.length;

    if (toolRate > 0.9) {
      const count = (this.consecutiveAnomalies.get(agentId) ?? 0) + 1;
      this.consecutiveAnomalies.set(agentId, count);
      return count >= this.config.maxConsecutiveAnomalies;
    }

    const intervals: number[] = [];
    for (let i = 1; i < recent.length; i++) {
      intervals.push(recent[i].timestamp - recent[i - 1].timestamp);
    }
    if (intervals.length >= 3) {
      const mean = intervals.reduce((a, b) => a + b, 0) / intervals.length;
      const variance = intervals.reduce((s, v) => s + (v - mean) ** 2, 0) / intervals.length;
      const stddev = Math.sqrt(variance);
      const burstCount = intervals.filter(
        (i) => i < mean - stddev * this.config.anomalyStddevMultiplier,
      ).length;
      if (burstCount > intervals.length * 0.5) {
        const count = (this.consecutiveAnomalies.get(agentId) ?? 0) + 1;
        this.consecutiveAnomalies.set(agentId, count);
        return count >= this.config.maxConsecutiveAnomalies;
      }
    }

    this.consecutiveAnomalies.set(agentId, 0);
    return false;
  }

  private detectSafetyViolation(action: GuardianAction): boolean {
    if (action.type !== 'tool_result') return false;
    const threats = this.scanForThreats(action.content);
    return threats.some((t) => t.severity === 'HIGH' || t.severity === 'CRITICAL');
  }

  /**
   * Detect dangerous commands in tool_call arguments.
   *
   * This closes the critical gap where GuardianAgent only scanned tool_result
   * content but never inspected tool_call arguments. Agents could execute
   * `shell_execute({ command: 'rm -rf /' })` without interception unless the
   * command text happened to match prompt injection patterns.
   *
   * Now we scan the tool_call content (which includes the command string)
   * for destructive command patterns before the tool executes.
   */
  private detectDangerousToolCall(action: GuardianAction): boolean {
    // Extract the raw command string from tool_call arguments.
    // The content field is JSON-serialized (e.g., `shell_execute({"command":"rm -rf /"})`)
    // which means regex patterns that expect whitespace after `/` will fail because
    // the `/` is followed by a JSON closing quote `"`.
    // Fix: extract the actual command from metadata.args.command or metadata.args.code,
    // and also scan the raw content with JSON-aware patterns.
    let scanText = action.content.toLowerCase();

    // Try to extract raw command from metadata for more accurate scanning
    const args = action.metadata?.args as Record<string, unknown> | undefined;
    if (args) {
      // shell_execute / bash tools typically have a "command" field
      if (typeof args.command === 'string') {
        scanText = args.command.toLowerCase();
      }
      // python_execute / scriptTool typically have a "code" field
      else if (typeof args.code === 'string') {
        scanText = args.code.toLowerCase();
      }
      // file tools may have a "path" field
      else if (typeof args.path === 'string') {
        scanText = `${action.content.toLowerCase()} ${args.path.toLowerCase()}`;
      }
    }

    // Also extract command from JSON-serialized content as fallback.
    // Match "command":"..." or "code":"..." patterns in the JSON string.
    const commandMatch = action.content.match(/"command"\s*:\s*"([^"]{5,})"/i);
    const codeMatch = action.content.match(/"code"\s*:\s*"([^"]{5,})"/i);
    if (commandMatch) scanText += ' ' + commandMatch[1].toLowerCase();
    if (codeMatch) scanText += ' ' + codeMatch[1].toLowerCase();

    // Catastrophic deletion patterns — always block
    // Patterns are designed to match both raw commands and JSON-embedded commands.
    // We use patterns that don't require trailing whitespace/EOF after `/`,
    // since in JSON context the `/` may be followed by `"` or `\/` (escaped).
    const catastrophicPatterns: RegExp[] = [
      // rm -rf / — matches raw, JSON-embedded, and escaped variants
      /\brm\s+(-[a-z]*r[a-z]*f*|--recursive\s*(?:--force\s*)?)\s+\/(?:\s|"|$|\\|;|&|\||\n)/i,
      // rm -rf ~ (home directory)
      /\brm\s+(-[a-z]*r[a-z]*f*|--recursive\s*(?:--force\s*)?)\s+~/i,
      // rm -rf * (wildcard)
      /\brm\s+(-[a-z]*r[a-z]*f*|--recursive\s*(?:--force\s*)?)\s+\*/i,
      // rm -rf . (current directory)
      /\brm\s+(-[a-z]*r[a-z]*f*|--recursive\s*(?:--force\s*)?)\s+\./i,
      // rm -rf $HOME or $PWD
      /\brm\s+(-[a-z]*r[a-z]*f*|--recursive\s*(?:--force\s*)?)\s+\$home/i,
      /\brm\s+(-[a-z]*r[a-z]*f*|--recursive\s*(?:--force\s*)?)\s+\$pwd/i,
      // rm -r / (without -f)
      /\brm\s+(-[a-z]*r[a-z]*|--recursive\s*)\s+\/(?:\s|"|$|\\|;|&|\||\n)/i,
      // rm -r ~, *, .
      /\brm\s+(-[a-z]*r[a-z]*|--recursive\s*)\s+~/i,
      /\brm\s+(-[a-z]*r[a-z]*|--recursive\s*)\s+\*/i,
      /\brm\s+(-[a-z]*r[a-z]*|--recursive\s*)\s+\./i,
      // chmod -R 777 / or ~
      /\bchmod\s+(-r|--recursive)\s+777\s+\/(?:\s|"|$|\\)/i,
      /\bchmod\s+(-r|--recursive)\s+777\s+~/i,
      // mkfs — format filesystem
      /\bmkfs\b/i,
      // dd to device
      /\bdd\s+if=.*of=\/dev\//i,
    ];

    // Fork bomb — linear scan (avoid ReDoS-prone regex on untrusted tool text).
    if (containsForkBombPattern(scanText)) {
      const audit = getSecurityAuditLogger();
      audit.logEvent({
        type: 'content_threat',
        severity: 'critical',
        source: 'guardian_agent',
        message: 'Dangerous tool call blocked: fork-bomb pattern detected in tool_call',
        details: {
          agentId: action.agentId,
          pattern: 'fork_bomb',
          contentPreview: scanText.slice(0, 200),
        },
      });
      return true;
    }

    for (const pattern of catastrophicPatterns) {
      if (pattern.test(scanText)) {
        const audit = getSecurityAuditLogger();
        audit.logEvent({
          type: 'content_threat',
          severity: 'critical',
          source: 'guardian_agent',
          message: `Dangerous tool call blocked: pattern "${pattern.source}" detected in tool_call`,
          details: {
            agentId: action.agentId,
            pattern: pattern.source,
            contentPreview: scanText.slice(0, 200),
          },
        });
        return true;
      }
    }

    // Database destruction patterns
    const dbDestructionPatterns: RegExp[] = [
      /\bdrop\s+(table|database|schema|index)\b/i,
      /\btruncate\s+table\b/i,
      /\bdelete\s+from\s+\w+\s*;\s*$/i,
      /\bdrop\s+database\b/i,
    ];

    for (const pattern of dbDestructionPatterns) {
      if (pattern.test(scanText)) {
        const audit = getSecurityAuditLogger();
        audit.logEvent({
          type: 'content_threat',
          severity: 'critical',
          source: 'guardian_agent',
          message: `Dangerous database operation blocked: pattern "${pattern.source}" detected in tool_call`,
          details: {
            agentId: action.agentId,
            pattern: pattern.source,
            contentPreview: scanText.slice(0, 200),
          },
        });
        return true;
      }
    }

    return false;
  }

  private detectCostOverrun(action: GuardianAction): boolean {
    const tokens = this.tokenUsage.get(action.agentId) ?? 0;
    const costUsd = tokens * this.config.costPerTokenUsd;
    return costUsd > this.config.maxCostPerRunUsd;
  }

  private scanForThreats(content: string): ContentThreat[] {
    const threats: ContentThreat[] = [];
    const lower = content.toLowerCase();

    const injectionPatterns = [
      /ignore\s+(all\s+)?previous\s+instructions/i,
      /you\s+are\s+now\s+a/i,
      /system\s*:\s*/i,
      /override\s+your\s+instructions/i,
      /forget\s+everything/i,
      /new\s+instructions?\s*:/i,
    ];

    for (const pattern of injectionPatterns) {
      if (pattern.test(content)) {
        const match = content.match(pattern);
        threats.push({
          type: 'prompt_injection',
          severity: 'HIGH',
          description: `Potential prompt injection: ${match?.[0] ?? 'pattern matched'}`,
          location: { start: 0, end: content.length, snippet: content.slice(0, 200) },
          remediation: 'Block execution and review agent behavior',
        });
      }
    }

    if (lower.includes('api_key') || lower.includes('secret') || lower.includes('password')) {
      threats.push({
        type: 'data_exfil_channel',
        severity: 'MEDIUM',
        description: 'Potential credential exposure in tool result',
        location: { start: 0, end: content.length, snippet: content.slice(0, 200) },
        remediation: 'Redact sensitive data from tool results',
      });
    }

    return threats;
  }

  // ── Behavioral Baseline Methods ────────────────────────────────────

  /**
   * Update the behavioral baseline for an agent using exponential moving average.
   * Baselines track: token usage rate, tool call frequency, tool distribution.
   */
  private updateBaseline(action: GuardianAction): void {
    let baseline = this.baselines.get(action.agentId);
    if (!baseline) {
      baseline = {
        avgTokensPerCall: 0,
        avgTokensPerMinute: 0,
        avgToolCallsPerMinute: 0,
        toolDistribution: new Map(),
        establishedAt: Date.now(),
        observationCount: 0,
        alpha: this.config.baselineAlpha,
      };
      this.baselines.set(action.agentId, baseline);
    }

    baseline.observationCount++;
    const alpha = baseline.alpha;

    // Token usage tracking
    const tokenMetadata = action.metadata as { tokens?: number } | undefined;
    const tokens = tokenMetadata?.tokens ?? 0;
    if (tokens > 0) {
      baseline.avgTokensPerCall = baseline.avgTokensPerCall * (1 - alpha) + tokens * alpha;

      // Token rate (per minute)
      const timestamps = this.tokenTimestamps.get(action.agentId) ?? [];
      timestamps.push(action.timestamp);
      const windowMs = 60_000;
      while (timestamps.length > 0 && timestamps[0]! < action.timestamp - windowMs) {
        timestamps.shift();
      }
      this.tokenTimestamps.set(action.agentId, timestamps);
      const rate = timestamps.length; // calls per minute window
      baseline.avgTokensPerMinute = baseline.avgTokensPerMinute * (1 - alpha) + rate * alpha;
    }

    // Tool call frequency — compute actual calls-per-minute from timestamp window
    if (action.type === 'tool_call') {
      const toolTimestamps = this.tokenTimestamps.get(`${action.agentId}::tools`) ?? [];
      toolTimestamps.push(action.timestamp);
      const windowMs = 60_000;
      while (toolTimestamps.length > 0 && toolTimestamps[0]! < action.timestamp - windowMs) {
        toolTimestamps.shift();
      }
      this.tokenTimestamps.set(`${action.agentId}::tools`, toolTimestamps);
      const currentRate = toolTimestamps.length;
      baseline.avgToolCallsPerMinute =
        baseline.avgToolCallsPerMinute * (1 - alpha) + currentRate * alpha;

      // Tool distribution
      const toolName =
        (action.metadata as { toolName?: string } | undefined)?.toolName ?? 'unknown';
      const currentCount = baseline.toolDistribution.get(toolName) ?? 0;
      (baseline.toolDistribution as Map<string, number>).set(toolName, currentCount + 1);
    }
  }

  /**
   * Detect when current behavior deviates significantly from the baseline.
   */
  private detectBaselineDeviation(agentId: string, action: GuardianAction): boolean {
    const baseline = this.baselines.get(agentId);
    if (!baseline || baseline.observationCount < this.config.baselineMinObservations) {
      return false;
    }

    const multiplier = this.config.baselineDeviationMultiplier;

    // Token usage spike check
    if (action.type === 'llm_call') {
      const tokenMetadata = action.metadata as { tokens?: number } | undefined;
      const tokens = tokenMetadata?.tokens ?? 0;
      if (baseline.avgTokensPerCall > 0 && tokens > baseline.avgTokensPerCall * multiplier) {
        return true;
      }
    }

    // Tool rate spike check
    if (action.type === 'tool_call' && baseline.avgToolCallsPerMinute > 0) {
      const history = this.actionHistory.get(agentId) ?? [];
      const windowMs = 60_000;
      const recentTools = history.filter(
        (a) => a.type === 'tool_call' && a.timestamp > action.timestamp - windowMs,
      );
      const currentRate = recentTools.length;
      if (currentRate > baseline.avgToolCallsPerMinute * multiplier) {
        return true;
      }
    }

    return false;
  }

  /**
   * Detect sudden spikes in tool usage that may indicate an attack.
   */
  private detectToolUsageSpike(action: GuardianAction): boolean {
    if (action.type !== 'tool_call') return false;
    const agentId = action.agentId;
    const history = this.actionHistory.get(agentId) ?? [];
    const window1s = 1000;
    const recentCalls = history.filter(
      (a) => a.type === 'tool_call' && a.timestamp > action.timestamp - window1s,
    );
    // More than 10 tool calls in 1 second is suspicious
    return recentCalls.length > 10;
  }

  /**
   * Detect potential data exfiltration in tool output.
   * Checks for: large base64 blobs, credential patterns, URL-encoded sensitive data.
   */
  private detectDataExfiltration(content: string): boolean {
    if (!content || content.length < 50) return false;

    // Large base64-encoded data (potential exfiltration)
    const base64Pattern = /[A-Za-z0-9+/]{200,}={0,2}/;
    if (base64Pattern.test(content)) {
      return true;
    }

    // Credential patterns in output
    const credentialPatterns = [
      /-----BEGIN\s+(?:\w+\s+)?PRIVATE\s+KEY-----/,
      /(?:sk-|pk-|ghp_|gho_|ghu_|ghs_|ghr_)[A-Za-z0-9_]{20,}/,
      /(?:AKIA|ASIA)[A-Z0-9]{16}/, // AWS access keys
      /xox[bpras]-[A-Za-z0-9-]{10,}/, // Slack tokens
      /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, // JWTs
    ];

    for (const pattern of credentialPatterns) {
      if (pattern.test(content)) {
        return true;
      }
    }

    // URL-encoded large payload (potential data smuggling)
    const urlEncodedPattern = /%[0-9A-Fa-f]{2}/g;
    const urlEncodedMatches = content.match(urlEncodedPattern);
    if (urlEncodedMatches && urlEncodedMatches.length > 100) {
      return true;
    }

    // PII patterns (email, phone, SSN)
    const piiPatterns = [
      /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/,
      /\b\d{3}[-.]?\d{2}[-.]?\d{4}\b/, // SSN-like
    ];
    let piiCount = 0;
    for (const pattern of piiPatterns) {
      const matches = content.match(new RegExp(pattern.source, 'g'));
      if (matches) piiCount += matches.length;
    }
    if (piiCount > 10) {
      return true; // Excessive PII in output suggests data dump
    }

    return false;
  }

  private intervene(
    type: GuardianInterventionType,
    action: GuardianAction,
  ): GuardianInterventionType {
    this.interventionCount++;
    this.pausedAgents.add(action.agentId);
    this.pauseTimestamps.set(action.agentId, Date.now());
    this.pauseReasons.set(action.agentId, type);

    const consecutive = (this.consecutiveAnomalies.get(action.agentId) ?? 0) + 1;
    this.consecutiveAnomalies.set(action.agentId, consecutive);

    try {
      getMetricsCollector().incrementCounter(
        'guardian_interventions_total',
        'Guardian agent interventions by type',
        1,
        [{ name: 'type', value: type }],
      );
    } catch (err) {
      reportSilentFailure(err, 'guardianAgent:514');
      /* best-effort */
    }

    const audit = getSecurityAuditLogger();
    audit.logEvent({
      type: 'content_threat',
      severity: type === 'safety_violation' ? 'critical' : 'high',
      source: 'guardian_agent',
      message: `Guardian intervention: ${type} for agent ${action.agentId}`,
      details: {
        agentId: action.agentId,
        interventionType: type,
        paused: true,
        consecutiveAnomalies: consecutive,
      },
    });

    return type;
  }
}

let defaultInstance: GuardianAgent | undefined;

export function getGuardianAgent(): GuardianAgent {
  if (!defaultInstance) {
    defaultInstance = new GuardianAgent();
  }
  return defaultInstance;
}

export function resetGuardianAgent(): void {
  defaultInstance = undefined;
}
