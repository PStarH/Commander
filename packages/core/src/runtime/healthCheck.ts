/**
 * Health check system for Commander runtime.
 * 8-component monitoring: memory, circuit breaker, DLQ, checkpoint, compensation, event bus, providers, disk space.
 *
 * Wiring: create a HealthCollector with optional factory functions that return
 * live data from the running system. Without wiring, checks return "healthy"
 * with "not wired" messages (backward compatible).
 */
import { reportSilentFailure } from '../silentFailureReporter';
import fs from 'node:fs';
import path from 'node:path';

// ============================================================================
// Types
// ============================================================================

export interface HealthCheckResult {
  status: 'healthy' | 'degraded' | 'unhealthy';
  checks: {
    memory: ComponentCheck;
    circuitBreaker: ComponentCheck;
    deadLetterQueue: ComponentCheck;
    checkpoint: ComponentCheck;
    compensation: ComponentCheck;
    eventBus: ComponentCheck;
    providers: ComponentCheck;
    diskSpace: ComponentCheck;
  };
  degradedComponents?: string[];
  timestamp: string;
}

export interface ComponentCheck {
  status: 'healthy' | 'degraded' | 'unhealthy';
  message: string;
  details?: Record<string, unknown>;
}

// DLQ category-count entry returned by getDLQStats
export interface DLQCategoryCount {
  category: string;
  count: number;
}

/**
 * Live-data sources that callers (e.g. CommanderHttpServer) provide so the
 * health collector returns real component status instead of "not implemented".
 *
 * Every field is a getter function — called fresh on each collect() so the
 * returned data reflects current system state.
 */
export interface HealthSources {
  /** Return open circuit breaker names and total breaker count. */
  getCircuitBreakerInfo?: () => { open: string[]; total: number };
  /** Return aggregate dead-letter-queue size and per-category breakdown. */
  getDLQInfo?: () => { totalEntries: number; byCategory: DLQCategoryCount[] };
  /** Return pending and completed compensation counts. */
  getCompensationInfo?: () => { pending: number; compensated: number };
  /** Return active topic count and subscriber count on the event bus. */
  getEventBusInfo?: () => { activeTopics: number; subscriberCount: number };
  /** Return available / total provider counts. */
  getProviderInfo?: () => { available: number; total: number };
}

// DLQ size threshold — when total entries exceeds this, mark as degraded
const DLQ_DEGRADED_THRESHOLD = 100;

// ============================================================================
// HealthCollector
// ============================================================================

export class HealthCollector {
  private readonly warningThresholdMB: number;
  private readonly criticalThresholdMB: number;
  private readonly sources?: HealthSources;

  constructor(opts?: {
    warningThresholdMB?: number;
    criticalThresholdMB?: number;
    sources?: HealthSources;
  }) {
    this.warningThresholdMB = opts?.warningThresholdMB ?? 512;
    this.criticalThresholdMB = opts?.criticalThresholdMB ?? 1024;
    this.sources = opts?.sources;
  }

  async collect(): Promise<HealthCheckResult> {
    const checks = await Promise.all([
      this.checkMemory(),
      this.checkCircuitBreaker(),
      this.checkDeadLetterQueue(),
      this.checkCheckpoint(),
      this.checkCompensation(),
      this.checkEventBus(),
      this.checkProviders(),
      this.checkDiskSpace(),
    ]);

    const statusMap = {
      memory: checks[0],
      circuitBreaker: checks[1],
      deadLetterQueue: checks[2],
      checkpoint: checks[3],
      compensation: checks[4],
      eventBus: checks[5],
      providers: checks[6],
      diskSpace: checks[7],
    };

    const overallStatus = this.determineOverallStatus(Object.values(statusMap));

    return {
      status: overallStatus,
      checks: statusMap,
      timestamp: new Date().toISOString(),
    };
  }

