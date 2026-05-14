/**
 * ReasoningConfig.ts
 * 分层推理配置：fast / verify / extended
 * 参考: Agent Planning and Reasoning: From ReAct to Reflexion 2.0 (2026-04-17)
 */

export enum ReasoningMode {
  /** 简单任务，直接执行（无显式推理） */
  FAST = 'fast',
  /** 标准任务，CoT 验证 */
  VERIFY = 'verify',
  /** 复杂任务，Extended Thinking + 自我质疑 */
  EXTENDED = 'extended',
}

export interface ReasoningThresholds {
  high: number;
  medium: number;
  low: number;
  veryLow: number;
}

export const DEFAULT_CONFIDENCE_THRESHOLDS: ReasoningThresholds = {
  high: 0.85,
  medium: 0.60,
  low: 0.40,
  veryLow: 0.20,
};

export interface ReasoningConfig {
  /** 推理深度模式 */
  mode: ReasoningMode;
  /** 最大推理步骤数 */
  maxSteps: number;
  /** 置信度阈值 */
  confidenceThreshold: number;
  /** 允许自我修正 */
  allowSelfCorrection: boolean;
  /** 存储反思到记忆层 */
  storeReflection: boolean;
  /** 允许探索备选方案 */
  allowAlternatives: boolean;
  /** 推理步骤预算 (token) */
  reasoningBudget?: number;
}

export const DEFAULT_REASONING_CONFIGS: Record<ReasoningMode, Partial<ReasoningConfig>> = {
  [ReasoningMode.FAST]: {
    maxSteps: 1,
    confidenceThreshold: 0.85,
    allowSelfCorrection: false,
    storeReflection: false,
    allowAlternatives: false,
  },
  [ReasoningMode.VERIFY]: {
    maxSteps: 5,
    confidenceThreshold: 0.60,
    allowSelfCorrection: true,
    storeReflection: true,
    allowAlternatives: false,
  },
  [ReasoningMode.EXTENDED]: {
    maxSteps: 15,
    confidenceThreshold: 0.40,
    allowSelfCorrection: true,
    storeReflection: true,
    allowAlternatives: true,
    reasoningBudget: 4096,
  },
};

/** 推理状态 */
export interface ReasoningState {
  phase: 'thinking' | 'acting' | 'observing' | 'reflecting' | 'done';
  thoughts: Thought[];
  confidence: number;
  stepsUsed: number;
  selfCritiques: Critique[];
  alternativesExplored: number;
}

export interface Thought {
  step: number;
  content: string;
  timestamp: number;
  isAlternative?: boolean;
}

export interface Critique {
  step: number;
  content: string;
  confidence: number;
  shouldReconsider: boolean;
}

/** 根据任务复杂度自动选择推理模式 */
export function selectReasoningMode(
  estimatedSteps: number,
  hasBranches: boolean = false,
  dependenciesComplex: boolean = false
): ReasoningMode {
  if (estimatedSteps <= 3) {
    return ReasoningMode.FAST;
  }
  if (estimatedSteps <= 7 && !hasBranches && !dependenciesComplex) {
    return ReasoningMode.VERIFY;
  }
  return ReasoningMode.EXTENDED;
}

/** 根据置信度决定执行策略 */
export function confidenceToAction(
  confidence: number,
  thresholds: ReasoningThresholds = DEFAULT_CONFIDENCE_THRESHOLDS
): 'execute' | 'verify' | 'confirm' | 'refuse' {
  if (confidence >= thresholds.high) return 'execute';
  if (confidence >= thresholds.medium) return 'verify';
  if (confidence >= thresholds.low) return 'confirm';
  return 'refuse';
}

/** 构建完整的推理配置 */
export function buildReasoningConfig(
  mode: ReasoningMode,
  overrides: Partial<ReasoningConfig> = {}
): ReasoningConfig {
  return {
    ...DEFAULT_REASONING_CONFIGS[mode],
    mode,
    ...overrides,
  } as ReasoningConfig;
}