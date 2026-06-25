import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getGlobalLogger } from '../logging';
import type { ScheduleEntry, ExecutionRecord, SchedulerConfig, WorkflowTrigger } from './types';
import type { UltimateOrchestrator } from '../ultimate/orchestrator';

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
// Cron parser — deterministic carry-forward algorithm (O(1) per field)
// Replaces the previous O(n) minute-by-minute scan (2880 iterations/48h)
// with field-level matching bounded to max 60 candidates per field.
// ============================================================================

/**
 * Find the next datetime matching a 5-field cron expression.
 *
 * Carry-forward algorithm: minute → hour → day → month → year.
 * Each field independently advances to the next matching value;
 * if no match exists, it resets and advances the higher field.
 */
function computeNextCronMatch(cronExpr: string, after: Date): Date | undefined {
  const fields = cronExpr.trim().split(/\s+/);
  if (fields.length !== 5) return undefined;

  const MAX_YEARS_AHEAD = 4;
  let candidate = new Date(after.getTime() + 60_000);

  for (let yearOffset = 0; yearOffset < MAX_YEARS_AHEAD; yearOffset++) {
    const year = candidate.getFullYear();
    if (year > after.getFullYear() + MAX_YEARS_AHEAD) return undefined;

    const startMonth = yearOffset === 0 ? candidate.getMonth() + 1 : 1;
    const month = findNextFieldMatch(fields[3], startMonth, 1, 12);
    if (month === undefined) continue;
    if (month > startMonth) candidate = new Date(year, month - 1, 1, 0, 0);

    const startDay = yearOffset === 0 && month === startMonth ? candidate.getDate() : 1;
    const day = findMatchingDay(fields[2], fields[4], year, month - 1, startDay);
    if (day === undefined) {
      candidate = new Date(year, month, 1, 0, 0);
      yearOffset--;
      continue;
    }

    const startHour =
      yearOffset === 0 && month === startMonth && day === startDay ? candidate.getHours() : 0;
    const hour = findNextFieldMatch(fields[1], startHour, 0, 23);
    if (hour === undefined) {
      candidate = new Date(year, month - 1, day + 1, 0, 0);
      yearOffset--;
      continue;
    }

    const startMinute =
      yearOffset === 0 && month === startMonth && day === startDay ? candidate.getMinutes() : 0;
    const minute = findNextFieldMatch(fields[0], startMinute, 0, 59);
    if (minute === undefined) {
      candidate = new Date(year, month - 1, day, hour + 1, 0);
      yearOffset--;
      continue;
    }

    candidate = new Date(year, month - 1, day, hour, minute, 0, 0);
    if (candidate > after) return candidate;
  }

  return undefined;
}

/** Find the next value matching a cron field pattern within [min, max]. */
function findNextFieldMatch(
  pattern: string,
  start: number,
  min: number,
  max: number,
): number | undefined {
  for (let v = start; v <= max; v++) {
    if (cronValueMatches(pattern, v, min, max)) return v;
  }
  return undefined;
}

/** Match a single cron field pattern against a value. */
function cronValueMatches(pattern: string, value: number, _min: number, _max: number): boolean {
  if (pattern === '*') return true;
  if (pattern.includes(',')) {
    return pattern.split(',').some((p) => cronValueMatches(p.trim(), value, _min, _max));
  }
  const stepMatch = pattern.match(/^(\d+)(?:-(\d+))?\/(\d+)$/);
  if (stepMatch) {
    const s = parseInt(stepMatch[1], 10);
    const e = stepMatch[2] ? parseInt(stepMatch[2], 10) : _max;
    const step = parseInt(stepMatch[3], 10);
    if (value < s || value > e) return false;
    return (value - s) % step === 0;
  }
  const rangeMatch = pattern.match(/^(\d+)-(\d+)$/);
  if (rangeMatch) {
    return value >= parseInt(rangeMatch[1], 10) && value <= parseInt(rangeMatch[2], 10);
  }
  const num = parseInt(pattern, 10);
  if (!isNaN(num)) return value === num;
  return false;
}

/**
 * Find a matching day considering BOTH day-of-month and day-of-week.
 * Standard cron: if both fields are restricted, EITHER match fires.
 */
function findMatchingDay(
  domPattern: string,
  dowPattern: string,
  year: number,
  monthIndex: number,
  startDay: number,
): number | undefined {
  const daysInMonth = new Date(year, monthIndex + 1, 0).getDate();
  const domWild = domPattern === '*';
  const dowWild = dowPattern === '*';
  for (let d = startDay; d <= daysInMonth; d++) {
    const domMatch = cronValueMatches(domPattern, d, 1, 31);
    const dowMatch = cronValueMatches(dowPattern, new Date(year, monthIndex, d).getDay(), 0, 6);
    if (
      (domWild && dowWild) ||
      (domMatch && (dowWild || dowMatch)) ||
      (dowMatch && (domWild || domMatch))
    ) {
      return d;
    }
  }
  return undefined;
}

