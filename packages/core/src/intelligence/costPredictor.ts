/**
 * Cost Predictor — Predicts task cost before execution.
 *
 * Used internally by the agent to show cost estimates before running tasks.
 * Users see: "预估 $0.09, 继续?" — they don't call this directly.
 *
 * Uses historical data from MetaLearner + deliberation estimates.
 *
 * Cost calculation: delegates to TokenSentinel.calculateCostBreakdown
 * for per-model real pricing. No more hardcoded $2/M fallback.
 */

import { reportSilentFailure } from '../silentFailureReporter';
import { calculateCostBreakdown } from '../telos/tokenSentinel';
import { getModelRouter } from '../runtime/modelRouter';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ============================================================================
// Types
// ============================================================================

export interface CostEstimate {
  estimatedTokens: number;
  estimatedCostUsd: number;
  estimatedDurationMs: number;
  confidence: number; // 0-1
  breakdown: {
    deliberation: number;
    execution: number;
    synthesis: number;
    qualityGates: number;
  };
  similarTasks: Array<{
    task: string;
    tokens: number;
    cost: number;
    duration: number;
  }>;
}

export interface CostHistory {
  taskType: string;
  effortLevel: string;
  topology: string;
  tokens: number;
  costUsd: number;
  durationMs: number;
  timestamp: string;
  success: boolean;
  modelId?: string;
}

// ============================================================================
// Cost Predictor
// ============================================================================

export class CostPredictor {
  private history: CostHistory[] = [];
  private historyPath: string;
  /** Default model assumption when no modelId is known (predict-time only). */
  private readonly DEFAULT_MODEL_ID = 'gpt-4o-mini';

  constructor(baseDir?: string) {
    this.historyPath = baseDir
      ? `${baseDir}/cost-history.json`
      : '.commander/intelligence/cost-history.json';
    this.loadHistory();
  }

  private loadHistory(): void {
    try {
      if (fs.existsSync(this.historyPath)) {
        this.history = JSON.parse(fs.readFileSync(this.historyPath, 'utf-8'));
      }
    } catch (err) {
      reportSilentFailure(err, 'costPredictor:76');
      /* ignore */
    }
  }

  private saveHistory(): void {
    try {
      fs.mkdirSync(path.dirname(this.historyPath), { recursive: true });
      fs.writeFileSync(this.historyPath, JSON.stringify(this.history.slice(-1000), null, 2));
    } catch (err) {
      reportSilentFailure(err, 'costPredictor:88');
      /* ignore */
    }
  }

  /**
   * Predict cost for a task based on deliberation + history.
   * Cost is computed from the actual modelId via TokenSentinel.calculateCostBreakdown
   * — no more flat $2/M tokens rate.
   */
  predict(params: {
    taskType: string;
    effortLevel: string;
    topology: string;
    estimatedTokens: number;
    estimatedDurationMs: number;
    agentCount: number;
    modelId?: string;
  }): CostEstimate {
    const similar = this.findSimilar(params);

    let estimatedTokens = params.estimatedTokens;
    let estimatedDurationMs = params.estimatedDurationMs;

    if (similar.length >= 3) {
      const avgTokens = similar.reduce((s, t) => s + t.tokens, 0) / similar.length;
      const avgDuration = similar.reduce((s, t) => s + t.durationMs, 0) / similar.length;
      estimatedTokens = Math.round(estimatedTokens * 0.6 + avgTokens * 0.4);
      estimatedDurationMs = Math.round(estimatedDurationMs * 0.6 + avgDuration * 0.4);
    }

    const breakdown = {
      deliberation: Math.round(estimatedTokens * 0.05),
      execution: Math.round(estimatedTokens * 0.7),
      synthesis: Math.round(estimatedTokens * 0.15),
      qualityGates: Math.round(estimatedTokens * 0.1),
    };

    // Use real per-model pricing. Assume input/output split ~70/30 (typical).
    const modelId = params.modelId ?? this.DEFAULT_MODEL_ID;
    const inputShare = Math.round(estimatedTokens * 0.7);
    const outputShare = estimatedTokens - inputShare;
    const costResult = calculateCostBreakdown(modelId, inputShare, outputShare);

    const estimatedCostUsd = costResult.totalUsd;
    const confidence =
      similar.length >= 5 ? 0.9 : similar.length >= 3 ? 0.7 : similar.length >= 1 ? 0.5 : 0.3;

    return {
      estimatedTokens,
      estimatedCostUsd,
      estimatedDurationMs,
      confidence,
      breakdown,
      similarTasks: similar.slice(0, 5).map((t) => ({
        task: t.taskType,
        tokens: t.tokens,
        cost: t.costUsd,
        duration: t.durationMs,
      })),
    };
  }

  record(params: {
    taskType: string;
    effortLevel: string;
    topology: string;
    tokens: number;
    durationMs: number;
    success: boolean;
    modelId?: string;
  }): void {
    let costUsd = 0;
    const modelId = params.modelId ?? this.DEFAULT_MODEL_ID;
    if (getModelRouter().getModel(modelId)) {
      const inputShare = Math.round(params.tokens * 0.7);
      const outputShare = params.tokens - inputShare;
      costUsd = calculateCostBreakdown(modelId, inputShare, outputShare).totalUsd;
    }
    this.history.push({
      ...params,
      costUsd: Math.round(costUsd * 100000) / 100000,
      timestamp: new Date().toISOString(),
    });
    this.saveHistory();
  }

  private findSimilar(params: {
    taskType: string;
    effortLevel: string;
    topology: string;
  }): CostHistory[] {
    return this.history
      .filter(
        (h) =>
          h.taskType === params.taskType ||
          h.effortLevel === params.effortLevel ||
          h.topology === params.topology,
      )
      .sort((a, b) => {
        let scoreA = 0;
        let scoreB = 0;
        if (a.taskType === params.taskType) scoreA += 3;
        if (b.taskType === params.taskType) scoreB += 3;
        if (a.effortLevel === params.effortLevel) scoreA += 2;
        if (b.effortLevel === params.effortLevel) scoreB += 2;
        if (a.topology === params.topology) scoreA += 1;
        if (b.topology === params.topology) scoreB += 1;
        return scoreB - scoreA;
      });
  }

  getSummary(estimate: CostEstimate): string {
    const lines: string[] = [];
    lines.push(`预估 Token: ${estimate.estimatedTokens.toLocaleString()}`);
    lines.push(`预估成本: $${estimate.estimatedCostUsd.toFixed(4)}`);
    lines.push(`预估时间: ${(estimate.estimatedDurationMs / 1000).toFixed(0)}s`);
    lines.push(`置信度: ${(estimate.confidence * 100).toFixed(0)}%`);

    if (estimate.similarTasks.length > 0) {
      lines.push(`\n类似任务参考:`);
      for (const t of estimate.similarTasks.slice(0, 3)) {
        lines.push(
          `  ${t.task}: ${t.tokens.toLocaleString()} tok, $${t.cost.toFixed(4)}, ${(t.duration / 1000).toFixed(0)}s`,
        );
      }
    }

    return lines.join('\n');
  }
}

// ============================================================================
// Singleton
// ============================================================================

let defaultPredictor: CostPredictor | null = null;

export function getCostPredictor(): CostPredictor {
  if (!defaultPredictor) {
    defaultPredictor = new CostPredictor();
  }
  return defaultPredictor;
}
