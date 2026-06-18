/**
 * Cost Dashboard — Comprehensive cost intelligence view.
 *
 * Aggregates metrics from all cost optimization subsystems into a single
 * dashboard view. Provides actionable insights for cost reduction.
 *
 * Usage:
 *   const dashboard = getCostDashboard();
 *   const report = await dashboard.generateReport();
 *   console.log(dashboard.formatReport(report));
 */

import { getMetricsCollector } from './metricsCollector';
import { getModelPerformanceStore } from './modelPerformanceStore';

// ============================================================================
// Types
// ============================================================================

export interface CostDashboardReport {
  timestamp: string;
  summary: {
    totalRuns: number;
    totalTokens: number;
    estimatedCostUsd: number;
    cacheSavingsUsd: number;
    promptCacheSavingsUsd: number;
    earlyExits: number;
    verificationSkips: number;
    entropyGatedTools: number;
    cascadeEscalations: number;
  };
  cachePerformance: {
    toolCache: { hits: number; misses: number; hitRate: number };
    semanticCache: { hits: number; misses: number; hitRate: number };
    singleFlight: { hits: number; misses: number; hitRate: number };
    geminiCache: { hits: number; creates: number; hitRate: number };
    promptCache: {
      hits: number;
      misses: number;
      hitRate: number;
      tokensCached: number;
      dollarsSaved: number;
    };
  };
  modelPerformance: Array<{
    modelId: string;
    taskType: string;
    successRate: number;
    avgDurationMs: number;
    count: number;
  }>;
  governorStrategies: {
    verificationSkips: number;
    toolTruncations: number;
    entropyGates: number;
    promptCompressions: number;
  };
  costEstimation: {
    avgPredictionAccuracy: number;
    totalPredictions: number;
  };
}

// ============================================================================
// CostDashboard
// ============================================================================

