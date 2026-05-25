import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getGlobalLogger } from '../logging';
import type { WorkflowDefinition, ScheduleEntry, ExecutionRecord, SchedulerConfig, WorkflowTrigger } from './types';
import type { UltimateOrchestrator } from '../ultimate/orchestrator';
import type { EffortLevel, OrchestrationTopology } from '../ultimate/types';

// ============================================================================
// Default config
// ============================================================================

const DEFAULT_CONFIG: SchedulerConfig = {
  tickIntervalMs: 30_000,
  maxConcurrency: 3,
  stateDir: path.join(process.cwd(), '.commander', 'scheduler'),
  workflowDirs: [
    path.join(process.cwd(), '.commander', 'workflows'),
    path.join(os.homedir(), '.commander', 'workflows'),
  ],
};

// ============================================================================
// Cron parser — minimal 5-field: minute hour day month weekday
// ============================================================================

function cronMatches(cronExpr: string, date: Date): boolean {
  const fields = cronExpr.trim().split(/\s+/);
  if (fields.length !== 5) return false;

  const minute = date.getMinutes();
  const hour = date.getHours();
  const day = date.getDate();
  const month = date.getMonth() + 1;
  const weekday = date.getDay();

  const values = [minute, hour, day, month, weekday];
  for (let i = 0; i < 5; i++) {
    if (!cronFieldMatches(fields[i], values[i])) return false;
  }
  return true;
}

function cronFieldMatches(pattern: string, value: number): boolean {
  if (pattern === '*') return true;

  // Handle comma-separated: "1,15,30"
  if (pattern.includes(',')) {
    return pattern.split(',').some(p => cronFieldMatches(p.trim(), value));
  }

  // Handle step: "*/5" or "1-10/2"
  const stepMatch = pattern.match(/^(\d+)(?:-(\d+))?\/(\d+)$/);
  if (stepMatch) {
    const start = parseInt(stepMatch[1], 10);
    const end = stepMatch[2] ? parseInt(stepMatch[2], 10) : 59;
    const step = parseInt(stepMatch[3], 10);
    if (value < start || value > end) return false;
    return (value - start) % step === 0;
  }

  // Handle range: "1-5"
  const rangeMatch = pattern.match(/^(\d+)-(\d+)$/);
  if (rangeMatch) {
    return value >= parseInt(rangeMatch[1], 10) && value <= parseInt(rangeMatch[2], 10);
  }

  // Exact number
  const num = parseInt(pattern, 10);
  if (!isNaN(num)) return value === num;

  return false;
}

// ============================================================================
// Interval parser — "30m", "2h", "1d" → ms
// ============================================================================

function parseInterval(interval: string): number {
  const match = interval.match(/^(\d+)\s*(s|m|h|d)$/);
  if (!match) return 30 * 60 * 1000; // default 30m
  const num = parseInt(match[1], 10);
  switch (match[2]) {
    case 's': return num * 1000;
    case 'm': return num * 60 * 1000;
    case 'h': return num * 60 * 60 * 1000;
    case 'd': return num * 24 * 60 * 60 * 1000;
    default: return 30 * 60 * 1000;
  }
}

// ============================================================================
// Scheduler
// ============================================================================

export class Scheduler {
  private config: SchedulerConfig;
  private orchestrator?: UltimateOrchestrator;
  private schedules: Map<string, ScheduleEntry> = new Map();
  private executionRecords: ExecutionRecord[] = [];
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private running: number = 0;
  private statePath: string;
  private recordsPath: string;

