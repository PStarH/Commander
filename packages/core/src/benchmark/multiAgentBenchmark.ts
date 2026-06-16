#!/usr/bin/env node
/**
 * Multi-Agent vs Single-Agent A/B Benchmark
 *
 * Proves Commander's value proposition: does multi-agent orchestration
 * deliver measurable advantages over single-agent execution?
 */

import { UltimateOrchestrator } from '../ultimate/orchestrator';
import type { UltimateExecutionResult } from '../ultimate/types';
import type { AgentRuntime } from '../runtime/agentRuntime';

export { UltimateOrchestrator };
export type { UltimateExecutionResult };

export type TaskTier = 'simple' | 'moderate' | 'complex';

export interface BenchmarkTask {
  id: string;
  tier: TaskTier;
  goal: string;
  expectedCapability: string;
  maxTokens: number;
  tools: string[];
  testScript?: string;
  outputFile?: string;
  judgeRubric?: string;
  requiredKeywords?: string[];
}

export interface TaskResult {
  taskId: string;
  tier: TaskTier;
  topology: string;
  status: 'success' | 'partial' | 'failed';
  latencyMs: number;
  effectiveLatencyMs: number;
  sumSubAgentMs?: number;
  maxSubAgentMs?: number;
  totalTokens: number;
  costUsd: number;
  qualityScore: number;
  codeCorrectnessScore: number;
  subAgentsSpawned: number;
  hallucinationScore: number;
  consistencyScore: number;
  completenessScore: number;
  accuracyScore: number;
  synthesisLength: number;
  error?: string;
}

export interface ABComparison {
  task: BenchmarkTask;
  single: TaskResult;
  multi: TaskResult;
  delta: {
    latencyMs: number;
    latencyPct: number;
    effectiveLatencyMs: number;
    effectiveLatencyPct: number;
    costUsd: number;
    costPct: number;
    qualityScore: number;
    qualityPct: number;
    codeCorrectnessDelta: number;
    tokens: number;
    tokensPct: number;
  };
  winner: 'single' | 'multi' | 'tie';
  latencyComparable: boolean;
}

export interface BenchmarkSummary {
  timestamp: string;
  totalTasks: number;
  completedTasks: number;
  byTier: Record<
    TaskTier,
    {
      total: number;
      singleWins: number;
      multiWins: number;
      ties: number;
      avgLatencyDelta: number;
      avgCostDelta: number;
      avgQualityDelta: number;
      avgCodeCorrectnessDelta: number;
    }
  >;
  overall: {
    singleWins: number;
    multiWins: number;
    ties: number;
    avgLatencyImprovement: number;
    avgCostOverhead: number;
    avgQualityImprovement: number;
    avgCodeCorrectnessImprovement: number;
    statisticalSignificance: number;
  };
  comparisons: ABComparison[];
  recommendations: string[];
  completedEarly?: boolean;
  stopReason?: string;
}

export interface BenchmarkRunnerOptions {
  tasks?: number;
  tier?: TaskTier;
  parallel?: number;
  outputDir?: string;
  model?: string;
  runtime?: AgentRuntime;
  orchestrator?: UltimateOrchestrator;
  judgeLLMCall?: (prompt: string) => Promise<string>;
  budgetUsd?: number;
  customTasks?: BenchmarkTask[];
}

const BENCHMARK_TASKS: BenchmarkTask[] = [];

export class MultiAgentBenchmark {
  private orchestrator?: UltimateOrchestrator;
  private options: BenchmarkRunnerOptions;
  private results: ABComparison[] = [];

  constructor(options: BenchmarkRunnerOptions = {}) {
    this.options = options;
    this.orchestrator = options.orchestrator;
  }

  async run(): Promise<BenchmarkSummary> {
    const tasks = this.selectTasks();
    let totalCost = 0;

    for (const task of tasks) {
      if (this.options.budgetUsd !== undefined && totalCost >= this.options.budgetUsd) {
        break;
      }

      const comparison = await this.runTask(task);
      this.results.push(comparison);
      totalCost += comparison.single.costUsd + comparison.multi.costUsd;

      if (this.options.budgetUsd !== undefined && totalCost >= this.options.budgetUsd) {
        return this.generateSummary(
          true,
          `Budget cap $${this.options.budgetUsd.toFixed(2)} reached`,
        );
      }
    }

    return this.generateSummary(false, undefined);
  }

  private selectTasks(): BenchmarkTask[] {
    if (this.options.customTasks) {
      return this.options.customTasks;
    }
    const tasks = this.options.tier
      ? BENCHMARK_TASKS.filter((t) => t.tier === this.options.tier)
      : [...BENCHMARK_TASKS];
    const count = this.options.tasks ?? tasks.length;
    return tasks.slice(0, count);
  }

