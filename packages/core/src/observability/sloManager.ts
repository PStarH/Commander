import type { ExecutionTrace } from '../runtime/types';

interface SLODefinition {
  id: string;
  name: string;
  description?: string;
  metric: 'latency_ms' | 'cost_usd' | 'tokens' | 'error_rate' | 'success_rate';
  threshold: number;
  operator: 'lt' | 'lte' | 'gt' | 'gte' | 'eq';
  windowSize: number;
  alertChannels: string[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

interface SLOViolation {
  sloId: string;
  timestamp: string;
  runId: string;
  metric: string;
  actualValue: number;
  threshold: number;
  severity: 'warning' | 'critical';
}

interface SLOStatus {
  sloId: string;
  name: string;
  metric: string;
  threshold: number;
  currentValue: number;
  isViolating: boolean;
  violationCount: number;
  lastChecked: string;
}

export class SLOManager {
  private slos: Map<string, SLODefinition> = new Map();
  private violations: SLOViolation[] = [];

  createSLO(slo: Omit<SLODefinition, 'id' | 'createdAt' | 'updatedAt'>): SLODefinition {
    const id = `slo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const newSlo: SLODefinition = {
      ...slo,
      id,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.slos.set(id, newSlo);
    return newSlo;
  }

  updateSLO(id: string, updates: Partial<SLODefinition>): SLODefinition | undefined {
    const slo = this.slos.get(id);
    if (!slo) return undefined;
    const updated = { ...slo, ...updates, id, updatedAt: new Date().toISOString() };
    this.slos.set(id, updated);
    return updated;
  }

  deleteSLO(id: string): boolean {
    return this.slos.delete(id);
  }

  getSLO(id: string): SLODefinition | undefined {
    return this.slos.get(id);
  }

  listSLOs(): SLODefinition[] {
    return Array.from(this.slos.values());
  }

  checkTrace(trace: ExecutionTrace): SLOViolation[] {
    const violations: SLOViolation[] = [];

    for (const slo of this.slos.values()) {
      if (!slo.enabled) continue;

      let actualValue: number;
      switch (slo.metric) {
        case 'latency_ms':
          actualValue = trace.summary.totalDurationMs;
          break;
        case 'tokens':
          actualValue = trace.summary.totalTokens;
          break;
        case 'error_rate':
          actualValue = trace.summary.errors / Math.max(trace.summary.totalEvents, 1);
          break;
        case 'success_rate':
          actualValue = 1 - (trace.summary.errors / Math.max(trace.summary.totalEvents, 1));
          break;
        case 'cost_usd':
          actualValue = 0;
          break;
        default:
          continue;
      }

      let violated = false;
      switch (slo.operator) {
        case 'lt': violated = actualValue < slo.threshold; break;
        case 'lte': violated = actualValue <= slo.threshold; break;
        case 'gt': violated = actualValue > slo.threshold; break;
        case 'gte': violated = actualValue >= slo.threshold; break;
        case 'eq': violated = actualValue === slo.threshold; break;
      }

      if (violated) {
        const severity: SLOViolation['severity'] = slo.metric === 'error_rate' ? 'critical' : 'warning';
        const violation: SLOViolation = {
          sloId: slo.id,
          timestamp: new Date().toISOString(),
          runId: trace.runId,
          metric: slo.metric,
          actualValue,
          threshold: slo.threshold,
          severity,
        };
        violations.push(violation);
        this.violations.push(violation);
      }
    }

    return violations;
  }

  getViolations(sloId?: string): SLOViolation[] {
    if (sloId) return this.violations.filter(v => v.sloId === sloId);
    return [...this.violations];
  }

  getStatus(): SLOStatus[] {
    return Array.from(this.slos.values()).map(slo => {
      const recentViolations = this.violations
        .filter(v => v.sloId === slo.id)
        .slice(-100);
      const violationCount = recentViolations.length;
      const lastViolation = recentViolations[recentViolations.length - 1];
      const currentValue = lastViolation?.actualValue ?? 0;

      return {
        sloId: slo.id,
        name: slo.name,
        metric: slo.metric,
        threshold: slo.threshold,
        currentValue,
        isViolating: violationCount > 0 && lastViolation &&
          new Date(lastViolation.timestamp).getTime() > Date.now() - 60000,
        violationCount,
        lastChecked: new Date().toISOString(),
      };
    });
  }
}

let globalManager: SLOManager | null = null;

export function getSLOManager(): SLOManager {
  if (!globalManager) globalManager = new SLOManager();
  return globalManager;
}

export function resetSLOManager(): void {
  globalManager = null;
}
