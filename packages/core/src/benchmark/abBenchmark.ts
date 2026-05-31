/**
 * A/B Benchmark — Proves Commander's optimizations save tokens and money.
 *
 * Runs the same tasks with optimizations ON (default) vs OFF (stripped),
 * then compares tokens, cost, latency, and quality.
 */
import type { UltimateOrchestratorConfig, EffortLevel } from '../ultimate/types';
import { DEFAULT_ULTIMATE_CONFIG } from '../ultimate/types';

// ============================================================================
// Types
// ============================================================================

export interface BenchmarkTask {
  id: string;
  label: string;
  goal: string;
  effortLevel?: EffortLevel;
}

export interface RunMetrics {
  totalTokens: number;
  totalCostUsd: number;
  elapsedMs: number;
  qualityScore: number;
  status: string;
  subAgentsSpawned: number;
  synthesisLength: number;
}

export interface ABResult {
  task: BenchmarkTask;
  optimized: RunMetrics;
  baseline: RunMetrics;
  tokenSaving: number;       // % reduction
  costSaving: number;        // % reduction
  latencyChange: number;     // % change (negative = faster)
  qualityChange: number;     // absolute delta
}

export interface BenchmarkSummary {
  results: ABResult[];
  avgTokenSaving: number;
  avgCostSaving: number;
  avgLatencyChange: number;
  avgQualityChange: number;
  totalTokensSaved: number;
  totalCostSaved: number;
}

// ============================================================================
// Default benchmark tasks — diverse enough to show optimization value
// ============================================================================

export const DEFAULT_TASKS: BenchmarkTask[] = [
  {
    id: 'simple-code',
    label: 'Simple code task',
    goal: 'Write a TypeScript function that validates email addresses using regex. Include edge cases.',
    effortLevel: 'SIMPLE',
  },
  {
    id: 'analysis',
    label: 'Analysis task',
    goal: 'Compare REST vs GraphQL APIs. List pros, cons, and when to use each. Include performance considerations.',
    effortLevel: 'MODERATE',
  },
  {
    id: 'complex-refactor',
    label: 'Complex refactoring',
    goal: 'Design a rate limiter in TypeScript with sliding window, token bucket, and leaky bucket algorithms. Include tests.',
    effortLevel: 'COMPLEX',
  },
  {
    id: 'debug-task',
    label: 'Debugging task',
    goal: 'Find and fix the bug: a function that merges two sorted arrays sometimes produces duplicates. Explain the root cause.',
    effortLevel: 'SIMPLE',
  },
  {
    id: 'research',
    label: 'Research synthesis',
    goal: 'Research and summarize the current state of WebAssembly in 2026. Cover browser support, toolchains, and real-world adoption.',
    effortLevel: 'MODERATE',
  },
];

// ============================================================================
// Config builders
// ============================================================================

/** Full optimization — Commander's default config */
export function buildOptimizedConfig(): Partial<UltimateOrchestratorConfig> {
  return { ...DEFAULT_ULTIMATE_CONFIG };
}

/** Baseline — all optimizations stripped for honest comparison */
export function buildBaselineConfig(): Partial<UltimateOrchestratorConfig> {
  return {
    enableDeliberation: false,
    enableTeams: false,
    enableCapabilityRouting: false,
    enableCircuitBreaker: false,
    enableArtifactSystem: false,
    maxRecursiveDepth: 1,
    maxParallelSubAgents: 1,
    defaultEffortLevel: 'SIMPLE',
    defaultThinkingBudget: {
      enabled: false,
      maxThinkingTokens: 0,
      subAgentThinkingTokens: 0,
      minThinkingBeforeTools: 0,
    },
    qualityGates: [],
    modelTierMapping: {
      SIMPLE: 'eco',
      MODERATE: 'eco',
      COMPLEX: 'eco',
      DEEP_RESEARCH: 'eco',
    },
  };
}

// ============================================================================
// Reporting
// ============================================================================

export function formatBenchmarkReport(summary: BenchmarkSummary): string {
  const lines: string[] = [];

  lines.push('');
  lines.push('  ═══════════════════════════════════════════════════════════');
  lines.push('  COMMANDER A/B BENCHMARK RESULTS');
  lines.push('  ═══════════════════════════════════════════════════════════');
  lines.push('');

  // Per-task results table
  lines.push('  ┌─────────────────────────────┬────────────┬────────────┬───────────┬───────────┐');
  lines.push('  │ Task                        │ Tok (opt)  │ Tok (base) │ Saved     │ Δ Quality │');
  lines.push('  ├─────────────────────────────┼────────────┼────────────┼───────────┼───────────┤');

  for (const r of summary.results) {
    const label = r.task.label.padEnd(27).slice(0, 27);
    const tokOpt = String(r.optimized.totalTokens).padStart(10);
    const tokBase = String(r.baseline.totalTokens).padStart(10);
    const saved = `${r.tokenSaving >= 0 ? '-' : '+'}${Math.abs(r.tokenSaving).toFixed(1)}%`.padStart(9);
    const qual = `${r.qualityChange >= 0 ? '+' : ''}${r.qualityChange.toFixed(2)}`.padStart(9);
    lines.push(`  │ ${label} │ ${tokOpt} │ ${tokBase} │ ${saved} │ ${qual} │`);
  }

  lines.push('  └─────────────────────────────┴────────────┴────────────┴───────────┴───────────┘');
  lines.push('');

  // Summary
  lines.push('  AVERAGES');
  lines.push(`  Token savings:     ${summary.avgTokenSaving >= 0 ? '-' : '+'}${Math.abs(summary.avgTokenSaving).toFixed(1)}%`);
  lines.push(`  Cost savings:      ${summary.avgCostSaving >= 0 ? '-' : '+'}${Math.abs(summary.avgCostSaving).toFixed(1)}%`);
  lines.push(`  Latency change:    ${summary.avgLatencyChange >= 0 ? '+' : ''}${summary.avgLatencyChange.toFixed(1)}%`);
  lines.push(`  Quality change:    ${summary.avgQualityChange >= 0 ? '+' : ''}${summary.avgQualityChange.toFixed(3)}`);
  lines.push('');
  lines.push('  TOTAL');
  lines.push(`  Tokens saved:      ${summary.totalTokensSaved.toLocaleString()}`);
  lines.push(`  Cost saved:        $${summary.totalCostSaved.toFixed(4)}`);
  lines.push('');

  // Interpretation
  if (summary.avgTokenSaving > 0) {
    lines.push(`  ✓ Commander's optimizations reduced token usage by ${summary.avgTokenSaving.toFixed(1)}% on average.`);
  }
  if (summary.avgQualityChange >= 0 && summary.avgTokenSaving > 0) {
    lines.push('  ✓ Quality maintained or improved while reducing cost — optimizations pay for themselves.');
  }
  if (summary.avgQualityChange < -0.1) {
    lines.push('  ⚠ Quality dropped — some optimizations may be too aggressive for these tasks.');
  }
  lines.push('');

  return lines.join('\n');
}