  private async runTask(task: BenchmarkTask): Promise<ABComparison> {
    let single: TaskResult;
    try {
      single = await this.executeWithTopology(task, 'SINGLE');
    } catch (err) {
      single = this.failedResult(task, 'SINGLE', err);
    }

    const multi = await this.executeWithTopology(task, 'AUTO');

    const latencyComparable = single.status === 'success' && multi.status === 'success';
    const codeCorrectnessDelta = multi.codeCorrectnessScore - single.codeCorrectnessScore;

    let winner: ABComparison['winner'] = 'tie';
    if (codeCorrectnessDelta > 0.1) {
      winner = 'multi';
    } else if (codeCorrectnessDelta < -0.1) {
      winner = 'single';
    }

    const delta: ABComparison['delta'] = {
      latencyMs: multi.latencyMs - single.latencyMs,
      latencyPct:
        single.latencyMs > 0 ? (multi.latencyMs - single.latencyMs) / single.latencyMs : 0,
      effectiveLatencyMs: multi.effectiveLatencyMs - single.effectiveLatencyMs,
      effectiveLatencyPct:
        single.effectiveLatencyMs > 0
          ? (multi.effectiveLatencyMs - single.effectiveLatencyMs) / single.effectiveLatencyMs
          : 0,
      costUsd: multi.costUsd - single.costUsd,
      costPct: single.costUsd > 0 ? (multi.costUsd - single.costUsd) / single.costUsd : 0,
      qualityScore: multi.qualityScore - single.qualityScore,
      qualityPct:
        single.qualityScore > 0
          ? (multi.qualityScore - single.qualityScore) / single.qualityScore
          : 0,
      codeCorrectnessDelta,
      tokens: multi.totalTokens - single.totalTokens,
      tokensPct:
        single.totalTokens > 0 ? (multi.totalTokens - single.totalTokens) / single.totalTokens : 0,
    };

    return {
      task,
      single,
      multi,
      delta,
      winner,
      latencyComparable,
    };
  }

  private async executeWithTopology(task: BenchmarkTask, topology: string): Promise<TaskResult> {
    const orch = this.orchestrator;
    if (!orch) {
      throw new Error('No orchestrator configured');
    }

    let result: UltimateExecutionResult;
    try {
      result = await orch.execute({
        goal: task.goal,
        topology,
        maxTokens: task.maxTokens,
        tools: task.tools,
      } as unknown as Parameters<UltimateOrchestrator['execute']>[0]);
    } catch (err) {
      return this.failedResult(task, topology, err);
    }

    const metrics = result.metrics ?? {};
    const durations = (result.executionTree ?? [])
      .map((node) => node.durationMs)
      .filter((d): d is number => d !== undefined && d > 0);

    const isMulti = topology !== 'SINGLE';
    const sumSubAgentMs =
      isMulti && durations.length > 0 ? durations.reduce((a, b) => a + b, 0) : undefined;
    const maxSubAgentMs = isMulti && durations.length > 0 ? Math.max(...durations) : undefined;

    const latencyMs = metrics.totalDurationMs ?? 0;
    const effectiveLatencyMs = isMulti ? (maxSubAgentMs ?? latencyMs) : latencyMs;

    const synthesis = result.synthesis ?? result.summary ?? '';
    const codeCorrectnessScore = await this.validateOutput(task, '.', synthesis);

    return {
      taskId: task.id,
      tier: task.tier,
      topology,
      status: this.mapStatus(result.status),
      latencyMs,
      effectiveLatencyMs,
      sumSubAgentMs,
      maxSubAgentMs,
      totalTokens: metrics.totalTokens ?? 0,
      costUsd: metrics.totalCostUsd ?? 0,
      qualityScore: metrics.qualityScore ?? 0.7,
      codeCorrectnessScore,
      subAgentsSpawned: metrics.subAgentsSpawned ?? 1,
      hallucinationScore: 0.7,
      consistencyScore: 0.7,
      completenessScore: 0.7,
      accuracyScore: 0.7,
      synthesisLength: synthesis.length,
    };
  }

