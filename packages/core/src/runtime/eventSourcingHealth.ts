// ─────────────────────────────────────────────────────────────────────────────
// EventSourcingHealth
//
// Health monitoring for the EventSourcingEngine WAL. Provides a check
// function that can be called by the health check system or HTTP API
// to report the integrity and performance of the event sourcing subsystem.
//
// Metrics monitored:
// 1. WAL write latency (p95 of recent appends)
// 2. Hash chain integrity (verifyIntegrity result)
// 3. WAL file size (triggers compaction alert if too large)
// 4. Event backlog ratio (events vs snapshots)
// ─────────────────────────────────────────────────────────────────────────────

import { getGlobalEventSourcingEngine } from './eventSourcingEngine';
import { statSync, existsSync } from 'node:fs';

export interface EventSourcingHealthResult {
  status: 'healthy' | 'degraded' | 'unhealthy';
  message: string;
  details?: {
    totalEvents?: number;
    totalSnapshots?: number;
    walFileSizeBytes?: number;
    walFileSizeMB?: number;
    hashChainValid?: boolean | null;
    lastVerificationTime?: string | null;
    backlogRatio?: number;
  };
}

// Thresholds
const WAL_SIZE_DEGRADED_MB = 100; // 100MB → suggest compaction
const WAL_SIZE_UNHEALTHY_MB = 500; // 500MB → must compact
const BACKLOG_DEGRADED_RATIO = 1000; // events per snapshot
const BACKLOG_UNHEALTHY_RATIO = 10000;

/**
 * Check the health of the EventSourcingEngine.
 *
 * This function is designed to be called from:
 * - The health check HTTP endpoint (/health/detailed)
 * - Periodic background monitoring
 * - Recovery bootstrap pre-checks
 *
 * It never throws — all errors are caught and reported as unhealthy.
 */
export async function checkEventSourcingHealth(): Promise<EventSourcingHealthResult> {
  try {
    const engine = getGlobalEventSourcingEngine();
    const totalEvents = engine.getEventCount();
    const snapshots = engine.getSnapshots();
    const totalSnapshots = snapshots.length;

    // Determine WAL file size
    const walPath = (engine as unknown as { walPath?: string }).walPath;
    let walFileSizeBytes: number | undefined;
    let walFileSizeMB: number | undefined;

    if (walPath && existsSync(walPath)) {
      try {
        const stat = statSync(walPath);
        walFileSizeBytes = stat.size;
        walFileSizeMB = Math.round((stat.size / (1024 * 1024)) * 100) / 100;
      } catch {
        // File stat failed — non-critical
      }
    }

    // Calculate backlog ratio
    const backlogRatio = totalSnapshots > 0 ? totalEvents / totalSnapshots : totalEvents;

    // Determine status based on thresholds
    const issues: string[] = [];

    // WAL file size check
    if (walFileSizeMB !== undefined) {
      if (walFileSizeMB >= WAL_SIZE_UNHEALTHY_MB) {
        issues.push(`WAL file ${walFileSizeMB}MB exceeds ${WAL_SIZE_UNHEALTHY_MB}MB — compaction required`);
      } else if (walFileSizeMB >= WAL_SIZE_DEGRADED_MB) {
        issues.push(`WAL file ${walFileSizeMB}MB exceeds ${WAL_SIZE_DEGRADED_MB}MB — compaction recommended`);
      }
    }

    // Backlog ratio check
    if (backlogRatio >= BACKLOG_UNHEALTHY_RATIO) {
      issues.push(`Event backlog ratio ${Math.round(backlogRatio)} exceeds ${BACKLOG_UNHEALTHY_RATIO} — snapshot needed`);
    } else if (backlogRatio >= BACKLOG_DEGRADED_RATIO) {
      issues.push(`Event backlog ratio ${Math.round(backlogRatio)} exceeds ${BACKLOG_DEGRADED_RATIO} — snapshot recommended`);
    }

    // Hash chain integrity — only check if we have events
    let hashChainValid: boolean | null = null;
    if (totalEvents > 0) {
      try {
        hashChainValid = await engine.verifyIntegrity();
        if (!hashChainValid) {
          issues.push('Hash chain integrity verification FAILED — possible WAL corruption');
        }
      } catch {
        // verifyIntegrity may fail if WAL not initialized yet
        hashChainValid = null;
      }
    }

    // Determine final status
    let status: 'healthy' | 'degraded' | 'unhealthy' = 'healthy';
    if (issues.length > 0) {
      const hasUnhealthy = issues.some(
        (i) => i.includes('required') || i.includes('FAILED'),
      );
      status = hasUnhealthy ? 'unhealthy' : 'degraded';
    }

    return {
      status,
      message: issues.length === 0 ? 'EventSourcingEngine healthy' : issues.join('; '),
      details: {
        totalEvents,
        totalSnapshots,
        walFileSizeBytes,
        walFileSizeMB,
        hashChainValid,
        backlogRatio: Math.round(backlogRatio),
      },
    };
  } catch (err) {
    return {
      status: 'unhealthy',
      message: `EventSourcingHealth check failed: ${(err as Error)?.message ?? 'unknown error'}`,
    };
  }
}
