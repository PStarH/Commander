export interface TokenUsage {
  input: number;
  output: number;
  total: number;
  cached: number;
  reasoning: number;
}

export interface SamplingOptions {
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  model?: string;
}

export interface LLMClient {
  complete(
    prompt: string,
    options?: SamplingOptions,
  ): Promise<{ text: string; tokens: TokenUsage }>;
}

export interface Task {
  id: string;
  prompt: string;
  expected?: string | RegExp | ((output: string) => boolean);
  judge?: (output: string, ctx: { llm: LLMClient }) => Promise<number>;
  category?: string;
}

export type MetricKey = 'successRate' | 'cost' | 'latency' | 'llmScore';

export interface BenchmarkModule {
  id: string;
  name: string;
  description: string;
  path: string;
  baselineFactory: (ctx: { llm: LLMClient }) => unknown;
  treatmentFactory: (ctx: { llm: LLMClient }) => unknown;
  runTrial: (args: {
    implementation: unknown;
    task: Task;
    llm: LLMClient;
  }) => Promise<{ output: string; tokenUsage: TokenUsage; latencyMs: number }>;
  taskSuite: Task[];
  metrics: MetricKey[];
}

export interface MetricSummary {
  mean: number;
  median: number;
  p95: number;
  stdDev: number;
  raw: number[];
}

export type Conclusion =
  'SIGNIFICANTLY_BETTER' | 'NO_SIGNIFICANT_DIFFERENCE' | 'WORSE_THAN_BASELINE' | 'TEST_UNSTABLE';

export interface ComparisonResult {
  moduleId: string;
  mode: 'scripted' | 'live';
  n: number;
  baseline: MetricSummary;
  treatment: MetricSummary;
  pValues: Record<MetricKey, number>;
  effectSizes: Record<MetricKey, number>;
  conclusion: Conclusion;
  errors: { side: 'baseline' | 'treatment'; taskId: string; message: string }[];
}

export interface ComparisonOptions {
  moduleId: string;
  mode: 'scripted' | 'live';
  n?: number;
  seed?: number;
}
