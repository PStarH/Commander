/**
 * RunLifecycleManager — tracks active and paused runs for AgentRuntime.
 *
 * Extracted from AgentRuntime so the god object only delegates.
 * Keeps the `commander_active_runs` Prometheus gauge in sync on every
 * add/remove so the dashboard never drifts from the runtime state.
 */

import { getMetricsCollector } from './metricsCollector';

export class RunLifecycleManager {
  private activeRuns: Set<string> = new Set();
  private pausedRuns: Set<string> = new Set();

  addRun(runId: string): void {
    this.activeRuns.add(runId);
    this.emitActiveRuns();
  }

  removeRun(runId: string): void {
    this.activeRuns.delete(runId);
    this.pausedRuns.delete(runId);
    this.emitActiveRuns();
  }

  pauseRun(runId: string): boolean {
    if (!this.activeRuns.has(runId)) return false;
    this.pausedRuns.add(runId);
    return true;
  }

  unpauseRun(runId: string): void {
    this.pausedRuns.delete(runId);
  }

  isPaused(runId: string): boolean {
    return this.pausedRuns.has(runId);
  }

  isActive(runId: string): boolean {
    return this.activeRuns.has(runId);
  }

  getActiveRunCount(): number {
    return this.activeRuns.size;
  }

  getActiveRuns(): string[] {
    return Array.from(this.activeRuns);
  }

  private emitActiveRuns(): void {
    getMetricsCollector().setActiveRuns(this.activeRuns.size);
  }
}
