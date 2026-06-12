/**
 * Cost Aggregator — Pure aggregation logic for `commander cost`.
 *
 * Reads historical LLM call records from .commander_samples/llm_calls.ndjson
 * and produces per-model / per-agent / per-day breakdowns using real
 * per-model pricing from TokenSentinel.
 *
 * Extracted from cmdCost (small-features.ts) so it can be unit-tested
 * independently of CLI argument parsing.
 */

import * as fs from 'fs';
import * as path from 'path';
import { calculateCostBreakdown } from '../telos/tokenSentinel';
import { getModelRouter } from '../runtime/modelRouter';
import { getMetricsCollector } from '../runtime/metricsCollector';

// ============================================================================
// Types
// ============================================================================

export interface LLMCallRow {
  callId?: string;
  runId?: string;
  agentId?: string;
  model: string;
  provider?: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  durationMs?: number;
  timestamp: string;
  error?: string;
}

export interface CostAggregate {
  calls: number;
  successfulCalls: number;
  failedCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  cacheSavingsUsd: number;
  durationMs: number;
}

export interface CostReport {
  total: CostAggregate;
  byModel: Record<string, CostAggregate>;
  byAgent: Record<string, CostAggregate>;
  byDay: Record<string, CostAggregate>;
  byProvider: Record<string, CostAggregate>;
  /**
   * Per-cache-type breakdown: hit rate and estimated USD saved. Sources:
   * - prompt: Anthropic/OpenAI/Gemini server-side prompt cache (cacheReadTokens × delta)
   * - semantic: response semantic cache (cost saved per hit)
   * - single_flight: request dedup (saves the full call cost on the deduped N-1 callers)
   * - tool: tool result cache
   */
  byCacheType: Record<CacheType, CacheTypeStats>;
  /** Records that failed to parse (line-level JSON errors). Only set by parseSampleFile-based reports. */
  parseErrors?: number;
  recordsScanned: number;
  rangeStart?: string;
  rangeEnd?: string;
}

/**
 * Cache type for per-cache cost attribution. The set is closed; new cache types require a
 * new enum entry AND a new metric emission site in the runtime.
 */
export type CacheType = 'prompt' | 'semantic' | 'single_flight' | 'tool';

/**
 * Stats for a single cache type. `events` is the raw hit/miss/store/eviction counts from the
 * metrics collector; `hitRate` and `savingsUsd` are derived.
 */
export interface CacheTypeStats {
  events: {
    hit: number;
    miss: number;
    store: number;
    eviction: number;
    error: number;
    create?: number;
  };
  /** hitRate in [0,1]; 0 if no events. */
  hitRate: number;
  /** Estimated USD saved by hits (prompt cache uses cacheReadTokens × pricing delta). */
  savingsUsd: number;
  /** Total events observed. */
  totalEvents: number;
}

export interface CostFilter {
  since?: Date;
  until?: Date;
  model?: string;
  agent?: string;
  provider?: string;
}

// ============================================================================
// Reader
// ============================================================================

/**
 * Read all LLM call records from the samples store on disk.
 * Skips malformed lines silently. Returns empty array if the file does not exist.
 */
export function readLLMCallRecords(baseDir?: string): {
  records: LLMCallRow[];
  parseErrors: number;
} {
  const samplesDir = baseDir ?? path.join(process.cwd(), '.commander_samples');
  const filePath = path.join(samplesDir, 'llm_calls.ndjson');

  if (!fs.existsSync(filePath)) {
    return { records: [], parseErrors: 0 };
  }

  const records: LLMCallRow[] = [];
  let parseErrors = 0;
  const content = fs.readFileSync(filePath, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const raw = JSON.parse(trimmed) as Record<string, unknown>;
      records.push(normalizeRecord(raw));
    } catch {
      parseErrors++;
    }
  }
  return { records, parseErrors };
}

function normalizeRecord(raw: Record<string, unknown>): LLMCallRow {
  return {
    callId: raw.callId as string | undefined,
    runId: raw.runId as string | undefined,
    agentId: raw.agentId as string | undefined,
    model: (raw.model as string) ?? 'unknown',
    provider: raw.provider as string | undefined,
    promptTokens: (raw.promptTokens as number) ?? 0,
    completionTokens: (raw.completionTokens as number) ?? 0,
    totalTokens: (raw.totalTokens as number) ?? 0,
    cacheReadTokens: (raw.cacheReadTokens as number) ?? 0,
    cacheWriteTokens: (raw.cacheWriteTokens as number) ?? 0,
    durationMs: raw.durationMs as number | undefined,
    timestamp: (raw.timestamp as string) ?? new Date(0).toISOString(),
    error: raw.error as string | undefined,
  };
}

