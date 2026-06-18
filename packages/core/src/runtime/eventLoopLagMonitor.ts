/**
 * EventLoopLagMonitor — lightweight event loop delay measurement.
 *
 * Uses setTimeout(0) drift detection: schedules a 0ms timer and measures
 * the actual delay before it fires. Reports as a gauge metric.
 *
 * Based on the same technique used by `monitor-event-loop-delay` and
 * the Node.js `perf_hooks.monitorEventLoopDelay` API, but without native bindings.
 */

import { getGlobalLogger } from '../logging';

const DEFAULT_INTERVAL_MS = 5_000;
const LAG_WARN_THRESHOLD_MS = 100;
const LAG_CRITICAL_THRESHOLD_MS = 500;

export class EventLoopLagMonitor {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private lastLagMs = 0;
  private maxLagMs = 0;
  private sampleCount = 0;
  private warnCount = 0;
  private readonly intervalMs: number;
  private readonly onLag?: (lagMs: number) => void;

  constructor(options?: { intervalMs?: number; onLag?: (lagMs: number) => void }) {
    this.intervalMs = options?.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.onLag = options?.onLag;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.timer = setInterval(() => this.measure(), this.intervalMs);
    if (this.timer.unref) this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.running = false;
  }

  private measure(): void {
    const start = Date.now();
    setTimeout(() => {
      const lag = Date.now() - start;
      this.lastLagMs = lag;
      this.sampleCount++;
      if (lag > this.maxLagMs) this.maxLagMs = lag;

      if (lag > LAG_CRITICAL_THRESHOLD_MS) {
        this.warnCount++;
        getGlobalLogger().warn('EventLoopLagMonitor', 'Critical event loop lag detected', {
          lagMs: lag,
          threshold: LAG_CRITICAL_THRESHOLD_MS,
          totalWarnings: this.warnCount,
        });
      } else if (lag > LAG_WARN_THRESHOLD_MS && this.warnCount < 10) {
        this.warnCount++;
        getGlobalLogger().warn('EventLoopLagMonitor', 'Elevated event loop lag', {
          lagMs: lag,
          threshold: LAG_WARN_THRESHOLD_MS,
        });
      }

      this.onLag?.(lag);
    }, 0);
  }

  getStats(): { lagMs: number; maxLagMs: number; samples: number; warnings: number } {
    return {
      lagMs: this.lastLagMs,
      maxLagMs: this.maxLagMs,
      samples: this.sampleCount,
      warnings: this.warnCount,
    };
  }

  reset(): void {
    this.maxLagMs = 0;
    this.sampleCount = 0;
    this.warnCount = 0;
  }
}

let _monitor: EventLoopLagMonitor | null = null;

export function getEventLoopLagMonitor(): EventLoopLagMonitor {
  if (!_monitor) {
    _monitor = new EventLoopLagMonitor();
  }
  return _monitor;
}

export function resetEventLoopLagMonitor(): void {
  if (_monitor) {
    _monitor.stop();
    _monitor = null;
  }
}