  constructor(config?: Partial<SchedulerConfig>, orchestrator?: UltimateOrchestrator) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.orchestrator = orchestrator;
    this.statePath = path.join(this.config.stateDir, 'schedules.json');
    this.recordsPath = path.join(this.config.stateDir, 'executions.json');
    fs.mkdirSync(this.config.stateDir, { recursive: true });
    this.loadState();
  }

  setOrchestrator(orch: UltimateOrchestrator): void {
    this.orchestrator = orch;
  }

  getConfig(): SchedulerConfig {
    return { ...this.config };
  }

  // ========================================================================
  // Schedule management
  // ========================================================================

  add(entry: ScheduleEntry): void {
    entry.nextRunAt = this.computeNextRun(entry.trigger);
    this.schedules.set(entry.id, entry);
    this.saveState();
    getGlobalLogger().info('Scheduler', `Scheduled "${entry.workflowName}" (${entry.id})`, {
      trigger: entry.trigger,
      nextRun: entry.nextRunAt,
    });
  }

  remove(id: string): boolean {
    const existed = this.schedules.delete(id);
    if (existed) this.saveState();
    return existed;
  }

  get(id: string): ScheduleEntry | undefined {
    return this.schedules.get(id);
  }

  list(): ScheduleEntry[] {
    return [...this.schedules.values()];
  }

  enable(id: string): boolean {
    const entry = this.schedules.get(id);
    if (!entry) return false;
    entry.enabled = true;
    entry.nextRunAt = this.computeNextRun(entry.trigger);
    this.saveState();
    return true;
  }

  disable(id: string): boolean {
    const entry = this.schedules.get(id);
    if (!entry) return false;
    entry.enabled = false;
    entry.nextRunAt = undefined;
    this.saveState();
    return true;
  }

  getHistory(workflowId?: string): ExecutionRecord[] {
    if (workflowId) return this.executionRecords.filter(r => r.workflowId === workflowId);
    return [...this.executionRecords];
  }

  // ========================================================================
  // Lifecycle
  // ========================================================================

  start(): void {
    if (this.tickTimer) return;
    getGlobalLogger().info('Scheduler', `Starting scheduler (tick=${this.config.tickIntervalMs}ms)`);
    this.tickTimer = setInterval(() => this.tick(), this.config.tickIntervalMs);
    // Fire an immediate tick
    setImmediate(() => this.tick());
  }

  stop(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    getGlobalLogger().info('Scheduler', 'Scheduler stopped');
  }

  // ========================================================================
  // Tick — check and fire due workflows
  // ========================================================================

  private async tick(): Promise<void> {
    const now = new Date();

    for (const [id, entry] of this.schedules) {
      if (!entry.enabled) continue;
      if (!entry.nextRunAt) continue;
      if (this.running >= this.config.maxConcurrency) break;

      const nextRun = new Date(entry.nextRunAt);
      if (now < nextRun) continue;

      // Due — fire it
      this.running++;
      const record = this.createRecord(entry);
      entry.lastRunAt = now.toISOString();
      entry.runCount++;

      this.fireWorkflow(entry, record)
        .catch(err => {
          getGlobalLogger().error('Scheduler', `Workflow "${entry.workflowName}" failed`, err);
          record.status = 'failed';
          record.error = err.message;
          record.completedAt = new Date().toISOString();
        })
        .finally(() => {
          this.running--;
          entry.nextRunAt = this.computeNextRun(entry.trigger);
          this.saveState();
          this.persistRecord(record);
        });
    }
  }

  private async fireWorkflow(entry: ScheduleEntry, record: ExecutionRecord): Promise<void> {
    const orch = this.orchestrator;
    if (!orch) {
      throw new Error('No orchestrator set — call setOrchestrator() before starting');
    }

    getGlobalLogger().info('Scheduler', `Firing workflow "${entry.workflowName}" (${entry.workflowId})`);

    const result = await orch.execute({
      projectId: 'scheduler',
      agentId: `scheduler-${entry.workflowId}`,
      goal: entry.workflowName,
      contextData: {
        scheduleId: entry.id,
        workflowId: entry.workflowId,
        runId: record.id,
      },
      effortLevel: 'AUTO' as unknown as EffortLevel,
    });

    record.completedAt = new Date().toISOString();
    record.status = result.status === 'SUCCESS' ? 'success' : result.status === 'FAILED' ? 'failed' : 'cancelled';
    record.summary = result.summary;
    record.durationMs = result.metrics.totalDurationMs;
    record.tokenUsage = {
      input: result.metrics.totalTokens,
      output: 0,
      total: result.metrics.totalTokens,
    };

    getGlobalLogger().info('Scheduler', `Workflow "${entry.workflowName}" ${record.status}`, {
      durationMs: record.durationMs,
    });
  }

  // ========================================================================
  // Cron utility — compute next run time
  // ========================================================================

  private computeNextRun(trigger: WorkflowTrigger): string | undefined {
    switch (trigger.type) {
      case 'cron': {
        if (!trigger.cron) return undefined;
        // Scan forward up to 48 hours to find the next match
        const now = new Date();
        for (let i = 0; i < 24 * 60 * 2; i++) {
          const candidate = new Date(now.getTime() + i * 60_000);
          if (cronMatches(trigger.cron, candidate)) {
            return candidate.toISOString();
          }
        }
        return undefined;
      }
      case 'interval': {
        const ms = parseInterval(trigger.interval ?? '30m');
        return new Date(Date.now() + ms).toISOString();
      }
      case 'once': {
        // If the "at" time has passed, don't schedule again
        if (trigger.at && new Date(trigger.at) > new Date()) return trigger.at;
        return undefined;
      }
      default:
        return undefined;
    }
  }

  // ========================================================================
  // Persistence
  // ========================================================================

  private loadState(): void {
    try {
      if (fs.existsSync(this.statePath)) {
        const data = JSON.parse(fs.readFileSync(this.statePath, 'utf-8'));
        for (const entry of data.schedules ?? []) {
          this.schedules.set(entry.id, entry);
        }
      }
      if (fs.existsSync(this.recordsPath)) {
        this.executionRecords = JSON.parse(fs.readFileSync(this.recordsPath, 'utf-8'));
      }
    } catch (err) {
      getGlobalLogger().warn('Scheduler', 'Failed to load state', { error: (err as Error).message });
    }
  }

  private saveState(): void {
    try {
      const data = { schedules: [...this.schedules.values()] };
      const tmpPath = this.statePath + '.tmp';
      fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
      fs.renameSync(tmpPath, this.statePath);
    } catch (err) {
      getGlobalLogger().warn('Scheduler', 'Failed to save state', { error: (err as Error).message });
    }
  }

  private persistRecord(record: ExecutionRecord): void {
    this.executionRecords.push(record);
    // Keep last 100 records
    if (this.executionRecords.length > 100) {
      this.executionRecords = this.executionRecords.slice(-100);
    }
    try {
      const tmpPath = this.recordsPath + '.tmp';
      fs.writeFileSync(tmpPath, JSON.stringify(this.executionRecords, null, 2));
      fs.renameSync(tmpPath, this.recordsPath);
    } catch (err) {
      getGlobalLogger().warn('Scheduler', 'Failed to persist execution record', { error: (err as Error).message });
    }
  }

  private createRecord(entry: ScheduleEntry): ExecutionRecord {
    return {
      id: `exec-${entry.workflowId}-${Date.now()}`,
      scheduleId: entry.id,
      workflowId: entry.workflowId,
      startedAt: new Date().toISOString(),
      status: 'running',
    };
  }
}
