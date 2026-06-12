import type { TraceEvent } from '../runtime/types';

interface TokenUsageHistory {
  mean: number;
  stdDev: number;
  samples: number;
}

interface AnomalyAlert {
  timestamp: string;
  runId: string;
  agentId: string;
  stepNumber: number;
  tokenUsage: number;
  baseline: number;
  zScore: number;
  severity: 'info' | 'warning' | 'critical';
}

export class TokenUsageAnomalyDetector {
  private history: Map<string, TokenUsageHistory> = new Map();
  private alerts: AnomalyAlert[] = [];
  private readonly windowSize = 50;
  private readonly zScoreThreshold = 2.5;
  private readonly criticalZScore = 4.0;

  recordUsage(agentId: string, tokenUsage: number): void {
    const history = this.history.get(agentId) ?? { mean: 0, stdDev: 0, samples: 0 };
    const n = history.samples;
    const newMean = (history.mean * n + tokenUsage) / (n + 1);
    const variance = n > 0
      ? ((history.stdDev ** 2) * n + (tokenUsage - history.mean) * (tokenUsage - newMean)) / (n + 1)
      : 0;
    history.mean = newMean;
    history.stdDev = Math.sqrt(Math.max(variance, 0));
    history.samples = Math.min(n + 1, this.windowSize);
    this.history.set(agentId, history);
  }

  checkForAnomaly(agentId: string, runId: string, stepNumber: number, tokenUsage: number): AnomalyAlert | null {
    const history = this.history.get(agentId);
    if (!history || history.samples < 10) return null;

    if (history.stdDev === 0) {
      if (tokenUsage !== history.mean) {
        const alert: AnomalyAlert = {
          timestamp: new Date().toISOString(),
          runId, agentId, stepNumber,
          tokenUsage, baseline: history.mean,
          zScore: Infinity,
          severity: 'critical',
        };
        this.alerts.push(alert);
        return alert;
      }
      return null;
    }

    const zScore = (tokenUsage - history.mean) / history.stdDev;

    if (Math.abs(zScore) < this.zScoreThreshold) return null;

    const severity: AnomalyAlert['severity'] =
      Math.abs(zScore) >= this.criticalZScore ? 'critical' :
      Math.abs(zScore) >= this.zScoreThreshold ? 'warning' : 'info';

    const alert: AnomalyAlert = {
      timestamp: new Date().toISOString(),
      runId,
      agentId,
      stepNumber,
      tokenUsage,
      baseline: history.mean,
      zScore,
      severity,
    };

    this.alerts.push(alert);
    if (this.alerts.length > 1000) this.alerts.shift();
    return alert;
  }

  getAlerts(agentId?: string): AnomalyAlert[] {
    if (!agentId) return [...this.alerts];
    return this.alerts.filter(a => a.agentId === agentId);
  }

  getHistory(agentId: string): TokenUsageHistory | undefined {
    return this.history.get(agentId);
  }

  getBaseline(agentId: string): number {
    return this.history.get(agentId)?.mean ?? 0;
  }
}

let globalDetector: TokenUsageAnomalyDetector | null = null;

export function getAnomalyDetector(): TokenUsageAnomalyDetector {
  if (!globalDetector) globalDetector = new TokenUsageAnomalyDetector();
  return globalDetector;
}

export function resetAnomalyDetector(): void {
  globalDetector = null;
}