export class CostDashboard {
  /**
   * Generate a comprehensive cost dashboard report.
   */
  async generateReport(): Promise<CostDashboardReport> {
    const metrics = getMetricsCollector();

    // Summary metrics
    const totalRuns = metrics.getCounter('runs_total');
    const totalTokens = metrics.getCounter('llm_tokens_total');
    const earlyExits = metrics.getCounter('early_exits_total');
    const verificationSkips = metrics.getCounter('verification_skipped_total');
    const entropyGatedTools = metrics.getCounter('entropy_gated_tools_total');
    const cascadeEscalations = metrics.getCounter('cascade_escalations_total');

    // Cache performance
    const toolCacheHits = metrics.getCounter('tool_cache_events_total', [
      { name: 'outcome', value: 'hit' },
    ]);
    const toolCacheMisses = metrics.getCounter('tool_cache_events_total', [
      { name: 'outcome', value: 'miss' },
    ]);
    const semanticCacheHits = metrics.getCounter('semantic_cache_events_total', [
      { name: 'outcome', value: 'hit' },
    ]);
    const semanticCacheMisses = metrics.getCounter('semantic_cache_events_total', [
      { name: 'outcome', value: 'miss' },
    ]);
    const singleFlightHits = metrics.getCounter('single_flight_events_total', [
      { name: 'outcome', value: 'hit' },
    ]);
    const singleFlightMisses = metrics.getCounter('single_flight_events_total', [
      { name: 'outcome', value: 'miss' },
    ]);
    const geminiCacheHits = metrics.getCounter('gemini_cache_events_total', [
      { name: 'outcome', value: 'hit' },
    ]);
    const geminiCacheCreates = metrics.getCounter('gemini_cache_events_total', [
      { name: 'outcome', value: 'create' },
    ]);
    // Prompt-prefix cache: local hash-key stability hits/misses (different
    // signal from provider-reported cache reads — joined in display).
    const promptPrefixCacheHits = metrics.getCounter('prompt_prefix_cache_total', [
      { name: 'outcome', value: 'hit' },
    ]);
    const promptPrefixCacheMisses = metrics.getCounter('prompt_prefix_cache_total', [
      { name: 'outcome', value: 'miss' },
    ]);
    // Provider-reported cache read dollars + tokens (sum across all label combos).
    const promptCacheTokensRead = metrics.getCounterTotal('prompt_cache_tokens_read_total');
    const promptCacheDollarsSaved = metrics.getCounterTotal('prompt_cache_cost_saved_usd_total');

    // Cost savings from semantic cache
    const semanticCacheCostSaved = metrics.getCounter('semantic_cache_cost_saved_usd_total', [
      { name: 'outcome', value: 'hit' },
    ]);

    // Model performance
    const modelPerformance = getModelPerformanceStore().getAggregatedStats().slice(0, 10);

    // Governor strategy usage
    // Cost estimation accuracy
    const predictionAccuracy = metrics.getGauge('cost_prediction_accuracy');

    return {
      timestamp: new Date().toISOString(),
      summary: {
        totalRuns,
        totalTokens,
        estimatedCostUsd: this.estimateTotalCost(metrics),
        // Combined cache savings: semantic + provider prompt cache. Kept as
        // a sum so existing consumers see the full picture; the breakdown
        // is available in `promptCacheSavingsUsd` and the per-cache section.
        cacheSavingsUsd: semanticCacheCostSaved + promptCacheDollarsSaved,
        promptCacheSavingsUsd: promptCacheDollarsSaved,
        earlyExits,
        verificationSkips,
        entropyGatedTools,
        cascadeEscalations,
      },
      cachePerformance: {
        toolCache: {
          hits: toolCacheHits,
          misses: toolCacheMisses,
          hitRate:
            toolCacheHits + toolCacheMisses > 0
              ? toolCacheHits / (toolCacheHits + toolCacheMisses)
              : 0,
        },
        semanticCache: {
          hits: semanticCacheHits,
          misses: semanticCacheMisses,
          hitRate:
            semanticCacheHits + semanticCacheMisses > 0
              ? semanticCacheHits / (semanticCacheHits + semanticCacheMisses)
              : 0,
        },
        singleFlight: {
          hits: singleFlightHits,
          misses: singleFlightMisses,
          hitRate:
            singleFlightHits + singleFlightMisses > 0
              ? singleFlightHits / (singleFlightHits + singleFlightMisses)
              : 0,
        },
        geminiCache: {
          hits: geminiCacheHits,
          creates: geminiCacheCreates,
          hitRate:
            geminiCacheHits + geminiCacheCreates > 0
              ? geminiCacheHits / (geminiCacheHits + geminiCacheCreates)
              : 0,
        },
        promptCache: {
          hits: promptPrefixCacheHits,
          misses: promptPrefixCacheMisses,
          hitRate:
            promptPrefixCacheHits + promptPrefixCacheMisses > 0
              ? promptPrefixCacheHits / (promptPrefixCacheHits + promptPrefixCacheMisses)
              : 0,
          tokensCached: promptCacheTokensRead,
          dollarsSaved: promptCacheDollarsSaved,
        },
      },
      modelPerformance,
      governorStrategies: {
        verificationSkips,
        toolTruncations: 0, // Would need a counter for this
        entropyGates: entropyGatedTools,
        promptCompressions: 0, // Would need a counter for this
      },
      costEstimation: {
        avgPredictionAccuracy: predictionAccuracy,
        totalPredictions: totalRuns,
      },
    };
  }