// ============================================================================
// Interval parser — "30m", "2h", "1d" → ms
// ============================================================================

function parseInterval(interval: string): number {
  const match = interval.match(/^(\d+)\s*(s|m|h|d)$/);
  if (!match) return 30 * 60 * 1000; // default 30m
  const num = parseInt(match[1], 10);
  switch (match[2]) {
    case 's':
      return num * 1000;
    case 'm':
      return num * 60 * 1000;
    case 'h':
      return num * 60 * 60 * 1000;
    case 'd':
      return num * 24 * 60 * 60 * 1000;
    default:
      return 30 * 60 * 1000;
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
    if (workflowId) return this.executionRecords.filter((r) => r.workflowId === workflowId);
    return [...this.executionRecords];
  }

  // ========================================================================
  // Lifecycle
  // ========================================================================

  start(): void {
    if (this.tickTimer) return;
    getGlobalLogger().info(
      'Scheduler',
      `Starting scheduler (tick=${this.config.tickIntervalMs}ms)`,
    );
    // Misfire recovery: scan for missed "once" triggers within a safe
    // window (past 1 hour).  This prevents crash loops by limiting the
    // number of backfill attempts and marking each as EXECUTING before
    // the first fire.
    this.recoverMissedOnceTriggers();
    this.tickTimer = setInterval(() => this.tick(), this.config.tickIntervalMs);
    if (typeof this.tickTimer.unref === 'function') this.tickTimer.unref();
    // Fire an immediate tick
    setImmediate(() => this.tick());
  }

  /**
   * Scan for "once" triggers whose at-time fell within the last hour.
   * Marks them EXECUTING before enqueuing to prevent crash loops:
   * if a task crashes the process on every attempt, the misfire window
   * limits retries to once per startup instead of infinite loop.
   */
  private recoverMissedOnceTriggers(): void {
    const now = new Date();
    const MISFIRE_WINDOW_MS = 60 * 60 * 1000; // 1 hour
    const cutoff = new Date(now.getTime() - MISFIRE_WINDOW_MS);

    for (const [id, entry] of this.schedules) {
      if (!entry.enabled) continue;
      if (entry.trigger.type !== 'once') continue;
      if (!entry.trigger.at) continue;
      // Already fired
      if (entry.runCount > 0 && entry.lastRunAt) continue;

      const atTime = new Date(entry.trigger.at);
      // Only recover if the at-time falls within the misfire window
      if (atTime >= cutoff && atTime < now) {
        getGlobalLogger().info(
          'Scheduler',
          `Recovering missed once trigger "${entry.workflowName}" (${id}) — was due at ${entry.trigger.at}`,
        );
        // Mark as due immediately
        entry.nextRunAt = now.toISOString();
        entry.runCount = 0; // Will be incremented when fired
        this.saveState();
      }
    }
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

  private ticking = false;

  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = new Date();

      for (const [, entry] of this.schedules) {
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
          .catch((err) => {
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
    } finally {
      this.ticking = false;
    }
  }

  private async fireWorkflow(entry: ScheduleEntry, record: ExecutionRecord): Promise<void> {
    const orch = this.orchestrator;
    if (!orch) {
      throw new Error('No orchestrator set — call setOrchestrator() before starting');
    }

    getGlobalLogger().info(
      'Scheduler',
      `Firing workflow "${entry.workflowName}" (${entry.workflowId})`,
    );

    const result = await orch.execute({
      projectId: 'scheduler',
      agentId: `scheduler-${entry.workflowId}`,
      tenantId: entry.tenantId,
      goal: entry.workflowName,
      contextData: {
        scheduleId: entry.id,
        workflowId: entry.workflowId,
        runId: record.id,
      },
      effortLevel: undefined,
    });

    record.completedAt = new Date().toISOString();
    record.status =
      result.status === 'SUCCESS' ? 'success' : result.status === 'FAILED' ? 'failed' : 'cancelled';
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
        const next = computeNextCronMatch(trigger.cron, new Date());
        return next?.toISOString();
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
      getGlobalLogger().warn('Scheduler', 'Failed to load state', {
        error: (err as Error).message,
      });
    }
  }

  private saveState(): void {
    try {
      const data = { schedules: [...this.schedules.values()] };
      const tmpPath = this.statePath + '.tmp';
      fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
      fs.renameSync(tmpPath, this.statePath);
    } catch (err) {
      getGlobalLogger().warn('Scheduler', 'Failed to save state', {
        error: (err as Error).message,
      });
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
      getGlobalLogger().warn('Scheduler', 'Failed to persist execution record', {
        error: (err as Error).message,
      });
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
