export type TaskType = 'code' | 'search' | 'analysis' | 'creative' | 'structured' | 'general';

import type { LLMProvider } from './types';

export interface VerificationSignal {
  stage: 0 | 1 | 2 | 3;
  source: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  message: string;
  location?: string;
  snippet?: string;
  suggestion?: string;
}

export interface VerificationReport {
  passed: boolean;
  confidence: number;
  signals: VerificationSignal[];
  tokensUsed: number;
  stagesRun: number[];
  taskType: TaskType;
  skipped: boolean;
  skipReason?: string;
  /** Stage 3 judge verdict (only present when judge gate runs) */
  judgeVerdict?: {
    passed: boolean;
    confidence: number;
    reasoning: string;
    evidence: string[];
    modelUsed: string;
  };
}

export interface UVPTaskContext {
  goal: string;
  output: string;
  language?: string;
  schema?: Record<string, unknown>;
  toolsUsed?: string[];
  tokenBudgetRemaining?: number;
  previousFailures?: string[];
}

export interface UVPConfig {
  enabled: boolean;
  confidenceSkipThreshold: number;
  budgetFloorTokens: number;
  llmVerificationBudget: number;
  llmVerificationModel?: string;
  enableLearning: boolean;
  evaluatorProvider?: LLMProvider;
  /** Stage 3: Independent goal judge gate */
  judgeGate?: {
    enabled: boolean;
    /** Confidence below which the judge is triggered (default: 0.85) */
    triggerConfidence: number;
    /** Minimum judge confidence to pass (default: 0.8) */
    passThreshold: number;
    /** Max token budget for the judge call (default: 800) */
    tokenBudget: number;
  };
}

export const DEFAULT_UVP_CONFIG: UVPConfig = {
  enabled: true,
  confidenceSkipThreshold: 0.85,
  budgetFloorTokens: 2000,
  llmVerificationBudget: 300,
  enableLearning: true,
  judgeGate: {
    enabled: true,
    triggerConfidence: 0.85,
    passThreshold: 0.8,
    tokenBudget: 800,
  },
};

export interface ProvisionIntentScores {
  calculation: number;
  web_search: number;
  file_read: number;
  code_exec: number;
  code_search: number;
}