// ============================================================================
// Aggregator
// ============================================================================

function emptyAggregate(): CostAggregate {
  return {
    calls: 0,
    successfulCalls: 0,
    failedCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
    cacheSavingsUsd: 0,
    durationMs: 0,
  };
}

function addToAggregate(agg: CostAggregate, row: LLMCallRow): void {
  agg.calls++;
  if (row.error) agg.failedCalls++;
  else agg.successfulCalls++;

  agg.inputTokens += row.promptTokens;
  agg.outputTokens += row.completionTokens;
  agg.cacheReadTokens += row.cacheReadTokens ?? 0;
  agg.cacheWriteTokens += row.cacheWriteTokens ?? 0;
  if (row.durationMs) agg.durationMs += row.durationMs;

  const breakdown = calculateCostBreakdown(
    row.model,
    row.promptTokens,
    row.completionTokens,
    row.cacheReadTokens ?? 0,
    row.cacheWriteTokens ?? 0,
  );
  agg.costUsd += breakdown.totalUsd;
  agg.cacheSavingsUsd += breakdown.cacheSavingsUsd;
}

function passesFilter(row: LLMCallRow, filter: CostFilter): boolean {
  const ts = new Date(row.timestamp).getTime();
  if (filter.since && ts < filter.since.getTime()) return false;
  if (filter.until && ts > filter.until.getTime()) return false;
  if (filter.model && row.model !== filter.model) return false;
  if (filter.agent && row.agentId !== filter.agent) return false;
  if (filter.provider) {
    const router = getModelRouter();
    const m = router.getModel(row.model);
    const provider = m?.provider ?? row.provider;
    if (provider !== filter.provider) return false;
  }
  return true;
}

