/**
 * Task Scheduler Infrastructure
 *
 * Manages scheduled (cron-like) tasks that run automatically.
 * Integrates with BackgroundTaskManager for execution.
 *
 * Usage:
 *   commander schedule add "backup db" --cron "0 2 * * *"
 *   commander schedule add "run tests" --every 30m
 *   commander schedule list
 *   commander schedule remove <id>
 */

import * as fs from 'fs';
import * as path from 'path';
import { getGlobalLogger } from '../logging';
import { getBackgroundTaskManager } from './background';

// ============================================================================
// Types
// ============================================================================

export interface ScheduledTask {
  id: string;
  name: string;
  task: string;
  cron?: string; // Cron expression: "0 2 * * *"
  intervalMs?: number; // Interval in ms: 1800000 (30m)
  enabled: boolean;
  lastRunAt?: string;
  nextRunAt?: string;
  runCount: number;
  lastStatus?: 'success' | 'failed';
  createdAt: string;
  metadata: Record<string, unknown>;
}

export interface ScheduleOptions {
  name: string;
  task: string;
  cron?: string;
  every?: string; // "30m", "1h", "2d"
  enabled?: boolean;
  metadata?: Record<string, unknown>;
}

// ============================================================================
// Cron Parser (simple)
// ============================================================================

function parseCron(expr: string): {
  minute: number[];
  hour: number[];
  dayOfMonth: number[];
  month: number[];
  dayOfWeek: number[];
} | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;

  const parseField = (field: string, min: number, max: number): number[] => {
    if (field === '*') return Array.from({ length: max - min + 1 }, (_, i) => i + min);
    if (field.includes(',')) return field.split(',').flatMap((f) => parseField(f, min, max));
    if (field.includes('-')) {
      const [start, end] = field.split('-').map(Number);
      return Array.from({ length: end - start + 1 }, (_, i) => start + i);
    }
    if (field.includes('/')) {
      const [rangePart, stepStr] = field.split('/');
      const step = Number(stepStr);
      let start: number;
      if (rangePart === '*') {
        start = min;
      } else if (rangePart.includes('-')) {
        const [s] = rangePart.split('-').map(Number);
        start = s;
      } else {
        start = Number(rangePart);
      }
      return Array.from(
        { length: Math.floor((max - start) / step) + 1 },
        (_, i) => start + i * step,
      );
    }
    return [Number(field)];
  };

  try {
    return {
      minute: parseField(parts[0], 0, 59),
      hour: parseField(parts[1], 0, 23),
      dayOfMonth: parseField(parts[2], 1, 31),
      month: parseField(parts[3], 1, 12),
      dayOfWeek: parseField(parts[4], 0, 6),
    };
  } catch {
    return null;
  }
}

function matchesCron(cron: ReturnType<typeof parseCron>, date: Date): boolean {
  if (!cron) return false;
  return (
    cron.minute.includes(date.getMinutes()) &&
    cron.hour.includes(date.getHours()) &&
    cron.dayOfMonth.includes(date.getDate()) &&
    cron.month.includes(date.getMonth() + 1) &&
    cron.dayOfWeek.includes(date.getDay())
  );
}

function parseInterval(expr: string): number | null {
  const match = expr.match(/^(\d+)(s|m|h|d)$/);
  if (!match) return null;
  const value = parseInt(match[1]);
  const unit = match[2];
  switch (unit) {
    case 's':
      return value * 1000;
    case 'm':
      return value * 60 * 1000;
    case 'h':
      return value * 60 * 60 * 1000;
    case 'd':
      return value * 24 * 60 * 60 * 1000;
    default:
      return null;
  }
}

function getNextRunTime(task: ScheduledTask): Date | null {
  if (task.cron) {
    const cron = parseCron(task.cron);
    if (!cron) return null;

    const now = new Date();
    const next = new Date(now);
    next.setSeconds(0);
    next.setMilliseconds(0);
    next.setMinutes(next.getMinutes() + 1);

    // Find next matching time (within 7 days to cover all day-of-week combinations)
    for (let i = 0; i < 10080; i++) {
      if (matchesCron(cron, next)) return next;
      next.setMinutes(next.getMinutes() + 1);
    }
    return null;
  }

  if (task.intervalMs) {
    const lastRun = task.lastRunAt ? new Date(task.lastRunAt) : new Date();
    return new Date(lastRun.getTime() + task.intervalMs);
  }

  return null;
}

// ============================================================================
// Scheduler
// ============================================================================

export class TaskScheduler {
  private tasks: Map<string, ScheduledTask> = new Map();
  private tasksDir: string;
  private checkInterval: NodeJS.Timeout | null = null;
  private running = false;

