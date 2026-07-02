/**
 * CrossPollination — 最佳实践前馈引擎
 *
 * 升级 fusionEngine 的能力：从"仅冲突检测"扩展为"冲突检测 + 最佳实践前馈"。
 * 参考 ClawTeam autoresearch 案例的核心机制：leader 监控中间结果，识别最优
 * 配置，并把它广播给后续 agent 作为起点，加速收敛。
 *
 * 设计要点（基于 ClawTeam cross-pollination + LangGraph state broadcasting）：
 * - 提取：从成功 step 的输出中识别"可复用发现"（最优配置/约束/避坑）
 * - 评分：按 step 成本/质量/置信度给 insight 打分
 * - 前馈：把 top-K insights 注入后续 step 的 input（通过 inputTransform 或显式 attach）
 * - 不破坏现有 FusionEngine — 这是新增能力，可独立使用
 */

import type { StepResult } from './orchestrationPatterns';
import type { FusionReport, FusionConflict } from './swarm/types';

// ============================================================================
// Insight 数据模型
// ============================================================================

/**
 * 一条从已完成 step 中提取的可复用发现。
 */
export interface Insight {
  /** 唯一 id */
  id: string;
  /** 来源 step id */
  sourceStepId: string;
  /** 发现类型 */
  kind:
    | 'optimal_config' // 最优配置（如 depth=12, batch=2^17）
    | 'key_constraint' // 关键约束（如 必须先建索引）
    | 'pitfall_avoidance' // 避坑指南（如 不要用 X，会导致 Y）
    | 'best_practice'; // 通用最佳实践
  /** 发现内容（人类可读） */
  content: string;
  /** 结构化数据（如 { depth: 12, batch: 131072 }） */
  structuredData?: Record<string, unknown>;
  /** 置信度 0-1（基于来源 step 的成功率/质量评分） */
  confidence: number;
  /** 来源 step 的 token 消耗（用于成本/收益比评估） */
  sourceTokenCost?: number;
}

/**
 * 提取器函数签名 — 用户可自定义提取逻辑。
 * 默认实现用启发式规则；高级用户可注入 LLM 提取器。
 */
export type InsightExtractor = (result: StepResult) => Insight[] | Promise<Insight[]>;

// ============================================================================
// CrossPollinationEngine
// ============================================================================

/**
 * 前馈引擎 — 维护已积累的 insights，并把它们注入后续 step 的输入。
 */
export class CrossPollinationEngine {
  private insights: Insight[] = [];
  private extractors: InsightExtractor[];

  constructor(extractors?: InsightExtractor[]) {
    this.extractors = extractors ?? [defaultHeuristicExtractor];
  }

  /**
   * 从一个完成的 step 结果中提取 insights 并积累。
   * 仅对 SUCCESS 状态的 step 提取。
   */
  async ingest(result: StepResult): Promise<Insight[]> {
    if (result.status !== 'SUCCESS') return [];
    const all: Insight[] = [];
    for (const extractor of this.extractors) {
      const extracted = await extractor(result);
      all.push(...extracted);
    }
    // 去重：相同 content 已存在则更新 confidence（取更高）
    for (const insight of all) {
      const existing = this.insights.find(
        (i) => i.content === insight.content && i.kind === insight.kind,
      );
      if (existing) {
        existing.confidence = Math.max(existing.confidence, insight.confidence);
        existing.sourceTokenCost = insight.sourceTokenCost ?? existing.sourceTokenCost;
      } else {
        this.insights.push(insight);
      }
    }
    return all;
  }

  /**
   * 批量提取（并行）。
   */
  async ingestMany(results: StepResult[]): Promise<Insight[]> {
    const settled = await Promise.all(
      results.map((r) => this.ingest(r).catch(() => [] as Insight[])),
    );
    return settled.flat();
  }

  /**
   * 获取 top-K insights（按 confidence 降序）。
   */
  getTopInsights(k: number): Insight[] {
    return [...this.insights].sort((a, b) => b.confidence - a.confidence).slice(0, k);
  }

  /**
   * 全部 insights（按提取顺序）。
   */
  getAllInsights(): Insight[] {
    return [...this.insights];
  }