  /**
   * Format the report as a human-readable string.
   */
  formatReport(report: CostDashboardReport): string {
    const lines: string[] = [];

    lines.push('╔══════════════════════════════════════════════════════════════╗');
    lines.push('║                  COST INTELLIGENCE DASHBOARD                ║');
    lines.push('╚══════════════════════════════════════════════════════════════╝');
    lines.push(`Generated: ${report.timestamp}`);
    lines.push('');

    // Summary
    lines.push('── SUMMARY ──');
    lines.push(`  Total runs:           ${report.summary.totalRuns}`);
    lines.push(`  Total tokens:         ${report.summary.totalTokens.toLocaleString()}`);
    lines.push(`  Estimated cost:       $${report.summary.estimatedCostUsd.toFixed(4)}`);
    lines.push(
      `  Cache savings:        $${report.summary.cacheSavingsUsd.toFixed(4)}  (semantic + prompt-cache)`,
    );
    lines.push(`    Prompt-cache only:  $${report.summary.promptCacheSavingsUsd.toFixed(4)}`);
    lines.push('');

    // Optimization Impact
    lines.push('── OPTIMIZATION IMPACT ──');
    lines.push(
      `  Early exits:          ${report.summary.earlyExits} (saved ~${report.summary.earlyExits * 1000} tokens)`,
    );
    lines.push(
      `  Verification skips:   ${report.summary.verificationSkips} (saved ~${report.summary.verificationSkips * 1000} tokens)`,
    );
    lines.push(
      `  Entropy-gated tools:  ${report.summary.entropyGatedTools} (saved ~${report.summary.entropyGatedTools * 500} tokens)`,
    );
    lines.push(`  Cascade escalations:  ${report.summary.cascadeEscalations}`);
    lines.push('');

    // Cache Performance
    lines.push('── CACHE PERFORMANCE ──');
    const fmt = (n: number) => n.toLocaleString();
    const pct = (r: number) => (r * 100).toFixed(1) + '%';
    lines.push(
      `  Tool cache:           ${fmt(report.cachePerformance.toolCache.hits)} hits / ${fmt(report.cachePerformance.toolCache.misses)} misses (${pct(report.cachePerformance.toolCache.hitRate)})`,
    );
    lines.push(
      `  Semantic cache:       ${fmt(report.cachePerformance.semanticCache.hits)} hits / ${fmt(report.cachePerformance.semanticCache.misses)} misses (${pct(report.cachePerformance.semanticCache.hitRate)})`,
    );
    lines.push(
      `  Single-flight dedup:  ${fmt(report.cachePerformance.singleFlight.hits)} hits / ${fmt(report.cachePerformance.singleFlight.misses)} misses (${pct(report.cachePerformance.singleFlight.hitRate)})`,
    );
    lines.push(
      `  Gemini cache:         ${fmt(report.cachePerformance.geminiCache.hits)} hits / ${fmt(report.cachePerformance.geminiCache.creates)} creates (${pct(report.cachePerformance.geminiCache.hitRate)})`,
    );
    lines.push(
      `  Prompt cache:         ${fmt(report.cachePerformance.promptCache.hits)} hits / ${fmt(report.cachePerformance.promptCache.misses)} misses (${pct(report.cachePerformance.promptCache.hitRate)}) — $${report.cachePerformance.promptCache.dollarsSaved.toFixed(4)} saved (${fmt(report.cachePerformance.promptCache.tokensCached)} tokens cached)`,
    );
    lines.push('');

    // Model Performance
    if (report.modelPerformance.length > 0) {
      lines.push('── MODEL PERFORMANCE (top 10) ──');
      for (const m of report.modelPerformance) {
        lines.push(
          `  ${m.modelId.padEnd(30)} ${m.taskType.padEnd(10)} ${(m.successRate * 100).toFixed(0)}% success  ${m.count} runs`,
        );
      }
      lines.push('');
    }

    // Cost Estimation
    lines.push('── COST ESTIMATION ──');
    lines.push(
      `  Prediction accuracy:  ${report.costEstimation.avgPredictionAccuracy > 0 ? (report.costEstimation.avgPredictionAccuracy * 100).toFixed(0) + '%' : 'N/A (no data yet)'}`,
    );
    lines.push('');

    return lines.join('\n');
  }

  /**
   * Format the report as JSON.
   */
  formatJson(report: CostDashboardReport): string {
    return JSON.stringify(report, null, 2);
  }

  // --------------------------------------------------------------------------
  // Private
  // --------------------------------------------------------------------------

  private estimateTotalCost(metrics: ReturnType<typeof getMetricsCollector>): number {
    // Rough estimate: total tokens × average cost per token
    const totalTokens = metrics.getCounter('llm_tokens_total');
    // Blended rate: ~$5/M input, ~$15/M output (weighted average across providers)
    const avgCostPerToken = 10 / 1_000_000; // $10/M blended
    return totalTokens * avgCostPerToken;
  }
}

// ============================================================================
// Singleton
// ============================================================================

let _dashboard: CostDashboard | null = null;

export function getCostDashboard(): CostDashboard {
  if (!_dashboard) _dashboard = new CostDashboard();
  return _dashboard;
}

export function resetCostDashboard(): void {
  _dashboard = null;
}