  constructor(baseDir?: string) {
    this.tasksDir = baseDir ?? path.join(process.cwd(), '.commander', 'scheduler');
    this.ensureDir();
    this.loadTasks();
  }

  private ensureDir(): void {
    fs.mkdirSync(this.tasksDir, { recursive: true });
  }

  private loadTasks(): void {
    try {
      const indexFile = path.join(this.tasksDir, 'index.json');
      if (fs.existsSync(indexFile)) {
        const data = JSON.parse(fs.readFileSync(indexFile, 'utf-8'));
        for (const task of data) {
          this.tasks.set(task.id, task);
        }
      }
    } catch {
      /* ignore */
    }
  }

  private saveTasks(): void {
    const indexFile = path.join(this.tasksDir, 'index.json');
    fs.writeFileSync(indexFile, JSON.stringify(Array.from(this.tasks.values()), null, 2));
  }

  /**
   * Add a scheduled task.
   */
  add(options: ScheduleOptions): ScheduledTask {
    const id = `sched-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const task: ScheduledTask = {
      id,
      name: options.name,
      task: options.task,
      cron: options.cron,
      enabled: options.enabled ?? true,
      runCount: 0,
      createdAt: new Date().toISOString(),
      metadata: options.metadata ?? {},
    };

    // Parse interval if provided
    if (options.every) {
      task.intervalMs = parseInterval(options.every) ?? undefined;
    }

    // Calculate next run time
    const nextRun = getNextRunTime(task);
    if (nextRun) {
      task.nextRunAt = nextRun.toISOString();
    }

    this.tasks.set(id, task);
    this.saveTasks();

    return task;
  }

  /**
   * Remove a scheduled task.
   */
  remove(id: string): boolean {
    const deleted = this.tasks.delete(id);
    if (deleted) this.saveTasks();
    return deleted;
  }

  /**
   * Enable/disable a task.
   */
  toggle(id: string, enabled: boolean): boolean {
    const task = this.tasks.get(id);
    if (!task) return false;
    task.enabled = enabled;
    this.saveTasks();
    return true;
  }

  /**
   * List all scheduled tasks.
   */
  list(): ScheduledTask[] {
    return Array.from(this.tasks.values()).sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    );
  }

  /**
   * Get a task by ID.
   */
  get(id: string): ScheduledTask | undefined {
    return this.tasks.get(id);
  }

  /**
   * Start the scheduler (checks every minute).
   */
  start(): void {
    if (this.running) return;
    this.running = true;

    // Check every 30 seconds
    this.checkInterval = setInterval(() => {
      this.checkAndRun();
    }, 30_000);

    // Also check immediately
    this.checkAndRun();
  }

  /**
   * Stop the scheduler.
   */
  stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    this.running = false;
  }

  /**
   * Check for due tasks and run them.
   */
  private async checkAndRun(): Promise<void> {
    const now = new Date();

    for (const task of this.tasks.values()) {
      if (!task.enabled) continue;

      const nextRun = task.nextRunAt ? new Date(task.nextRunAt) : null;
      if (!nextRun || nextRun > now) continue;

      // Prevent re-launch while running
      task.nextRunAt = undefined;
      this.saveTasks();

      // Run the task
      getGlobalLogger().info('TaskScheduler', `Running scheduled task: ${task.name}`, {
        taskId: task.id,
      });

      try {
        const bgManager = getBackgroundTaskManager();
        await bgManager.launch({
          task: task.task,
          metadata: { scheduledTaskId: task.id, scheduledTaskName: task.name },
          onComplete: () => {
            task.lastStatus = 'success';
            task.runCount++;
            task.lastRunAt = new Date().toISOString();
            const next = getNextRunTime(task);
            if (next) task.nextRunAt = next.toISOString();
            this.saveTasks();
          },
          onError: () => {
            task.lastStatus = 'failed';
            task.runCount++;
            task.lastRunAt = new Date().toISOString();
            const next = getNextRunTime(task);
            if (next) task.nextRunAt = next.toISOString();
            this.saveTasks();
          },
        });
      } catch (err) {
        getGlobalLogger().error('TaskScheduler', `Failed to run task: ${task.name}`, err as Error);
      }
    }
  }
}

// ============================================================================
// Singleton
// ============================================================================

let defaultScheduler: TaskScheduler | null = null;

export function getTaskScheduler(): TaskScheduler {
  if (!defaultScheduler) {
    defaultScheduler = new TaskScheduler();
  }
  return defaultScheduler;
}