  /**
   * 把当前积累的 insights 注入到给定的 input 中。
   * 约定：input 是对象时附加 `__crossPollination__` 字段；非对象则包装。
   */
  inject(input: unknown, topK = 5): { input: unknown; insights: Insight[] } {
    const top = this.getTopInsights(topK);
    if (top.length === 0) {
      return { input, insights: [] };
    }
    if (input !== null && typeof input === 'object' && !Array.isArray(input)) {
      return {
        input: { ...(input as Record<string, unknown>), __crossPollination__: top },
        insights: top,
      };
    }
    return {
      input: { original: input, __crossPollination__: top },
      insights: top,
    };
  }

  /**
   * 清空积累的 insights（用于新一轮探索前重置）。
   */
  reset(): void {
    this.insights = [];
  }

  /**
   * 当前 insights 数量。
   */
  size(): number {
    return this.insights.length;
  }
}

// ============================================================================
// 默认启发式提取器
// ============================================================================

/**
 * 默认启发式提取器 — 从文本输出中识别常见可复用模式。
 *
 * 不依赖 LLM，零成本。识别的模式：
 * - "best config is X" / "optimal: X" → optimal_config
 * - "must X" / "require X" → key_constraint
 * - "avoid X" / "don't X" / "X fails" → pitfall_avoidance
 * - "recommend X" / "should X" → best_practice
 */
export const defaultHeuristicExtractor: InsightExtractor = (result): Insight[] => {
  const text =
    typeof result.output === 'string' ? result.output : JSON.stringify(result.output ?? '');
  if (!text || text.length < 10) return [];

  const insights: Insight[] = [];
  const baseConfidence = 0.6; // 启发式提取默认置信度

  const patterns: Array<{
    re: RegExp;
    kind: Insight['kind'];
    label: string;
  }> = [
    {
      re: /(?:best|optimal|recommended)\s+(?:config(?:uration)?|setting|value|param(?:eter)?s?)\s*(?:is|=|:)\s*([^\n.]+)/gi,
      kind: 'optimal_config',
      label: 'optimal config',
    },
    {
      re: /(?:must|requires?|needs? to|need to)\s+([^\n.]+)/gi,
      kind: 'key_constraint',
      label: 'constraint',
    },
    {
      re: /(?:avoid|don(?:'?)t|never|fails? if|breaks? when)\s+([^\n.]+)/gi,
      kind: 'pitfall_avoidance',
      label: 'pitfall',
    },
    {
      re: /(?:recommend(?:ed)?|should|best practice)\s+([^\n.]+)/gi,
      kind: 'best_practice',
      label: 'best practice',
    },
  ];

  for (const { re, kind, label } of patterns) {
    const matches = text.matchAll(re);
    for (const m of matches) {
      const content = `${label}: ${m[1].trim()}`;
      insights.push({
        id: `insight-${result.stepId}-${kind}-${insights.length}`,
        sourceStepId: result.stepId,
        kind,
        content,
        confidence: baseConfidence,
        sourceTokenCost: result.tokenUsage?.totalTokens,
      });
    }
  }

  return insights;
};

// ============================================================================
// 融合：CrossPollination + FusionEngine 冲突报告
// ============================================================================

/**
 * 综合报告 — 把冲突检测（防御性）+ insights 前馈（加速收敛）合并。
 * 供 MoA 综合器或后续 step 使用。
 */
export interface CrossPollinationReport {
  /** FusionEngine 检测到的冲突 */
  conflicts: FusionConflict[];
  /** CrossPollinationEngine 提取的 insights */
  insights: Insight[];
  /** 综合建议（人类可读） */
  summary: string;
}

/**
 * 构建综合报告 — 同时考虑冲突与最佳实践。
 */
export function buildCrossPollinationReport(
  fusionReport: FusionReport | undefined,
  insights: Insight[],
): CrossPollinationReport {
  const conflicts = fusionReport?.conflicts ?? [];
  const summary =
    insights.length > 0 || conflicts.length > 0
      ? `${insights.length} insight(s) to propagate; ${conflicts.length} conflict(s) to resolve`
      : 'no insights or conflicts';
  return { conflicts, insights, summary };
}
