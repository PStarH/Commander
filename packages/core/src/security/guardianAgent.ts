import { getSecurityMonitor, type SecurityAlert } from './securityMonitor';
import { getSecurityAuditLogger } from './securityAuditLogger';
import type { ContentThreat } from '../contentScanner';

export type GuardianInterventionType =
  | 'semantic_drift'
  | 'anomaly'
  | 'safety_violation'
  | 'cost_overrun'
  | 'goal_hijack';

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

export interface GuardianConfig {
  enabled: boolean;
  semanticDriftThreshold: number;
  anomalyWindowSize: number;
  anomalyStddevMultiplier: number;
  maxConsecutiveAnomalies: number;
  costPerTokenUsd: number;
  maxCostPerRunUsd: number;
}

const DEFAULT_CONFIG: GuardianConfig = {
  enabled: true,
  semanticDriftThreshold: 0.7,
  anomalyWindowSize: 20,
  anomalyStddevMultiplier: 2.5,
  maxConsecutiveAnomalies: 3,
  costPerTokenUsd: 0.000002,
  maxCostPerRunUsd: 5.0,
};

export class GuardianAgent {
  private config: GuardianConfig;
  private actionHistory = new Map<string, GuardianAction[]>();
  private interventionCount = 0;
  private pausedAgents = new Set<string>();
  private tokenUsage = new Map<string, number>();
  private consecutiveAnomalies = new Map<string, number>();

  constructor(config: Partial<GuardianConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  monitor(action: GuardianAction): GuardianInterventionType | null {
    if (!this.config.enabled) return null;

    this.appendToHistory(action);

    const drift = this.detectSemanticDrift(action);
    if (drift) return this.intervene('semantic_drift', action);

    const anomaly = this.detectAnomaly(action.agentId);
    if (anomaly) return this.intervene('anomaly', action);

    const safety = this.detectSafetyViolation(action);
    if (safety) return this.intervene('safety_violation', action);

    const cost = this.detectCostOverrun(action);
    if (cost) return this.intervene('cost_overrun', action);

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

  reset(): void {
    this.actionHistory.clear();
    this.interventionCount = 0;
    this.pausedAgents.clear();
    this.tokenUsage.clear();
    this.consecutiveAnomalies.clear();
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
      const burstCount = intervals.filter((i) => i < mean - stddev * this.config.anomalyStddevMultiplier).length;
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

  private intervene(type: GuardianInterventionType, action: GuardianAction): GuardianInterventionType {
    this.interventionCount++;
    this.pausedAgents.add(action.agentId);

    const consecutive = (this.consecutiveAnomalies.get(action.agentId) ?? 0) + 1;
    this.consecutiveAnomalies.set(action.agentId, consecutive);

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
