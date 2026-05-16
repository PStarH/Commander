/**
 * CycleDetector — 工具调用循环检测
 *
 * 检测并中断工具调用中的重复模式，防止无限循环。
 * 基于 OpenClaw 的 loop-detection 设计，但更加智能化：
 * - 检测完全相同的工具调用（相同工具+相同参数）
 * - 检测交替循环模式（A→B→A→B）
 * - 检测缓慢漂移的循环（参数微调的重复）
 * - 提供结构化反馈给模型，让它知道为什么被中断
 */

interface CycleDetectorConfig {
  /** 最大允许的相同连续工具调用次数 (默认: 3) */
  maxConsecutiveSameTool: number;
  /** 检测交替模式的窗口大小 (默认: 6) */
  alternatingPatternWindow: number;
  /** 参数相似度阈值，低于此值视为"相同"调用 (默认: 0.9) */
  paramSimilarityThreshold: number;
  /** 漂移检测：允许参数微调的最大次数 (默认: 5) */
  maxDriftIterations: number;
}

const DEFAULT_CONFIG: CycleDetectorConfig = {
  maxConsecutiveSameTool: 3,
  alternatingPatternWindow: 6,
  paramSimilarityThreshold: 0.9,
  maxDriftIterations: 5,
};

type ToolCallRecord = {
  name: string;
  args: Record<string, unknown>;
  stepNumber: number;
};

export type CycleDetectionResult =
  | { detected: false }
  | {
      detected: true;
      type: 'consecutive' | 'alternating' | 'drift';
      description: string;
      advice: string;
    };

export class CycleDetector {
  private config: CycleDetectorConfig;
  private history: ToolCallRecord[] = [];
  private consecutiveSameToolCount = 0;
  private lastToolName: string | null = null;
  private driftTracker: Map<string, number> = new Map();

  constructor(config?: Partial<CycleDetectorConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 检查新工具调用是否构成循环
   */
  check(toolName: string, args: Record<string, unknown>, stepNumber: number): CycleDetectionResult {
    const record: ToolCallRecord = { name: toolName, args, stepNumber };
    this.history.push(record);

    // 保持历史记录在合理范围
    if (this.history.length > this.config.alternatingPatternWindow * 3) {
      this.history = this.history.slice(-this.config.alternatingPatternWindow * 3);
    }

    // 1. 检测连续相同工具调用
    const consecutive = this.detectConsecutive(toolName);
    if (consecutive.detected) return consecutive;

    // 2. 检测交替模式 (A→B→A→B)
    const alternating = this.detectAlternating();
    if (alternating.detected) return alternating;

    // 3. 检测参数漂移循环
    const drift = this.detectDrift(toolName, args);
    if (drift.detected) return drift;

    return { detected: false };
  }

  /**
   * 重置检测器状态（用于新任务）
   */
  reset(): void {
    this.history = [];
    this.consecutiveSameToolCount = 0;
    this.lastToolName = null;
    this.driftTracker.clear();
  }

  private detectConsecutive(toolName: string): CycleDetectionResult {
    if (toolName === this.lastToolName) {
      this.consecutiveSameToolCount++;
    } else {
      this.consecutiveSameToolCount = 1;
      this.lastToolName = toolName;
    }

    if (this.consecutiveSameToolCount >= this.config.maxConsecutiveSameTool) {
      return {
        detected: true,
        type: 'consecutive',
        description: `Same tool "${toolName}" called ${this.consecutiveSameToolCount} times consecutively`,
        advice: `The tool "${toolName}" was called repeatedly with similar arguments. Consider: (1) checking if previous results were actually used, (2) changing approach, (3) verifying arguments are different each time.`,
      };
    }

    return { detected: false };
  }

  private detectAlternating(): CycleDetectionResult {
    const window = this.config.alternatingPatternWindow;
    if (this.history.length < window) return { detected: false };

    const recent = this.history.slice(-window);
    const toolNames = recent.map(r => r.name);

    // 检查 A→B→A→B 模式
    if (toolNames.length >= 4) {
      const evenTools = toolNames.filter((_, i) => i % 2 === 0);
      const oddTools = toolNames.filter((_, i) => i % 2 === 1);

      const evenSame = evenTools.every(t => t === evenTools[0]);
      const oddSame = oddTools.every(t => t === oddTools[0]);

      if (evenSame && oddSame && evenTools[0] !== oddTools[0]) {
        return {
          detected: true,
          type: 'alternating',
          description: `Alternating pattern detected: "${evenTools[0]}" ↔ "${oddTools[0]}"`,
          advice: `Tools are alternating in a fixed pattern. This usually means the agent is stuck in a retry loop. Try combining both operations into a single call, or re-examine the overall approach.`,
        };
      }
    }

    return { detected: false };
  }

  private detectDrift(toolName: string, args: Record<string, unknown>): CycleDetectionResult {
    const key = `${toolName}:${JSON.stringify(arguments)}`;
    const count = (this.driftTracker.get(key) ?? 0) + 1;
    this.driftTracker.set(key, count);

    // 清理与当前调用差异太大的旧记录
    for (const [existingKey] of this.driftTracker) {
      if (existingKey !== key) {
        const existingCount = this.driftTracker.get(existingKey) ?? 0;
        if (existingCount < 2) {
          this.driftTracker.delete(existingKey);
        }
      }
    }

    // 如果同一个调用多次出现但参数微变
    if (count >= this.config.maxDriftIterations) {
      return {
        detected: true,
        type: 'drift',
        description: `Tool "${toolName}" called ${count} times with similar but slightly different arguments`,
        advice: `The model is making small adjustments to the same tool call repeatedly. This suggests convergence issues. Consider: (1) using a different strategy entirely, (2) examining intermediate results more carefully before retrying.`,
      };
    }

    return { detected: false };
  }

  /**
   * 获取调试信息
   */
  getDebugInfo() {
    return {
      historyLength: this.history.length,
      consecutiveSameToolCount: this.consecutiveSameToolCount,
      lastToolName: this.lastToolName,
      driftEntries: Object.fromEntries(this.driftTracker),
    };
  }
}