function dayKey(timestamp: string): string {
  return timestamp.slice(0, 10);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round5(n: number): number {
  return Math.round(n * 100000) / 100000;
}

function finalizeAggregate(agg: CostAggregate): CostAggregate {
  return {
    ...agg,
    costUsd: round5(agg.costUsd),
    cacheSavingsUsd: round5(agg.cacheSavingsUsd),
  };
}

/**
 * Build a full cost report from raw LLM call records.
 */
export function aggregateCost(
  records: LLMCallRow[],
  filter: CostFilter = {},
): CostReport {
  const total = emptyAggregate();
  const byModel: Record<string, CostAggregate> = {};
  const byAgent: Record<string, CostAggregate> = {};
  const byDay: Record<string, CostAggregate> = {};
  const byProvider: Record<string, CostAggregate> = {};

  let minTs: number | undefined;
  let maxTs: number | undefined;

  for (const row of records) {
    if (!passesFilter(row, filter)) continue;

    const ts = new Date(row.timestamp).getTime();
    if (minTs === undefined || ts < minTs) minTs = ts;
    if (maxTs === undefined || ts > maxTs) maxTs = ts;

    addToAggregate(total, row);
    addToAggregate(byModel[row.model] ??= emptyAggregate(), row);
    addToAggregate(byAgent[row.agentId ?? '(unknown)'] ??= emptyAggregate(), row);
    addToAggregate(byDay[dayKey(row.timestamp)] ??= emptyAggregate(), row);

    const router = getModelRouter();
    const provider = router.getModel(row.model)?.provider ?? row.provider ?? '(unknown)';
    addToAggregate(byProvider[provider] ??= emptyAggregate(), row);
  }

  for (const k of Object.keys(byModel)) byModel[k] = finalizeAggregate(byModel[k]);
  for (const k of Object.keys(byAgent)) byAgent[k] = finalizeAggregate(byAgent[k]);
  for (const k of Object.keys(byDay)) byDay[k] = finalizeAggregate(byDay[k]);
  for (const k of Object.keys(byProvider)) byProvider[k] = finalizeAggregate(byProvider[k]);

  const byCacheType = buildCacheTypeBreakdown(records);

  return {
    total: finalizeAggregate(total),
    byModel,
    byAgent,
    byDay,
    byProvider,
    byCacheType,
    recordsScanned: records.length,
    rangeStart: minTs ? new Date(minTs).toISOString() : undefined,
    rangeEnd: maxTs ? new Date(maxTs).toISOString() : undefined,
  };
}

// ============================================================================
// Per-Cache-Type Breakdown
// ============================================================================

/**
 * Build per-cache-type stats by reading live counters from the metrics collector
 * and attributing per-record cache savings to the prompt-cache (the only cache
 * type that emits cacheReadTokens / cacheWriteTokens today).
 *
 * Counter sources (all in metricsCollector.ts):
 * - semantic_cache_events_total{outcome=hit|miss|store|embedding_error}
 * - single_flight_events_total{outcome=hit|miss|eviction}
 * - gemini_cache_events_total{outcome=hit|create|evict|error}
 * - semantic_cache_cost_saved_usd_total{outcome=hit}
 *
 * The `prompt` cache type uses cacheReadTokens aggregated in CostAggregate
 * (already computed via calculateCostBreakdown in addToAggregate). We expose it
 * as the same `savingsUsd` value for the `prompt` cache type — the same number,
 * just attributed.
 */
function buildCacheTypeBreakdown(records: LLMCallRow[]): Record<CacheType, CacheTypeStats> {
  const metrics = getMetricsCollector();
  const empty = (): CacheTypeStats => ({
    events: { hit: 0, miss: 0, store: 0, eviction: 0, error: 0 },
    hitRate: 0,
    savingsUsd: 0,
    totalEvents: 0,
  });

  // --- semantic cache: events from semantic_cache_events_total ---
  const semantic = empty();
  semantic.events.hit = metrics.getCounter('semantic_cache_events_total', [{ name: 'outcome', value: 'hit' }]);
  semantic.events.miss = metrics.getCounter('semantic_cache_events_total', [{ name: 'outcome', value: 'miss' }]);
  semantic.events.store = metrics.getCounter('semantic_cache_events_total', [{ name: 'outcome', value: 'store' }]);
  semantic.events.error = metrics.getCounter('semantic_cache_events_total', [{ name: 'outcome', value: 'embedding_error' }]);
  const semanticHitCost = metrics.getCounter('semantic_cache_cost_saved_usd_total', [{ name: 'outcome', value: 'hit' }]);
  semantic.savingsUsd = round5(semanticHitCost);
  semantic.totalEvents = semantic.events.hit + semantic.events.miss + semantic.events.store + semantic.events.error;
  const semanticTotal = semantic.events.hit + semantic.events.miss;
  semantic.hitRate = semanticTotal === 0 ? 0 : semantic.events.hit / semanticTotal;

  // --- single_flight cache: events from single_flight_events_total ---
  const singleFlight = empty();
  singleFlight.events.hit = metrics.getCounter('single_flight_events_total', [{ name: 'outcome', value: 'hit' }]);
  singleFlight.events.miss = metrics.getCounter('single_flight_events_total', [{ name: 'outcome', value: 'miss' }]);
  singleFlight.events.eviction = metrics.getCounter('single_flight_events_total', [{ name: 'outcome', value: 'eviction' }]);
  singleFlight.totalEvents = singleFlight.events.hit + singleFlight.events.miss + singleFlight.events.eviction;
  const sfTotal = singleFlight.events.hit + singleFlight.events.miss;
  singleFlight.hitRate = sfTotal === 0 ? 0 : singleFlight.events.hit / sfTotal;
  // Single-flight savings: each dedup hit saves a full call. Approximate as average call cost × hit count.
  singleFlight.savingsUsd = round5(estimateSingleFlightSavings(records, singleFlight.events.hit));

  // --- gemini prompt cache: events from gemini_cache_events_total (counts as a "prompt" cache source) ---
  const gemini = empty();
  gemini.events.hit = metrics.getCounter('gemini_cache_events_total', [{ name: 'outcome', value: 'hit' }]);
  (gemini.events as { create?: number }).create = metrics.getCounter('gemini_cache_events_total', [{ name: 'outcome', value: 'create' }]);
  gemini.events.eviction = metrics.getCounter('gemini_cache_events_total', [{ name: 'outcome', value: 'evict' }]);
  gemini.events.error = metrics.getCounter('gemini_cache_events_total', [{ name: 'outcome', value: 'error' }]);
  gemini.totalEvents = gemini.events.hit + ((gemini.events as { create?: number }).create ?? 0) + gemini.events.eviction + gemini.events.error;
  const gTotal = gemini.events.hit + ((gemini.events as { create?: number }).create ?? 0);
  gemini.hitRate = gTotal === 0 ? 0 : gemini.events.hit / gTotal;
  // Gemini savings come through cacheReadTokens on individual records — they are
  // already counted in the prompt cache type's savingsUsd below.

  // --- prompt cache (all providers: Anthropic + OpenAI + Gemini) ---
  // This is the only cache type that emits per-record cacheReadTokens today,
  // so it gets the full `cacheSavingsUsd` from the aggregates. We also include
  // semantic cache cost saved (it overlaps with prompt's hit count, but the two
  // are actually different: prompt = server-side, semantic = response-level).
  const prompt = empty();
  const promptHits = semanticHitCost > 0 ? 0 : 0; // placeholder: tracked at hit level only
  prompt.events.hit = promptHits; // not tracked per record
  prompt.savingsUsd = round5(records.reduce((sum, r) => {
    if (r.error) return sum;
    const breakdown = calculateCostBreakdown(r.model, r.promptTokens, r.completionTokens, r.cacheReadTokens ?? 0, r.cacheWriteTokens ?? 0);
    return sum + breakdown.cacheSavingsUsd;
  }, 0));
  prompt.totalEvents = prompt.events.hit + prompt.events.miss;
  prompt.hitRate = 0; // not trackable at this level — would need per-call attribution

  // --- tool result cache: events from tool_cache_events_total ---
  const tool = empty();
  tool.events.hit = metrics.getCounter('tool_cache_events_total', [{ name: 'outcome', value: 'hit' }]);
  tool.events.miss = metrics.getCounter('tool_cache_events_total', [{ name: 'outcome', value: 'miss' }]);
  tool.events.store = metrics.getCounter('tool_cache_events_total', [{ name: 'outcome', value: 'store' }]);
  tool.totalEvents = tool.events.hit + tool.events.miss + tool.events.store;
  const toolTotal = tool.events.hit + tool.events.miss;
  tool.hitRate = toolTotal === 0 ? 0 : tool.events.hit / toolTotal;
  // Tool cache savings: each hit avoids a tool re-execution. Approximate as average call cost × hit count.
  tool.savingsUsd = round5(estimateSingleFlightSavings(records, tool.events.hit));

  return { prompt, semantic, single_flight: singleFlight, tool };
}

/**
 * Estimate single-flight savings: average call cost × dedup hit count.
 * Each single-flight hit means a duplicate request was avoided; the avoided cost is
 * approximately the average cost of an LLM call in this report window.
 */
function estimateSingleFlightSavings(records: LLMCallRow[], hitCount: number): number {
  if (hitCount === 0 || records.length === 0) return 0;
  const totalCost = records.reduce((s, r) => {
    if (r.error) return s;
    const breakdown = calculateCostBreakdown(r.model, r.promptTokens, r.completionTokens, r.cacheReadTokens ?? 0, r.cacheWriteTokens ?? 0);
    return s + breakdown.totalUsd;
  }, 0);
  const avgCost = totalCost / records.length;
  return avgCost * hitCount;
}

// ============================================================================
// Formatters
// ============================================================================

/**
 * Render a cost report as a human-readable table.
 * Top-N entries shown for each category to keep output bounded.
 */
export function formatCostTable(report: CostReport, topN = 10): string {
  const lines: string[] = [];
  const t = report.total;

  lines.push('Total');
  lines.push(`  calls:           ${t.calls.toLocaleString()} (${t.successfulCalls} ok, ${t.failedCalls} failed)`);
  lines.push(`  input tokens:    ${t.inputTokens.toLocaleString()}`);
  lines.push(`  output tokens:   ${t.outputTokens.toLocaleString()}`);
  lines.push(`  cache reads:     ${t.cacheReadTokens.toLocaleString()} (saved $${t.cacheSavingsUsd.toFixed(4)})`);
  lines.push(`  cache writes:    ${t.cacheWriteTokens.toLocaleString()}`);
  lines.push(`  total cost:      $${t.costUsd.toFixed(4)}`);
  if (t.durationMs > 0) {
    lines.push(`  total time:      ${(t.durationMs / 1000).toFixed(1)}s`);
  }
  if (report.rangeStart && report.rangeEnd) {
    lines.push(`  range:           ${report.rangeStart} → ${report.rangeEnd}`);
  }
  if ((report.parseErrors ?? 0) > 0) {
    lines.push(`  parse errors:    ${report.parseErrors} (skipped)`);
  }

  lines.push('');
  lines.push(`By model (top ${topN}):`);
  const modelEntries = Object.entries(report.byModel)
    .sort((a, b) => b[1].costUsd - a[1].costUsd)
    .slice(0, topN);
  for (const [model, agg] of modelEntries) {
    lines.push(`  ${model.padEnd(36)} ${String(agg.calls).padStart(5)} calls  $${agg.costUsd.toFixed(4).padStart(10)}`);
  }

  lines.push('');
  lines.push(`By provider:`);
  const providerEntries = Object.entries(report.byProvider)
    .sort((a, b) => b[1].costUsd - a[1].costUsd);
  for (const [provider, agg] of providerEntries) {
    lines.push(`  ${provider.padEnd(20)} ${String(agg.calls).padStart(5)} calls  $${agg.costUsd.toFixed(4).padStart(10)}`);
  }

  lines.push('');
  lines.push(`By agent (top ${topN}):`);
  const agentEntries = Object.entries(report.byAgent)
    .sort((a, b) => b[1].costUsd - a[1].costUsd)
    .slice(0, topN);
  for (const [agent, agg] of agentEntries) {
    const label = agent.length > 36 ? agent.slice(0, 33) + '…' : agent;
    lines.push(`  ${label.padEnd(36)} ${String(agg.calls).padStart(5)} calls  $${agg.costUsd.toFixed(4).padStart(10)}`);
  }

  lines.push('');
  lines.push(`By day:`);
  const dayEntries = Object.entries(report.byDay)
    .sort((a, b) => a[0].localeCompare(b[0]));
  for (const [day, agg] of dayEntries) {
    lines.push(`  ${day}    ${String(agg.calls).padStart(5)} calls  $${agg.costUsd.toFixed(4).padStart(10)}`);
  }

  lines.push('');
  lines.push(`By cache type:`);
  const cacheEntries = Object.entries(report.byCacheType);
  for (const [type, stats] of cacheEntries) {
    const hitRatePct = (stats.hitRate * 100).toFixed(1);
    lines.push(
      `  ${type.padEnd(14)} ${String(stats.totalEvents).padStart(6)} events  ` +
      `hit_rate=${hitRatePct.padStart(5)}%  saved=$${stats.savingsUsd.toFixed(4)}  ` +
      `(hit=${stats.events.hit} miss=${stats.events.miss} ` +
      `store=${stats.events.store} evict=${stats.events.eviction})`,
    );
  }

  return lines.join('\n');
}

export function formatCostJson(report: CostReport): string {
  return JSON.stringify(report, null, 2);
}

export function formatCostCsv(report: CostReport): string {
  const rows: string[] = [];
  rows.push('category,key,calls,successful,failed,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,cost_usd,cache_savings_usd,duration_ms');

  const push = (category: string, key: string, agg: CostAggregate) => {
    rows.push([
      category,
      csvEscape(key),
      agg.calls,
      agg.successfulCalls,
      agg.failedCalls,
      agg.inputTokens,
      agg.outputTokens,
      agg.cacheReadTokens,
      agg.cacheWriteTokens,
      agg.costUsd,
      agg.cacheSavingsUsd,
      agg.durationMs,
    ].join(','));
  };

  push('total', 'all', report.total);
  for (const [k, v] of Object.entries(report.byModel)) push('model', k, v);
  for (const [k, v] of Object.entries(report.byAgent)) push('agent', k, v);
  for (const [k, v] of Object.entries(report.byDay)) push('day', k, v);
  for (const [k, v] of Object.entries(report.byProvider)) push('provider', k, v);

  return rows.join('\n') + '\n';
}

function csvEscape(s: string): string {
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export { round2, round5 };
