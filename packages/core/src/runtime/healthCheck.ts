/**
 * Health check system for Commander runtime.
 * 8-component monitoring: memory, circuit breaker, DLQ, checkpoint, compensation, event bus, providers, disk space.
 *
 * Wiring: create a HealthCollector with optional factory functions that return
 * live data from the running system. Without wiring, checks return "degraded"
 * with "not wired" messages (fail-closed: unverified ≠ healthy).
 */
import { reportSilentFailure } from '../silentFailureReporter';
import fs from 'node:fs';
import path from 'node:path';
import { getMessageBus } from './messageBus';
import { getDeadLetterQueue } from './deadLetterQueueSingleton';
import { getCompensationQueue } from '../atr/compensationQueue';

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
  getDLQInfo?: () => Promise<{ totalEntries: number; byCategory: DLQCategoryCount[] }>;
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
// buildHealthSources
// ============================================================================
/**
 * Build HealthSources from the global runtime singletons that EXIST in
 * non-CLI surfaces (apps/api, scripts) where there is no live AgentRuntime
 * to query for circuit-breaker / provider info.
 *
 * Sources exposed here — message bus, DLQ, and compensation queue — are
 * process-global singletons. Circuit-breaker and provider info require an
 * active AgentRuntime (see CommanderHttpServer.buildHealthSources); when
 * unavailable, those checks correctly report 'degraded' (not 'healthy').
 *
 * Each getter swallows its own errors and falls back to a zero/empty
 * report so a single broken singleton cannot crash the whole probe.
 */
export function buildHealthSources(): HealthSources {
  return {
    getEventBusInfo: () => {
      try {
        const bus = getMessageBus();
        return {
          activeTopics: bus.getActiveTopics().length,
          subscriberCount: Object.values(bus.getAllSubscriberCounts()).reduce((a, b) => a + b, 0),
        };
      } catch (err) {
        reportSilentFailure(err, 'healthCheck:buildHealthSources.bus');
        return { activeTopics: 0, subscriberCount: 0 };
      }
    },
    getDLQInfo: async () => {
      try {
        const dlq = getDeadLetterQueue();
        const byCategory = await dlq.getStats();
        return {
          totalEntries: byCategory.reduce((s, c) => s + c.count, 0),
          byCategory,
        };
      } catch (err) {
        reportSilentFailure(err, 'healthCheck:buildHealthSources.dlq');
        return { totalEntries: 0, byCategory: [] };
      }
    },
    getCompensationInfo: () => {
      try {
        const queue = getCompensationQueue();
        const counts = queue.countByStatus();
        return {
          pending: counts.pending + counts.in_progress,
          compensated: 0,
        };
      } catch (err) {
        reportSilentFailure(err, 'healthCheck:buildHealthSources.compensation');
        return { pending: 0, compensated: 0 };
      }
    },
  };
}

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

    const checkEntries = Object.entries(statusMap) as [keyof typeof statusMap, ComponentCheck][];
    const degradedComponents = checkEntries
      .filter(([, check]) => check.status === 'degraded' || check.status === 'unhealthy')
      .map(([name]) => name);
    const overallStatus = this.determineOverallStatus(Object.values(statusMap));

    return {
      status: overallStatus,
      checks: statusMap,
      degradedComponents,
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
      return {
        status: 'degraded',
        message: 'Circuit breaker check not wired — unable to verify breaker state',
      };
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
      return { status: 'degraded', message: 'Circuit breaker check failed — status unknown' };
    }
  }

  private async checkDeadLetterQueue(): Promise<ComponentCheck> {
    const dlq = this.sources?.getDLQInfo;
    if (!dlq) {
      return { status: 'degraded', message: 'DLQ check not wired — unable to verify queue depth' };
    }
    try {
      const info = await dlq();
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
      return { status: 'degraded', message: 'DLQ check failed — status unknown' };
    }
  }

  private async checkCheckpoint(): Promise<ComponentCheck> {
    try {
      const checkpointsDir = path.join(process.cwd(), '.commander', 'checkpoints');
      // Async stat so /health/detailed probes don't block the Node.js event
      // loop on cold or cold-restart checkpoints volumes. We map ENOENT to
      // the "no directory" success case (a cold-start process is not
      // degraded just because no checkpoints exist yet) and treat the
      // path being something other than a directory as a skip rather than
      // a failure.
      let dirStat: import('node:fs').Stats | undefined;
      try {
        dirStat = await fs.promises.stat(checkpointsDir);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          return { status: 'healthy', message: 'No checkpoints directory' };
        }
        throw err;
      }
      if (!dirStat.isDirectory()) {
        return { status: 'healthy', message: 'No checkpoints directory' };
      }

      const fileNames = await fs.promises.readdir(checkpointsDir);
      const jsonFiles = fileNames.filter((f) => f.endsWith('.json'));
      const oneHourAgo = Date.now() - 3600_000;
      // Stat each checkpoint file in parallel; tolerate per-file failures
      // by treating them as "unknown mtime" (= not stale) so a single
      // unreadable file does not flip the whole probe to degraded.
      const stats = await Promise.all(
        jsonFiles.map((f) => fs.promises.stat(path.join(checkpointsDir, f)).catch(() => null)),
      );
      const staleCount = stats.filter(
        (s): s is import('node:fs').Stats => s !== null && s.mtimeMs < oneHourAgo,
      ).length;

      if (staleCount > 0) {
        return {
          status: 'degraded',
          message: `${staleCount} stale checkpoint(s) older than 1 hour`,
          details: { total: jsonFiles.length, stale: staleCount },
        };
      }

      return {
        status: 'healthy',
        message: `${jsonFiles.length} checkpoint(s) healthy`,
        details: { total: jsonFiles.length },
      };
    } catch (err) {
      reportSilentFailure(err, 'healthCheck:230');
      return { status: 'degraded', message: 'Checkpoint directory not accessible' };
    }
  }

  private async checkCompensation(): Promise<ComponentCheck> {
    const comp = this.sources?.getCompensationInfo;
    if (!comp) {
      return {
        status: 'degraded',
        message: 'Compensation check not wired — unable to verify pending compensations',
      };
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
      return { status: 'degraded', message: 'Compensation check failed — status unknown' };
    }
  }

  private async checkEventBus(): Promise<ComponentCheck> {
    const bus = this.sources?.getEventBusInfo;
    if (!bus) {
      return {
        status: 'degraded',
        message: 'Event bus check not wired — unable to verify bus status',
      };
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
      return { status: 'degraded', message: 'Event bus check failed — status unknown' };
    }
  }

  private async checkProviders(): Promise<ComponentCheck> {
    const prov = this.sources?.getProviderInfo;
    if (!prov) {
      return {
        status: 'degraded',
        message: 'Provider check not wired — unable to verify provider availability',
      };
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
      return { status: 'degraded', message: 'Provider check failed — status unknown' };
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
      return { status: 'degraded', message: 'Disk space check not available' };
    }
  }
}
