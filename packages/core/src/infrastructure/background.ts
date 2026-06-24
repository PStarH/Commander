/**
 * Background Task Infrastructure
 *
 * Lets Commander run tasks in the background without blocking the terminal.
 * Users can fire-and-forget, check status, and get notified when done.
 *
 * Usage:
 *   commander run "task" --background
 *   commander jobs              # List running jobs
 *   commander jobs <id>         # Check job status
 *   commander jobs <id> --logs  # View job logs
 *   commander jobs <id> --stop  # Stop a job
 */

import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import { getGlobalLogger } from '../logging';

// ============================================================================
// Types
// ============================================================================

export interface BackgroundJob {
  id: string;
  task: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'stopped';
  startedAt: string;
  completedAt?: string;
  pid?: number;
  exitCode?: number;
  error?: string;
  logFile: string;
  metadata: Record<string, unknown>;
}

export interface BackgroundJobOptions {
  task: string;
  metadata?: Record<string, unknown>;
  onProgress?: (job: BackgroundJob, line: string) => void;
  onComplete?: (job: BackgroundJob) => void;
  onError?: (job: BackgroundJob, error: Error) => void;
}

// ============================================================================
// Background Task Manager
// ============================================================================

export class BackgroundTaskManager extends EventEmitter {
  private jobs: Map<string, BackgroundJob> = new Map();
  private jobsDir: string;
  private logDir: string;

  constructor(baseDir?: string) {
    super();
    this.jobsDir = baseDir ?? path.join(process.cwd(), '.commander', 'jobs');
    this.logDir = path.join(this.jobsDir, 'logs');
    this.ensureDirs();
    this.loadJobs();
  }

  private ensureDirs(): void {
    fs.mkdirSync(this.jobsDir, { recursive: true });
    fs.mkdirSync(this.logDir, { recursive: true });
  }

  private loadJobs(): void {
    try {
      const indexFile = path.join(this.jobsDir, 'index.json');
      if (fs.existsSync(indexFile)) {
        const data = JSON.parse(fs.readFileSync(indexFile, 'utf-8'));
        for (const job of data) {
          this.jobs.set(job.id, job);
        }
      }
    } catch (err) {
      console.warn('[Catch]', err);
      /* ignore */
    }
  }

  private saveJobs(): void {
    const indexFile = path.join(this.jobsDir, 'index.json');
    fs.writeFileSync(indexFile, JSON.stringify(Array.from(this.jobs.values()), null, 2));
  }