  private determineOverallStatus(checks: ComponentCheck[]): 'healthy' | 'degraded' | 'unhealthy' {
    if (checks.some((c) => c.status === 'unhealthy')) return 'unhealthy';
    if (checks.some((c) => c.status === 'degraded')) return 'degraded';
    return 'healthy';
  }

  private async checkMemory(): Promise<ComponentCheck> {
    const mem = process.memoryUsage();
    const heapUsedMB = Math.round(mem.heapUsed / 1024 / 1024);
    const heapTotalMB = Math.round(mem.heapTotal / 1024 / 1024);
    const usagePercent = Math.round((heapUsedMB / heapTotalMB) * 100);

    if (heapUsedMB >= this.criticalThresholdMB) {
      return {
        status: 'unhealthy',
        message: `Memory usage critical: ${heapUsedMB}MB (>${this.criticalThresholdMB}MB threshold)`,
        details: { heapUsedMB, heapTotalMB, usagePercent },
      };
    }

    if (heapUsedMB >= this.warningThresholdMB) {
      return {
        status: 'degraded',
        message: `Memory usage elevated: ${heapUsedMB}MB (>${this.warningThresholdMB}MB threshold)`,
        details: { heapUsedMB, heapTotalMB, usagePercent },
      };
    }

    return {
      status: 'healthy',
      message: `Memory usage normal: ${heapUsedMB}MB (${usagePercent}%)`,
      details: { heapUsedMB, heapTotalMB, usagePercent },
    };
  }

  private async checkCircuitBreaker(): Promise<ComponentCheck> {
    const cb = this.sources?.getCircuitBreakerInfo;
    if (!cb) {
      return { status: 'healthy', message: 'Circuit breaker check not wired — no source provided' };
    }
    try {
      const info = cb();
      if (info.open.length > 0) {
        return {
          status: 'degraded',
          message: `${info.open.length} circuit breaker(s) OPEN: ${info.open.join(', ')}`,
          details: { open: info.open, total: info.total },
        };
      }
      return {
        status: 'healthy',
        message: `All ${info.total} circuit breaker(s) CLOSED`,
        details: { open: info.open, total: info.total },
      };
    } catch (err) {
      reportSilentFailure(err, 'healthCheck:174');
      return { status: 'healthy', message: 'Circuit breaker check failed — assuming healthy' };
    }
  }

  private async checkDeadLetterQueue(): Promise<ComponentCheck> {
    const dlq = this.sources?.getDLQInfo;
    if (!dlq) {
      return { status: 'healthy', message: 'DLQ check not wired — no source provided' };
    }
    try {
      const info = dlq();
      if (info.totalEntries > DLQ_DEGRADED_THRESHOLD) {
        return {
          status: 'degraded',
          message: `DLQ has ${info.totalEntries} entries (>${DLQ_DEGRADED_THRESHOLD} threshold)`,
          details: { totalEntries: info.totalEntries, byCategory: info.byCategory },
        };
      }
      return {
        status: 'healthy',
        message: `DLQ has ${info.totalEntries} entries`,
        details: { totalEntries: info.totalEntries, byCategory: info.byCategory },
      };
    } catch (err) {
      reportSilentFailure(err, 'healthCheck:199');
      return { status: 'healthy', message: 'DLQ check failed — assuming healthy' };
    }
  }

  private async checkCheckpoint(): Promise<ComponentCheck> {
    try {
      const checkpointsDir = path.join(process.cwd(), '.commander', 'checkpoints');
      if (!fs.existsSync(checkpointsDir)) {
        return { status: 'healthy', message: 'No checkpoints directory' };
      }

      const files = fs.readdirSync(checkpointsDir).filter((f) => f.endsWith('.json'));
      const staleCount = files.filter((f) => {
        const stat = fs.statSync(path.join(checkpointsDir, f));
        return Date.now() - stat.mtimeMs > 3600_000;
      }).length;

      if (staleCount > 0) {
        return {
          status: 'degraded',
          message: `${staleCount} stale checkpoint(s) older than 1 hour`,
          details: { total: files.length, stale: staleCount },
        };
      }

      return {
        status: 'healthy',
        message: `${files.length} checkpoint(s) healthy`,
        details: { total: files.length },
      };
    } catch (err) {
      reportSilentFailure(err, 'healthCheck:231');
      return { status: 'healthy', message: 'Checkpoint directory not accessible' };
    }
  }

