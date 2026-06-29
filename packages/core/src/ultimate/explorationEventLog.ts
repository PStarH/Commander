/**
 * P5: ε-greedy exploration event log.
 *
 * Backs the live routing dashboard (`GET /api/v1/topology/exploration`).
 * TopologyRouter records an event on every routing decision; the log
 * keeps the last N events in memory and aggregates per-tenant
 * rates + a divergence histogram for the operator dashboard.
 *
 * Design choices:
 * - Ring buffer (oldest events evicted first) so memory stays bounded
 *   even after a long-running production server.
 * - Tenant dimension is mandatory on every event so the dashboard can
 *   filter without re-scanning.
 * - Histograms are computed lazily on snapshot — cheap for the
 *   1000-event default but cheap to recompute on demand.
 * - No external dependencies so it works in tests, embedded
 *   runtimes, and the HTTP server equally.
 */
import { reportSilentFailure } from '../silentFailureReporter';
import type { OrchestrationTopology } from './types';
import { EpsilonStore, type EpsilonOverride } from './epsilonStore';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface ExplorationEvent {
  /** ISO-8601 timestamp recorded at insertion time. */
  timestamp: string;
  /** Tenant dimension — required for per-tenant dashboards. */
  tenantId: string;
  /** Task type the router scored (e.g. 'CODING', 'RESEARCH'). */
  taskType: string;
  /** Topology the router ultimately selected (argmax or explored). */
  chosenTopology: OrchestrationTopology;
  /** Topology the greedy argmax would have picked. */
  argmaxTopology: OrchestrationTopology;
  /** True iff ε-greedy exploration triggered AND the draw diverged. */
  diverged: boolean;
  /** ε used for this routing decision. */
  epsilon: number;
  /** Top-K biased-score candidates at the time of routing (for histogram). */
  topCandidates: Array<{ topology: OrchestrationTopology; score: number }>;
  /**
   * True iff the orchestrator's coordination policy overrode the
   * router's pick post-hoc (e.g. negative-ROI fallback to SINGLE).
   * The router doesn't track this — it always records `false`. The
   * orchestrator can record a follow-up event with `true` when it
   * overrides, or update the event's `finalTopology` via the log's
   * mutation API. For v1 we just surface the flag so operators can
   * correlate "router said HIERARCHICAL" with "execution used SINGLE".
   */
  coordinationOverride: boolean;
  /** The topology actually used at execution time. Defaults to
   *  `chosenTopology`; the orchestrator can update it via the
   *  `updateFinalTopology` API when coordination policy overrides. */
  finalTopology: OrchestrationTopology;
  /** Optional trace linkage so the dashboard can deep-link into /observability. */
  runId?: string;
  agentId?: string;
  /**
   * Monotonically-increasing event id assigned at insertion time.
   * Use this instead of (timestamp, runId) to look up events for
   * mutation (e.g. `updateFinalTopology`) — two events recorded in
   * the same millisecond will share a timestamp but always have
   * distinct eventIds.
   */
  eventId: number;
}

export interface ExplorationEventLogFilter {
  /** Filter events to a single tenant. Omit for "all tenants". */
  tenantId?: string;
  /** ISO timestamp lower bound (inclusive). Omit for "all time". */
  since?: string;
  /** Cap on the number of events returned. Default 100. Max 1000. */
  limit?: number;
  /** Restrict to events where ε-greedy actually diverged. */
  divergedOnly?: boolean;
}

export type MarginBucket =
  | 'same'
  | 'chosen_higher' // margin < 0: chosen scored higher than argmax
  | '<0.5'
  | '0.5-1.0'
  | '1.0-2.0'
  | '>2.0';

export interface ExplorationDivergenceBucket {
  marginBucket: MarginBucket;
  count: number;
}

export interface ExplorationTenantStats {
  tenantId: string;
  routingCount: number;
  explorationCount: number;
  divergenceCount: number;
  explorationRate: number;
  divergenceRate: number;
}

export interface FilteredTotals {
  /** Count of events matching the filter (per-tenant when filtered). */
  routingCount: number;
  explorationCount: number;
  divergenceCount: number;
  explorationRate: number;
  divergenceRate: number;
  coordinationOverrideCount: number;
}

export interface GlobalStats {
  /** Cumulative routing count since process start (NOT filter-aware). */
  lifetimeRoutingCount: number;
  lifetimeExplorationCount: number;
  lifetimeDivergenceCount: number;
  lifetimeExplorationRate: number;
  lifetimeDivergenceRate: number;
  ringBufferSize: number;
  ringBufferMaxSize: number;
  /** Cumulative count of events evicted from the ring since process
   *  start. Renamed from `overflowCount` for symmetry with the
   *  other `lifetime*` fields — operators should not mistake this
   *  for a "we're losing data right now" signal. */
  lifetimeOverflowCount: number;
  capturedAt: string;
}

