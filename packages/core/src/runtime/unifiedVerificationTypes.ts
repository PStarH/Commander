export type TaskType = 'code' | 'search' | 'analysis' | 'creative' | 'structured' | 'general';

export interface VerificationSignal {
  stage: 0 | 1 | 2;
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
}

export const DEFAULT_UVP_CONFIG: UVPConfig = {
  enabled: true,
  confidenceSkipThreshold: 0.85,
  budgetFloorTokens: 2000,
  llmVerificationBudget: 300,
  enableLearning: true,
};

export interface ProvisionIntentScores {
  calculation: number;
  web_search: number;
  file_read: number;
  code_exec: number;
  code_search: number;
}