  /**
   * Launch a task in the background.
   * Returns immediately with job ID.
   */
  async launch(options: BackgroundJobOptions): Promise<BackgroundJob> {
    const id = `job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const logFile = path.join(this.logDir, `${id}.log`);

    const job: BackgroundJob = {
      id,
      task: options.task,
      status: 'pending',
      startedAt: new Date().toISOString(),
      logFile,
      metadata: options.metadata ?? {},
    };

    this.jobs.set(id, job);
    this.saveJobs();

    // Launch in background
    this.runInBackground(job, options);

    return job;
  }

  private async runInBackground(job: BackgroundJob, options: BackgroundJobOptions): Promise<void> {
    const { spawn } = await import('child_process');

    job.status = 'running';
    this.saveJobs();

    const logStream = fs.createWriteStream(job.logFile, { flags: 'a' });
    logStream.write(`[${new Date().toISOString()}] Starting: ${job.task}\n`);

    try {
      // Run the task as a child process
      const child = spawn('npx', ['tsx', 'packages/core/src/cli.ts', 'run', job.task], {
        cwd: process.cwd(),
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      job.pid = child.pid;
      this.saveJobs();

      // Stream output to log file
      child.stdout?.on('data', (data: Buffer) => {
        const line = data.toString();
        logStream.write(line);
        options.onProgress?.(job, line);
        this.emit('progress', { jobId: job.id, line });
      });

      child.stderr?.on('data', (data: Buffer) => {
        const line = data.toString();
        logStream.write(`[STDERR] ${line}`);
        options.onProgress?.(job, line);
        this.emit('progress', { jobId: job.id, line });
      });

      // Handle completion
      child.on('close', (code) => {
        job.exitCode = code ?? 0;
        job.completedAt = new Date().toISOString();
        // Don't overwrite 'stopped' status
        if (job.status !== 'stopped') {
          job.status = code === 0 ? 'completed' : 'failed';
        }
        logStream.write(`[${new Date().toISOString()}] Finished with exit code ${code}\n`);
        logStream.end();
        this.saveJobs();

        if (job.status === 'completed') {
          options.onComplete?.(job);
          this.emit('complete', { jobId: job.id });
        } else {
          const err = new Error(`Task failed with exit code ${code}`);
          options.onError?.(job, err);
          this.emit('error', { jobId: job.id, error: err });
        }

        // Notify if notification manager exists
        this.notifyCompletion(job);
      });

      // Detach so it survives parent exit
      child.unref();
    } catch (err) {
      job.status = 'failed';
      job.error = String(err);
      job.completedAt = new Date().toISOString();
      logStream.write(`[${new Date().toISOString()}] Error: ${err}\n`);
      logStream.end();
      this.saveJobs();
      options.onError?.(job, err as Error);
      this.emit('error', { jobId: job.id, error: err });
    }
  }

  private notifyCompletion(job: BackgroundJob): void {
    // Try to send notification via system notification
    try {
      const { execFile } = require('child_process');
      const status = job.status === 'completed' ? '✅' : '❌';
      const title = `Commander: ${status} ${job.task.slice(0, 50)}`;
      const body =
        job.status === 'completed'
          ? `Completed in ${this.getDuration(job)}`
          : `Failed: ${job.error || 'Unknown error'}`;

      // macOS notification — use execFile to avoid shell injection
      if (process.platform === 'darwin') {
        execFile(
          'osascript',
          [
            '-e',
            `display notification "${body.replace(/"/g, '\\"')}" with title "${title.replace(/"/g, '\\"')}"`,
          ],
          { stdio: 'ignore' },
        );
      }
      // Linux notification — use execFile to avoid shell injection
      else if (process.platform === 'linux') {
        execFile('notify-send', [title, body], { stdio: 'ignore' });
      }
    } catch (err) {
      console.warn('[Catch]', err);
      /* notification best-effort */
    }
  }

  private getDuration(job: BackgroundJob): string {
    if (!job.completedAt) return 'unknown';
    const start = new Date(job.startedAt).getTime();
    const end = new Date(job.completedAt).getTime();
    const seconds = Math.round((end - start) / 1000);
    if (seconds < 60) return `${seconds}s`;
    return `${Math.round(seconds / 60)}m ${seconds % 60}s`;
  }

  /**
   * Get a job by ID.
   */
  getJob(id: string): BackgroundJob | undefined {
    return this.jobs.get(id);
  }

  /**
   * List all jobs, optionally filtered by status.
   */
  listJobs(status?: BackgroundJob['status']): BackgroundJob[] {
    const jobs = Array.from(this.jobs.values());
    if (status) return jobs.filter((j) => j.status === status);
    return jobs.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
  }

  /**
   * Get job logs.
   */
  getLogs(id: string, tail?: number): string[] {
    const job = this.jobs.get(id);
    if (!job || !fs.existsSync(job.logFile)) return [];

    const content = fs.readFileSync(job.logFile, 'utf-8');
    const lines = content.split('\n').filter(Boolean);
    return tail ? lines.slice(-tail) : lines;
  }

  /**
   * Stop a running job.
   */
  stopJob(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job || job.status !== 'running' || !job.pid) return false;

    try {
      process.kill(job.pid, 'SIGTERM');
      job.status = 'stopped';
      job.completedAt = new Date().toISOString();
      this.saveJobs();
      return true;
    } catch (err) {
      console.warn('[Catch]', err);
      return false;
    }
  }

  /**
   * Clean up old completed jobs.
   */
  cleanup(keepLast: number = 50): number {
    const sorted = this.listJobs().sort(
      (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
    );

    const toRemove = sorted.slice(keepLast);
    for (const job of toRemove) {
      if (job.status !== 'running') {
        this.jobs.delete(job.id);
        try {
          fs.unlinkSync(job.logFile);
        } catch (err) {
          console.warn('[Catch]', err);
          /* ignore */
        }
      }
    }
    this.saveJobs();
    return toRemove.length;
  }
}

// ============================================================================
// Singleton
// ============================================================================

let defaultManager: BackgroundTaskManager | null = null;

export function getBackgroundTaskManager(): BackgroundTaskManager {
  if (!defaultManager) {
    defaultManager = new BackgroundTaskManager();
  }
  return defaultManager;
}
