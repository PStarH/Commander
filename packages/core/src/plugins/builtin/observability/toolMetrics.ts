import type { TraceEvent } from '../../../runtime/types';

interface ToolStats {
  toolName: string;
  invocations: number;
  successes: number;
  failures: number;
  totalDurationMs: number;
  avgDurationMs: number;
  lastUsed: string;
}

interface ToolMetricsSummary {
  totalTools: number;
  totalInvocations: number;
  overallSuccessRate: number;
  tools: ToolStats[];
}

export class ToolMetricsCollector {
  private toolStats: Map<string, ToolStats> = new Map();

  recordToolExecution(event: TraceEvent): void {
    if (event.type !== 'tool_execution') return;
    const toolName = String(event.data.input ?? 'unknown');
    const hasError = !!event.data.error;

    let stats = this.toolStats.get(toolName);
    if (!stats) {
      stats = {
        toolName,
        invocations: 0,
        successes: 0,
        failures: 0,
        totalDurationMs: 0,
        avgDurationMs: 0,
        lastUsed: event.timestamp,
      };
      this.toolStats.set(toolName, stats);
    }

    stats.invocations++;
    if (hasError) stats.failures++;
    else stats.successes++;
    stats.totalDurationMs += event.durationMs;
    stats.avgDurationMs = stats.totalDurationMs / stats.invocations;
    if (event.timestamp > stats.lastUsed) stats.lastUsed = event.timestamp;
  }

  recordFromTrace(events: TraceEvent[]): void {
    for (const e of events) this.recordToolExecution(e);
  }

  getToolStats(toolName: string): ToolStats | undefined {
    return this.toolStats.get(toolName);
  }

  getAllStats(): ToolStats[] {
    return Array.from(this.toolStats.values()).sort((a, b) => b.invocations - a.invocations);
  }

  getSuccessRate(toolName: string): number {
    const stats = this.toolStats.get(toolName);
    if (!stats || stats.invocations === 0) return 0;
    return stats.successes / stats.invocations;
  }

  getSummary(): ToolMetricsSummary {
    const tools = this.getAllStats();
    const totalInvocations = tools.reduce((sum, t) => sum + t.invocations, 0);
    const totalSuccesses = tools.reduce((sum, t) => sum + t.successes, 0);
    return {
      totalTools: tools.length,
      totalInvocations,
      overallSuccessRate: totalInvocations > 0 ? totalSuccesses / totalInvocations : 0,
      tools,
    };
  }
}

let globalCollector: ToolMetricsCollector | null = null;

export function getToolMetricsCollector(): ToolMetricsCollector {
  if (!globalCollector) globalCollector = new ToolMetricsCollector();
  return globalCollector;
}

export function resetToolMetricsCollector(): void {
  globalCollector = null;
}