export interface ExplorationSnapshot {
  /** Filter-aware totals (scoped to the filter's tenantId if set). */
  totals: FilteredTotals;
  /** Process-lifetime stats (never filter-aware — admin view). */
  globalStats: GlobalStats;
  /** Per-tenant aggregates. Filtered by `tenantId` if supplied. */
  tenants: ExplorationTenantStats[];
  /** Divergence histogram for the filtered events. */
  divergenceHistogram: ExplorationDivergenceBucket[];
  /** Recent events, newest last, capped to `limit`. */
  recentEvents: ExplorationEvent[];
  /** True if the filter dropped events that exist in the ring buffer
   *  (i.e. the response is a subset of the full data). Distinct from
   *  `globalStats.overflowCount` which is a process-lifetime flag. */
  truncated: boolean;
}

const DEFAULT_MAX_SIZE = 1000;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

function marginBucket(margin: number): MarginBucket {
  // Sign-preserving: when the chosen topology scored higher than the
  // argmax (possible on tied scores or near-ties), surface that as a
  // distinct 'chosen_higher' bucket instead of folding it into a
  // magnitude bucket. Operators looking for "how far did we explore
  // from greedy?" want a clear signal when the draw landed above
  // the argmax — that's qualitatively different from "explored far
  // below".
  if (margin < 0) return 'chosen_higher';
  if (margin === 0) return 'same';
  if (margin < 0.5) return '<0.5';
  if (margin < 1.0) return '0.5-1.0';
  if (margin < 2.0) return '1.0-2.0';
  return '>2.0';
}

const ALL_BUCKETS: MarginBucket[] = ['same', 'chosen_higher', '<0.5', '0.5-1.0', '1.0-2.0', '>2.0'];

export class ExplorationEventLog {
  private readonly events: ExplorationEvent[] = [];
  private readonly maxSize: number;
  private overflowCount = 0;
  private routingCount = 0;
  private explorationCount = 0;
  private divergenceCount = 0;
  private coordinationOverrideCount = 0;
  private nextEventId = 0;
  private readonly perTenant: Map<
    string,
    {
      routing: number;
      exploration: number;
      divergence: number;
      coordinationOverride: number;
    }
  > = new Map();
  /**
   * P6: per-tenant ε-greedy overrides. Shared with the TopologyRouter
   * via constructor injection so PUT on the HTTP endpoint takes
   * effect on the very next `route()` call.
   */
  private readonly epsilonStore: EpsilonStore;

  private readonly persistPath?: string;

  constructor(
    maxSize: number = DEFAULT_MAX_SIZE,
    epsilonStore?: EpsilonStore,
    persistPath?: string,
  ) {
    this.maxSize = maxSize > 0 ? Math.floor(maxSize) : DEFAULT_MAX_SIZE;
    this.epsilonStore = epsilonStore ?? new EpsilonStore();
    this.persistPath = persistPath;
    if (this.persistPath) {
      this.loadFromDisk();
    }
  }

  /**
   * P6: expose the epsilon store so the HTTP handler can call
   * set/clear/list without reaching into private state.
   */
  getEpsilonStore(): EpsilonStore {
    return this.epsilonStore;
  }

