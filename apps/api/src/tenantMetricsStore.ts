/** Ephemeral API telemetry only; durable run state belongs to the kernel. */

const THROUGHPUT_WINDOW_MS = 60_000;
const DURATION_WINDOW_MS = 24 * 60 * 60 * 1000;

interface TenantMetricEntry {
  createdAt: number;
  lastUsedAt: number;
  totalRuns: number;
  runTimestamps: number[];
  runDurations: Array<{ timestamp: number; durationMs: number }>;
}

export interface TenantMetricStats {
  tenantId: string | 'global';
  totalRuns: number;
  totalRunsLastMinute: number;
  instanceAgeMs: number;
  lastUsedAt: number;
}

const tenantMetrics = new Map<string, TenantMetricEntry>();
let globalMetrics: TenantMetricEntry | null = null;

function freshEntry(): TenantMetricEntry {
  const now = Date.now();
  return {
    createdAt: now,
    lastUsedAt: now,
    totalRuns: 0,
    runTimestamps: [],
    runDurations: [],
  };
}

function getEntry(tenantId?: string): TenantMetricEntry {
  if (!tenantId) {
    globalMetrics ??= freshEntry();
    globalMetrics.lastUsedAt = Date.now();
    return globalMetrics;
  }
  let entry = tenantMetrics.get(tenantId);
  if (!entry) {
    entry = freshEntry();
    tenantMetrics.set(tenantId, entry);
  }
  entry.lastUsedAt = Date.now();
  return entry;
}

function prune(entry: TenantMetricEntry): void {
  const throughputCutoff = Date.now() - THROUGHPUT_WINDOW_MS;
  entry.runTimestamps = entry.runTimestamps.filter((timestamp) => timestamp >= throughputCutoff);
  const durationCutoff = Date.now() - DURATION_WINDOW_MS;
  entry.runDurations = entry.runDurations.filter((item) => item.timestamp >= durationCutoff);
}

function renderStats(tenantId: string | 'global', entry: TenantMetricEntry): TenantMetricStats {
  prune(entry);
  return {
    tenantId,
    totalRuns: entry.totalRuns,
    totalRunsLastMinute: entry.runTimestamps.length,
    instanceAgeMs: Date.now() - entry.createdAt,
    lastUsedAt: entry.lastUsedAt,
  };
}

export function getTenantMetricStats(): TenantMetricStats[] {
  const stats: TenantMetricStats[] = [];
  if (globalMetrics) stats.push(renderStats('global', globalMetrics));
  for (const [tenantId, entry] of tenantMetrics) stats.push(renderStats(tenantId, entry));
  return stats;
}

export function getTenantRunDurations(tenantId?: string): number[] {
  const entry = tenantId ? tenantMetrics.get(tenantId) : globalMetrics;
  if (!entry) return [];
  prune(entry);
  return entry.runDurations.map((item) => item.durationMs);
}

export function recordTenantMetricUsage(
  tenantId: string | undefined,
  usage: { totalRuns?: number; durationMs?: number },
): void {
  const entry = getEntry(tenantId);
  const now = Date.now();
  if (usage.totalRuns && usage.totalRuns > 0) {
    entry.totalRuns += usage.totalRuns;
    for (let count = 0; count < usage.totalRuns; count++) entry.runTimestamps.push(now);
  }
  if (usage.durationMs && usage.durationMs > 0) {
    entry.runDurations.push({ timestamp: now, durationMs: usage.durationMs });
  }
  prune(entry);
}

export function resetTenantMetricsStore(): void {
  tenantMetrics.clear();
  globalMetrics = null;
}