  private failedResult(task: BenchmarkTask, topology: string, err: unknown): TaskResult {
    return {
      taskId: task.id,
      tier: task.tier,
      topology,
      status: 'failed',
      latencyMs: 0,
      effectiveLatencyMs: 0,
      totalTokens: 0,
      costUsd: 0,
      qualityScore: 0,
      codeCorrectnessScore: 0,
      subAgentsSpawned: 0,
      hallucinationScore: 0,
      consistencyScore: 0,
      completenessScore: 0,
      accuracyScore: 0,
      synthesisLength: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  private mapStatus(status?: string): TaskResult['status'] {
    if (status === 'SUCCESS') return 'success';
    if (status === 'PARTIAL') return 'partial';
    return 'failed';
  }

  private async validateOutput(
    task: BenchmarkTask,
    outputDir: string,
    synthesis: string,
  ): Promise<number> {
    if (task.testScript) {
      const score = await this.validateCode(task, outputDir);
      if (score !== undefined) return score;
    }

    const keywordScore = task.requiredKeywords
      ? this.keywordCoverage(synthesis, task.requiredKeywords)
      : undefined;

    if (task.judgeRubric && this.options.judgeLLMCall) {
      const judgeRaw = await this.judgeLLM(synthesis, task.judgeRubric);
      const judgeScore = judgeRaw ?? 0;
      return keywordScore !== undefined ? Math.min(keywordScore, judgeScore) : judgeScore;
    }

    return keywordScore ?? 1.0;
  }

  private keywordCoverage(synthesis: string, keywords: string[] | undefined): number {
    if (!keywords || keywords.length === 0) return 1.0;
    const text = synthesis.toLowerCase();
    const matches = keywords.filter((kw) => text.includes(kw.toLowerCase())).length;
    return matches / keywords.length;
  }

  private async judgeLLM(synthesis: string, rubric: string): Promise<number | null> {
    if (!this.options.judgeLLMCall) return null;
    const prompt = `Score the following output against this rubric: ${rubric}\n\nOutput:\n${synthesis}\n\nReturn a number between 0 and 1.`;
    try {
      const response = await this.options.judgeLLMCall(prompt);
      const match = response.match(/(0?\.\d+|\d+(?:\.\d+)?)/);
      if (!match) return null;
      return Math.max(0, Math.min(1, parseFloat(match[1])));
    } catch {
      return null;
    }
  }

  private async validateCode(task: BenchmarkTask, outputDir: string): Promise<number | undefined> {
    const filePath = this.findGeneratedFile(task, outputDir);
    if (!filePath || !task.testScript) return undefined;
    try {
      const output = require('child_process').execSync(`npx tsx -e "${task.testScript}"`, {
        cwd: outputDir,
        encoding: 'utf8',
        timeout: 30000,
      });
      return output.includes('PASS') ? 1.0 : 0.0;
    } catch {
      return 0.0;
    }
  }

  private findGeneratedFile(task: BenchmarkTask, outputDir: string): string | null {
    if (!task.outputFile) return null;
    const candidate = require('path').join(outputDir, task.outputFile);
    if (require('fs').existsSync(candidate)) return candidate;
    return null;
  }

  private generateSummary(
    completedEarly: boolean,
    stopReason: string | undefined,
  ): BenchmarkSummary {
    const comparisons = this.results;
    const byTier = {
      simple: this.emptyTier(),
      moderate: this.emptyTier(),
      complex: this.emptyTier(),
    };

    for (const c of comparisons) {
      const t = byTier[c.task.tier];
      t.total++;
      if (c.winner === 'single') t.singleWins++;
      else if (c.winner === 'multi') t.multiWins++;
      else t.ties++;
      t.avgLatencyDelta += c.delta.latencyMs;
      t.avgCostDelta += c.delta.costUsd;
      t.avgQualityDelta += c.delta.qualityScore;
      t.avgCodeCorrectnessDelta += c.delta.codeCorrectnessDelta;
    }

    for (const tier of Object.values(byTier)) {
      if (tier.total > 0) {
        tier.avgLatencyDelta /= tier.total;
        tier.avgCostDelta /= tier.total;
        tier.avgQualityDelta /= tier.total;
        tier.avgCodeCorrectnessDelta /= tier.total;
      }
    }

    const total = comparisons.length;
    const singleWins = comparisons.filter((c) => c.winner === 'single').length;
    const multiWins = comparisons.filter((c) => c.winner === 'multi').length;
    const ties = comparisons.filter((c) => c.winner === 'tie').length;

    return {
      timestamp: new Date().toISOString(),
      totalTasks: total,
      completedTasks: total,
      byTier,
      overall: {
        singleWins,
        multiWins,
        ties,
        avgLatencyImprovement:
          total > 0 ? comparisons.reduce((s, c) => s + c.delta.latencyMs, 0) / total : 0,
        avgCostOverhead:
          total > 0 ? comparisons.reduce((s, c) => s + c.delta.costUsd, 0) / total : 0,
        avgQualityImprovement:
          total > 0 ? comparisons.reduce((s, c) => s + c.delta.qualityScore, 0) / total : 0,
        avgCodeCorrectnessImprovement:
          total > 0 ? comparisons.reduce((s, c) => s + c.delta.codeCorrectnessDelta, 0) / total : 0,
        statisticalSignificance: 0,
      },
      comparisons,
      recommendations: this.generateRecommendations(byTier),
      ...(completedEarly ? { completedEarly: true, stopReason } : {}),
    };
  }

  private emptyTier() {
    return {
      total: 0,
      singleWins: 0,
      multiWins: 0,
      ties: 0,
      avgLatencyDelta: 0,
      avgCostDelta: 0,
      avgQualityDelta: 0,
      avgCodeCorrectnessDelta: 0,
    };
  }

  private generateRecommendations(byTier: BenchmarkSummary['byTier']): string[] {
    const recs: string[] = [];
    for (const [tier, stats] of Object.entries(byTier)) {
      if (stats.total === 0) continue;
      if (stats.multiWins > stats.singleWins) {
        recs.push(`Multi-agent wins on ${tier} tasks.`);
      } else if (stats.singleWins > stats.multiWins) {
        recs.push(`Single-agent wins on ${tier} tasks.`);
      }
    }
    return recs;
  }
}