  private loadFromDisk(): void {
    if (!this.persistPath || !existsSync(this.persistPath)) return;
    const lines = readFileSync(this.persistPath, 'utf-8').split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as ExplorationEvent;
        if (!event.eventId || !event.timestamp || !event.tenantId) continue;
        this.events.push(event);
        this.nextEventId = Math.max(this.nextEventId, event.eventId);
        this.routingCount += 1;
        if (event.diverged) {
          this.explorationCount += 1;
          this.divergenceCount += 1;
        }
        if (event.coordinationOverride) {
          this.coordinationOverrideCount += 1;
        }
        const tenant = this.perTenant.get(event.tenantId) ?? {
          routing: 0,
          exploration: 0,
          divergence: 0,
          coordinationOverride: 0,
        };
        tenant.routing += 1;
        if (event.diverged) {
          tenant.exploration += 1;
          tenant.divergence += 1;
        }
        if (event.coordinationOverride) {
          tenant.coordinationOverride += 1;
        }
        this.perTenant.set(event.tenantId, tenant);
      } catch (err) {
        reportSilentFailure(err, 'explorationEventLog:249');
        /* skip corrupt lines */
      }
    }
    // Trim to maxSize in case the persisted file grew larger
    while (this.events.length > this.maxSize) {
      this.events.shift();
      this.overflowCount += 1;
    }
  }

  private appendToDisk(event: ExplorationEvent): void {
    if (!this.persistPath) return;
    const path = this.persistPath;
    const line = JSON.stringify(event) + '\n';
    const dir = dirname(path);
    void (async () => {
      try {
        if (!existsSync(dir)) {
          await mkdir(dir, { recursive: true });
        }
        await appendFile(path, line, 'utf-8');
      } catch (err) {
        reportSilentFailure(err, 'explorationEventLog:appendToDisk');
        /* best-effort persistence */
      }
    })();
  }

  /**
   * Record a single routing decision. Called from TopologyRouter on
   * every call to `route()`. The log evicts the oldest event when
   * the ring is full.
   */
  record(
    event: Omit<
      ExplorationEvent,
      'timestamp' | 'coordinationOverride' | 'finalTopology' | 'eventId'
    > &
      Partial<Pick<ExplorationEvent, 'coordinationOverride' | 'finalTopology' | 'eventId'>>,
  ): { eventId: number; timestamp: string } {
    const eventId = event.eventId ?? ++this.nextEventId;
    const timestamp = new Date().toISOString();
    const fullEvent: ExplorationEvent = {
      ...event,
      eventId,
      coordinationOverride: event.coordinationOverride ?? false,
      finalTopology: event.finalTopology ?? event.chosenTopology,
      timestamp,
    };
    this.events.push(fullEvent);
    if (this.events.length > this.maxSize) {
      this.events.shift();
      this.overflowCount += 1;
    }
    this.routingCount += 1;
    if (event.diverged) {
      this.explorationCount += 1;
      this.divergenceCount += 1;
    }
    if (fullEvent.coordinationOverride) {
      this.coordinationOverrideCount += 1;
    }
    const tenant = this.perTenant.get(event.tenantId) ?? {
      routing: 0,
      exploration: 0,
      divergence: 0,
      coordinationOverride: 0,
    };
    tenant.routing += 1;
    if (event.diverged) {
      tenant.exploration += 1;
      tenant.divergence += 1;
    }
    if (fullEvent.coordinationOverride) {
      tenant.coordinationOverride += 1;
    }
    this.perTenant.set(event.tenantId, tenant);
    this.appendToDisk(fullEvent);
    return { eventId, timestamp };
  }

  /**
   * P5: update the final topology for a recorded event (e.g. when
   * the orchestrator's coordination policy overrides the router's
   * pick). Keyed on the monotonic `eventId` (assigned at insertion
   * time) rather than `(timestamp, runId)` so that two events
   * recorded in the same millisecond are not conflated.
   *
   * Returns true if the event was found and updated, false if it
   * was already evicted from the ring.
   */
  updateFinalTopology(eventId: number, finalTopology: OrchestrationTopology): boolean {
    const idx = this.events.findIndex((e) => e.eventId === eventId);
    if (idx === -1) return false;
    const prev = this.events[idx]!;
    const wasOverride = prev.coordinationOverride;
    const nowOverride = prev.chosenTopology !== finalTopology;
    this.events[idx] = { ...prev, finalTopology, coordinationOverride: nowOverride };
    if (!wasOverride && nowOverride) {
      this.coordinationOverrideCount += 1;
      const t = this.perTenant.get(prev.tenantId);
      if (t) t.coordinationOverride += 1;
    }
    return true;
  }

  /**
   * Look up the most recently recorded event for a given runId.
   * Used by the orchestrator to find the event to update after
   * coordination-policy override. Returns undefined if the event
   * was already evicted from the ring.
   */
  findLatestByRunId(runId: string): ExplorationEvent | undefined {
    for (let i = this.events.length - 1; i >= 0; i--) {
      if (this.events[i]!.runId === runId) return this.events[i]!;
    }
    return undefined;
  }

  /**
   * Build a dashboard snapshot. Filtering is applied to the
   * `recentEvents`, `divergenceHistogram`, `tenants`, and `totals`
   * blocks. The `globalStats` block always reflects cumulative
   * process-lifetime counters (so operators can see "1.3M routings
   * served this hour" even when a tenant filter is active).
   */
  getSnapshot(filter: ExplorationEventLogFilter = {}): ExplorationSnapshot {
    const limit = Math.min(Math.max(filter.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
    const sinceMs = filter.since ? Date.parse(filter.since) : undefined;

    // 1. Filter
    let filtered = this.events;
    if (filter.tenantId !== undefined) {
      filtered = filtered.filter((e) => e.tenantId === filter.tenantId);
    }
    if (sinceMs !== undefined && !Number.isNaN(sinceMs)) {
      filtered = filtered.filter((e) => Date.parse(e.timestamp) >= sinceMs);
    }
    if (filter.divergedOnly) {
      filtered = filtered.filter((e) => e.diverged);
    }

    // 2. Filter-aware totals (privacy-preserving when tenant-scoped)
    let fRouting = 0;
    let fExpl = 0;
    let fDiv = 0;
    let fCoord = 0;
    for (const e of filtered) {
      fRouting += 1;
      if (e.diverged) {
        fExpl += 1;
        fDiv += 1;
      }
      if (e.coordinationOverride) fCoord += 1;
    }

    // 3. Divergence histogram (sign-preserving buckets)
    const bucketCounts = new Map<MarginBucket, number>(ALL_BUCKETS.map((b) => [b, 0]));
    for (const e of filtered) {
      const argmaxScore = e.topCandidates.find((c) => c.topology === e.argmaxTopology)?.score ?? 0;
      const chosenScore = e.topCandidates.find((c) => c.topology === e.chosenTopology)?.score ?? 0;
      const bucket = marginBucket(argmaxScore - chosenScore);
      bucketCounts.set(bucket, (bucketCounts.get(bucket) ?? 0) + 1);
    }
    const divergenceHistogram: ExplorationDivergenceBucket[] = ALL_BUCKETS.map((b) => ({
      marginBucket: b,
      count: bucketCounts.get(b) ?? 0,
    }));

    // 4. Per-tenant aggregates (filter-aware: when a tenantId filter is
    //    active, only emit that tenant).
    let tenantsSource: Iterable<
      [
        string,
        { routing: number; exploration: number; divergence: number; coordinationOverride: number },
      ]
    >;
    if (filter.tenantId !== undefined) {
      const t = this.perTenant.get(filter.tenantId);
      tenantsSource = t ? [[filter.tenantId, t]] : [];
    } else {
      tenantsSource = this.perTenant.entries();
    }
    const tenants: ExplorationTenantStats[] = Array.from(tenantsSource).map(([tenantId, c]) => ({
      tenantId,
      routingCount: c.routing,
      explorationCount: c.exploration,
      divergenceCount: c.divergence,
      explorationRate: c.routing > 0 ? c.exploration / c.routing : 0,
      divergenceRate: c.routing > 0 ? c.divergence / c.routing : 0,
    }));
    tenants.sort((a, b) => b.routingCount - a.routingCount);

    // 5. Recent events: tail-cap
    const recentEvents = filtered.slice(-limit);

    // 6. Truncation: true iff the filter dropped events that exist
    //    in the ring. Distinct from globalStats.overflowCount which
    //    is a process-lifetime flag.
    const truncated = filtered.length < this.events.length;

    return {
      totals: {
        routingCount: fRouting,
        explorationCount: fExpl,
        divergenceCount: fDiv,
        explorationRate: fRouting > 0 ? fExpl / fRouting : 0,
        divergenceRate: fRouting > 0 ? fDiv / fRouting : 0,
        coordinationOverrideCount: fCoord,
      },
      globalStats: {
        lifetimeRoutingCount: this.routingCount,
        lifetimeExplorationCount: this.explorationCount,
        lifetimeDivergenceCount: this.divergenceCount,
        lifetimeExplorationRate:
          this.routingCount > 0 ? this.explorationCount / this.routingCount : 0,
        lifetimeDivergenceRate:
          this.routingCount > 0 ? this.divergenceCount / this.routingCount : 0,
        ringBufferSize: this.events.length,
        ringBufferMaxSize: this.maxSize,
        lifetimeOverflowCount: this.overflowCount,
        capturedAt: new Date().toISOString(),
      },
      tenants,
      divergenceHistogram,
      recentEvents,
      truncated,
    };
  }

  /** Number of events currently in the ring (no filter applied). */
  size(): number {
    return this.events.length;
  }

  /** Hard cap on ring size. */
  capacity(): number {
    return this.maxSize;
  }

  /**
   * Reset all counters and clear the ring. The exploration counters
   * inside TopologyRouter are NOT touched — callers that want a full
   * reset should also call `topologyRouter.resetExplorationCounters()`.
   * The epsilon store is intentionally NOT reset here — operator-set
   * overrides should survive an event-log reset.
   */
  reset(): void {
    this.events.length = 0;
    this.overflowCount = 0;
    this.routingCount = 0;
    this.explorationCount = 0;
    this.divergenceCount = 0;
    this.coordinationOverrideCount = 0;
    this.perTenant.clear();
  }
}

export type { EpsilonOverride };