  private async checkCompensation(): Promise<ComponentCheck> {
    const comp = this.sources?.getCompensationInfo;
    if (!comp) {
      return { status: 'healthy', message: 'Compensation check not wired — no source provided' };
    }
    try {
      const info = comp();
      if (info.pending > 0) {
        return {
          status: 'degraded',
          message: `${info.pending} pending compensation(s), ${info.compensated} compensated`,
          details: { pending: info.pending, compensated: info.compensated },
        };
      }
      return {
        status: 'healthy',
        message: `No pending compensations (${info.compensated} total compensated)`,
        details: { pending: info.pending, compensated: info.compensated },
      };
    } catch (err) {
      reportSilentFailure(err, 'healthCheck:256');
      return { status: 'healthy', message: 'Compensation check failed — assuming healthy' };
    }
  }

  private async checkEventBus(): Promise<ComponentCheck> {
    const bus = this.sources?.getEventBusInfo;
    if (!bus) {
      return { status: 'healthy', message: 'Event bus check not wired — no source provided' };
    }
    try {
      const info = bus();
      return {
        status: 'healthy',
        message: `${info.activeTopics} active topic(s), ${info.subscriberCount} subscriber(s)`,
        details: { activeTopics: info.activeTopics, subscriberCount: info.subscriberCount },
      };
    } catch (err) {
      reportSilentFailure(err, 'healthCheck:274');
      return { status: 'healthy', message: 'Event bus check failed — assuming healthy' };
    }
  }

  private async checkProviders(): Promise<ComponentCheck> {
    const prov = this.sources?.getProviderInfo;
    if (!prov) {
      return { status: 'healthy', message: 'Provider check not wired — no source provided' };
    }
    try {
      const info = prov();
      if (info.available === 0 && info.total > 0) {
        return {
          status: 'unhealthy',
          message: `0/${info.total} providers available`,
          details: { available: info.available, total: info.total },
        };
      }
      if (info.available < info.total) {
        return {
          status: 'degraded',
          message: `${info.available}/${info.total} providers available`,
          details: { available: info.available, total: info.total },
        };
      }
      return {
        status: 'healthy',
        message: `All ${info.total} provider(s) available`,
        details: { available: info.available, total: info.total },
      };
    } catch (err) {
      reportSilentFailure(err, 'healthCheck:306');
      return { status: 'healthy', message: 'Provider check failed — assuming healthy' };
    }
  }

  private async checkDiskSpace(): Promise<ComponentCheck> {
    try {
      const stats = fs.statfsSync(process.cwd());
      const freeGB = Math.round((stats.bavail * stats.bsize) / 1024 / 1024 / 1024);
      const totalGB = Math.round((stats.blocks * stats.bsize) / 1024 / 1024 / 1024);
      const usagePercent = Math.round(((totalGB - freeGB) / totalGB) * 100);

      if (freeGB < 1) {
        return {
          status: 'unhealthy',
          message: `Disk space critical: ${freeGB}GB free`,
          details: { freeGB, totalGB, usagePercent },
        };
      }

      if (freeGB < 5) {
        return {
          status: 'degraded',
          message: `Disk space low: ${freeGB}GB free`,
          details: { freeGB, totalGB, usagePercent },
        };
      }

      return {
        status: 'healthy',
        message: `Disk space adequate: ${freeGB}GB free (${usagePercent}% used)`,
        details: { freeGB, totalGB, usagePercent },
      };
    } catch (err) {
      reportSilentFailure(err, 'healthCheck:340');
      return { status: 'healthy', message: 'Disk space check not available' };
    }
  }
}
