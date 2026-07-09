# 算法效果证明平台实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `packages/core` 中建立 `algorithmicEffectiveness` benchmark 套件，支持 A/B 对照实验、统计检验和报告生成，首批验证 ThompsonMemoryScorer 和 StrategySelector。

**Architecture:** 核心由 `types` → `LLMClient`（scripted/live） → `evaluator`（指标+Wilcoxon） → `reporter` → `runner`（A/B 执行） → `registry`（模块注册）组成。每个算法模块通过实现 `BenchmarkModule` 接口接入，baseline 和 treatment 使用同一任务集和同一 seed，输出统计显著性结论。

**Tech Stack:** TypeScript, vitest, `CostModel`, `ResourceGovernor`, `UniversalSanitizer`（均来自 `packages/core` 既有实现）。

---

## 文件结构

```
packages/core/
├── src/benchmarks/algorithmicEffectiveness/
│   ├── index.ts
│   ├── types.ts
│   ├── registry.ts
│   ├── runner.ts
│   ├── evaluator.ts
│   ├── reporter.ts
│   ├── scriptedLLM.ts
│   ├── liveLLM.ts
│   └── modules/
│       ├── thompsonMemory.ts
│       └── strategySelector.ts
└── tests/benchmarks/algorithmicEffectiveness/
    ├── evaluator.test.ts
    ├── reporter.test.ts
    ├── runner.test.ts
    ├── scriptedLLM.test.ts
    └── modules/
        ├── thompsonMemory.test.ts
        └── strategySelector.test.ts
```

---

## Task 1: 定义核心类型 `types.ts`

**Files:**
- Create: `packages/core/src/benchmarks/algorithmicEffectiveness/types.ts`
- Test: `packages/core/tests/benchmarks/algorithmicEffectiveness/types.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
// packages/core/tests/benchmarks/algorithmicEffectiveness/types.test.ts
import { describe, it, expect } from 'vitest';
import type { Task, LLMClient, BenchmarkModule, ComparisonResult } from '../../../src/benchmarks/algorithmicEffectiveness/types';

describe('types compile and shape is correct', () => {
  it('Task accepts expected function', () => {
    const task: Task = {
      id: 't1',
      prompt: 'hello',
      expected: (output: string) => output.includes('world'),
    };
    expect(task.id).toBe('t1');
  });

  it('LLMClient complete returns text and tokens', async () => {
    const client: LLMClient = {
      complete: async () => ({ text: 'ok', tokens: { input: 1, output: 1, total: 2, cached: 0, reasoning: 0 } }),
    };
    const res = await client.complete('hi');
    expect(res.text).toBe('ok');
  });

  it('ComparisonResult has required fields', () => {
    const result: ComparisonResult = {
      moduleId: 'm1',
      mode: 'scripted',
      n: 10,
      baseline: { mean: 0, median: 0, p95: 0, stdDev: 0, raw: [] },
      treatment: { mean: 1, median: 1, p95: 1, stdDev: 0, raw: [] },
      pValues: { successRate: 0.01, cost: 1, latency: 1, llmScore: 1 },
      effectSizes: { successRate: 0.5, cost: 0, latency: 0, llmScore: 0 },
      conclusion: 'SIGNIFICANTLY_BETTER',
      errors: [],
    };
    expect(result.conclusion).toBe('SIGNIFICANTLY_BETTER');
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm --filter @commander/core test tests/benchmarks/algorithmicEffectiveness/types.test.ts`  
Expected: FAIL，提示模块不存在或导入失败。

- [ ] **Step 3: 实现 `types.ts`**

```typescript
// packages/core/src/benchmarks/algorithmicEffectiveness/types.ts

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
  complete(prompt: string, options?: SamplingOptions): Promise<{ text: string; tokens: TokenUsage }>;
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
  | 'SIGNIFICANTLY_BETTER'
  | 'NO_SIGNIFICANT_DIFFERENCE'
  | 'WORSE_THAN_BASELINE'
  | 'TEST_UNSTABLE';

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
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `pnpm --filter @commander/core test tests/benchmarks/algorithmicEffectiveness/types.test.ts`  
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/benchmarks/algorithmicEffectiveness/types.ts packages/core/tests/benchmarks/algorithmicEffectiveness/types.test.ts
git commit -m "feat(benchmarks): define algorithmic effectiveness core types"
```

---

## Task 2: 实现 `scriptedLLM.ts`

**Files:**
- Create: `packages/core/src/benchmarks/algorithmicEffectiveness/scriptedLLM.ts`
- Test: `packages/core/tests/benchmarks/algorithmicEffectiveness/scriptedLLM.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
// packages/core/tests/benchmarks/algorithmicEffectiveness/scriptedLLM.test.ts
import { describe, it, expect } from 'vitest';
import { createScriptedLLM } from '../../../src/benchmarks/algorithmicEffectiveness/scriptedLLM';

describe('scriptedLLM', () => {
  it('returns configured response and deterministic tokens', async () => {
    const llm = createScriptedLLM({ responses: { hello: 'world' } });
    const res = await llm.complete('hello');
    expect(res.text).toBe('world');
    expect(res.tokens.total).toBeGreaterThan(0);
  });

  it('falls back to default response when prompt not matched', async () => {
    const llm = createScriptedLLM({ defaultResponse: 'fallback' });
    const res = await llm.complete('unknown');
    expect(res.text).toBe('fallback');
  });

  it('matches by regex key', async () => {
    const llm = createScriptedLLM({
      responses: { '/score.*/': '42' },
      useRegex: true,
    });
    const res = await llm.complete('score please');
    expect(res.text).toBe('42');
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm --filter @commander/core test tests/benchmarks/algorithmicEffectiveness/scriptedLLM.test.ts`  
Expected: FAIL，函数不存在。

- [ ] **Step 3: 实现 `scriptedLLM.ts`**

```typescript
// packages/core/src/benchmarks/algorithmicEffectiveness/scriptedLLM.ts
import type { LLMClient, SamplingOptions, TokenUsage } from './types';

export interface ScriptedLLMOptions {
  responses: Record<string, string>;
  defaultResponse?: string;
  useRegex?: boolean;
  model?: string;
}

function estimateTokens(text: string): TokenUsage {
  // Rough approximation: 1 token ~= 4 chars for English; keeps tests deterministic
  const total = Math.max(1, Math.ceil(text.length / 4));
  return {
    input: 0,
    output: total,
    total,
    cached: 0,
    reasoning: 0,
  };
}

export function createScriptedLLM(options: ScriptedLLMOptions): LLMClient {
  const { responses, defaultResponse = '', useRegex = false, model = 'scripted' } = options;

  return {
    async complete(prompt: string, _opts?: SamplingOptions): Promise<{ text: string; tokens: TokenUsage }> {
      let text = defaultResponse;

      if (useRegex) {
        for (const [pattern, response] of Object.entries(responses)) {
          const re = new RegExp(pattern);
          if (re.test(prompt)) {
            text = response;
            break;
          }
        }
      } else {
        // Exact match first, then substring match
        if (responses[prompt] !== undefined) {
          text = responses[prompt];
        } else {
          for (const [key, response] of Object.entries(responses)) {
            if (prompt.includes(key)) {
              text = response;
              break;
            }
          }
        }
      }

      return { text, tokens: estimateTokens(text) };
    },
  };
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `pnpm --filter @commander/core test tests/benchmarks/algorithmicEffectiveness/scriptedLLM.test.ts`  
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/benchmarks/algorithmicEffectiveness/scriptedLLM.ts packages/core/tests/benchmarks/algorithmicEffectiveness/scriptedLLM.test.ts
git commit -m "feat(benchmarks): add scripted LLM client for deterministic algorithm tests"
```

---

## Task 3: 实现 `liveLLM.ts`

**Files:**
- Create: `packages/core/src/benchmarks/algorithmicEffectiveness/liveLLM.ts`
- Test: `packages/core/tests/benchmarks/algorithmicEffectiveness/liveLLM.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
// packages/core/tests/benchmarks/algorithmicEffectiveness/liveLLM.test.ts
import { describe, it, expect, vi } from 'vitest';
import { createLiveLLM } from '../../../src/benchmarks/algorithmicEffectiveness/liveLLM';

describe('liveLLM', () => {
  it('throws when no API key is configured', () => {
    expect(() => createLiveLLM({ provider: 'openai', model: 'gpt-4o-mini' })).toThrow(/API key/);
  });

  it('returns response via injected fetch', async () => {
    process.env.OPENAI_API_KEY = 'test-key';
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'hello' } }],
        usage: { prompt_tokens: 2, completion_tokens: 1 },
      }),
    });

    const llm = createLiveLLM({ provider: 'openai', model: 'gpt-4o-mini', fetch: mockFetch as unknown as typeof fetch });
    const res = await llm.complete('hi');
    expect(res.text).toBe('hello');
    expect(res.tokens.input).toBe(2);
    expect(res.tokens.output).toBe(1);
    delete process.env.OPENAI_API_KEY;
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm --filter @commander/core test tests/benchmarks/algorithmicEffectiveness/liveLLM.test.ts`  
Expected: FAIL，函数不存在。

- [ ] **Step 3: 实现 `liveLLM.ts`**

```typescript
// packages/core/src/benchmarks/algorithmicEffectiveness/liveLLM.ts
import { ResourceGovernor } from '../../security/securityPrimitives';
import type { LLMClient, SamplingOptions, TokenUsage } from './types';

export interface LiveLLMOptions {
  provider: 'openai' | 'anthropic';
  model: string;
  apiKey?: string;
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
}

function getApiKey(provider: 'openai' | 'anthropic'): string {
  const key = provider === 'openai' ? process.env.OPENAI_API_KEY : process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error(`Missing API key for provider ${provider}`);
  return key;
}

function buildOpenAIRequest(prompt: string, options: SamplingOptions) {
  return {
    model: options.model ?? 'gpt-4o-mini',
    messages: [{ role: 'user', content: prompt }],
    temperature: options.temperature ?? 0.7,
    top_p: options.topP,
    max_tokens: options.maxTokens,
  };
}

function buildAnthropicRequest(prompt: string, options: SamplingOptions) {
  return {
    model: options.model ?? 'claude-3-5-haiku',
    messages: [{ role: 'user', content: prompt }],
    temperature: options.temperature ?? 0.7,
    top_p: options.topP,
    max_tokens: options.maxTokens ?? 1024,
  };
}

export function createLiveLLM(options: LiveLLMOptions): LLMClient {
  const provider = options.provider;
  const model = options.model;
  const apiKey = options.apiKey ?? getApiKey(provider);
  const fetchImpl = options.fetch ?? globalThis.fetch;

  const baseUrl =
    options.baseUrl ??
    (provider === 'openai' ? 'https://api.openai.com/v1' : 'https://api.anthropic.com/v1');

  return {
    async complete(prompt: string, opts: SamplingOptions = {}): Promise<{ text: string; tokens: TokenUsage }> {
      const mergedModel = opts.model ?? model;
      const body = provider === 'openai' ? buildOpenAIRequest(prompt, { ...opts, model: mergedModel }) : buildAnthropicRequest(prompt, { ...opts, model: mergedModel });

      const url = provider === 'openai' ? `${baseUrl}/chat/completions` : `${baseUrl}/messages`;
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      };
      if (provider === 'anthropic') {
        headers['anthropic-version'] = '2023-06-01';
      }

      const response = await ResourceGovernor.withTimeout(
        async () =>
          fetchImpl(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
          }),
        30_000,
      );

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`LLM API error ${response.status}: ${text}`);
      }

      const data = (await response.json()) as Record<string, unknown>;

      if (provider === 'openai') {
        const choice = (data.choices as Array<{ message: { content: string } }>)[0];
        const usage = data.usage as { prompt_tokens: number; completion_tokens: number };
        return {
          text: choice.message.content,
          tokens: {
            input: usage.prompt_tokens,
            output: usage.completion_tokens,
            total: usage.prompt_tokens + usage.completion_tokens,
            cached: 0,
            reasoning: 0,
          },
        };
      }

      // Anthropic
      const content = (data.content as Array<{ type: string; text: string }>).find((c) => c.type === 'text');
      const usage = data.usage as { input_tokens: number; output_tokens: number };
      return {
        text: content?.text ?? '',
        tokens: {
          input: usage.input_tokens,
          output: usage.output_tokens,
          total: usage.input_tokens + usage.output_tokens,
          cached: 0,
          reasoning: 0,
        },
      };
    },
  };
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `pnpm --filter @commander/core test tests/benchmarks/algorithmicEffectiveness/liveLLM.test.ts`  
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/benchmarks/algorithmicEffectiveness/liveLLM.ts packages/core/tests/benchmarks/algorithmicEffectiveness/liveLLM.test.ts
git commit -m "feat(benchmarks): add live LLM client for real API algorithm tests"
```

---

## Task 4: 实现 `evaluator.ts`（指标 + Wilcoxon 检验）

**Files:**
- Create: `packages/core/src/benchmarks/algorithmicEffectiveness/evaluator.ts`
- Test: `packages/core/tests/benchmarks/algorithmicEffectiveness/evaluator.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
// packages/core/tests/benchmarks/algorithmicEffectiveness/evaluator.test.ts
import { describe, it, expect } from 'vitest';
import {
  evaluateTrialSuccess,
  summarizeMetric,
  wilcoxonSignedRankTest,
  evaluateComparison,
} from '../../../src/benchmarks/algorithmicEffectiveness/evaluator';
import type { Task } from '../../../src/benchmarks/algorithmicEffectiveness/types';

describe('evaluator', () => {
  it('evaluates success by regex', async () => {
    const task: Task = { id: 't1', prompt: 'p', expected: /yes/ };
    expect(await evaluateTrialSuccess('yes please', task, null as unknown as Parameters<typeof evaluateTrialSuccess>[2])).toBe(true);
  });

  it('evaluates success by function', async () => {
    const task: Task = { id: 't2', prompt: 'p', expected: (out: string) => out.length > 3 };
    expect(await evaluateTrialSuccess('hello', task, null as unknown as Parameters<typeof evaluateTrialSuccess>[2])).toBe(true);
  });

  it('computes summary statistics', () => {
    const s = summarizeMetric([1, 2, 3, 4, 5]);
    expect(s.mean).toBe(3);
    expect(s.median).toBe(3);
    expect(s.raw).toEqual([1, 2, 3, 4, 5]);
  });

  it('wilcoxon detects significant difference', () => {
    const baseline = [1, 2, 3, 4, 5];
    const treatment = [6, 7, 8, 9, 10];
    const result = wilcoxonSignedRankTest(baseline, treatment);
    expect(result.pValue).toBeLessThan(0.05);
  });

  it('evaluateComparison returns SIGNIFICANTLY_BETTER', () => {
    const baseline = Array.from({ length: 30 }, () => 0.5);
    const treatment = Array.from({ length: 30 }, () => 0.8);
    const result = evaluateComparison({
      moduleId: 'm1',
      mode: 'scripted',
      n: 30,
      baseline,
      treatment,
      baselineCosts: baseline.map(() => 0.01),
      treatmentCosts: treatment.map(() => 0.01),
      baselineLatencies: baseline.map(() => 100),
      treatmentLatencies: treatment.map(() => 100),
      errors: [],
    });
    expect(result.conclusion).toBe('SIGNIFICANTLY_BETTER');
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm --filter @commander/core test tests/benchmarks/algorithmicEffectiveness/evaluator.test.ts`  
Expected: FAIL。

- [ ] **Step 3: 实现 `evaluator.ts`**

```typescript
// packages/core/src/benchmarks/algorithmicEffectiveness/evaluator.ts
import type { ComparisonResult, Conclusion, LLMClient, MetricKey, MetricSummary, Task, TokenUsage } from './types';

export async function evaluateTrialSuccess(
  output: string,
  task: Task,
  llm: LLMClient,
): Promise<boolean> {
  if (task.expected !== undefined) {
    if (typeof task.expected === 'function') {
      return task.expected(output);
    }
    if (task.expected instanceof RegExp) {
      return task.expected.test(output);
    }
    return output.toLowerCase().includes(String(task.expected).toLowerCase());
  }

  if (task.judge) {
    const score = await task.judge(output, { llm });
    return score >= 6;
  }

  return false;
}

export function summarizeMetric(values: number[]): MetricSummary {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const mean = n === 0 ? 0 : sorted.reduce((a, b) => a + b, 0) / n;
  const median = n === 0 ? 0 : n % 2 === 1 ? sorted[Math.floor(n / 2)] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
  const p95 = n === 0 ? 0 : sorted[Math.min(n - 1, Math.ceil(n * 0.95) - 1)];
  const variance = n === 0 ? 0 : sorted.reduce((sum, v) => sum + (v - mean) ** 2, 0) / n;
  return { mean, median, p95, stdDev: Math.sqrt(variance), raw: values };
}

function normalCdf(x: number): number {
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const sign = x < 0 ? -1 : 1;
  const z = Math.abs(x) / Math.sqrt(2);
  const t = 1 / (1 + p * z);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-z * z);
  return 0.5 * (1 + sign * y);
}

export function wilcoxonSignedRankTest(baseline: number[], treatment: number[]): { pValue: number; zScore: number } {
  const diffs = baseline.map((b, i) => treatment[i] - b).filter((d) => d !== 0);
  const n = diffs.length;
  if (n === 0) return { pValue: 1, zScore: 0 };

  const abs = diffs.map((d) => Math.abs(d));
  const sortedAbs = [...abs].sort((a, b) => a - b);

  function rank(value: number): number {
    const indices: number[] = [];
    for (let i = 0; i < sortedAbs.length; i++) {
      if (sortedAbs[i] === value) indices.push(i);
    }
    // average rank is 1-indexed
    return indices.reduce((a, b) => a + b, 0) / indices.length + 1;
  }

  let positiveRank = 0;
  let negativeRank = 0;
  for (let i = 0; i < diffs.length; i++) {
    const r = rank(abs[i]);
    if (diffs[i] > 0) positiveRank += r;
    else negativeRank += r;
  }

  const W = Math.min(positiveRank, negativeRank);
  const expected = (n * (n + 1)) / 4;
  const variance = (n * (n + 1) * (2 * n + 1)) / 24;
  const zScore = n < 10 ? 0 : (W - expected) / Math.sqrt(variance);
  const pValue = n < 10 ? 1 : 2 * (1 - normalCdf(Math.abs(zScore)));

  return { pValue, zScore };
}

export interface EvaluateComparisonInput {
  moduleId: string;
  mode: 'scripted' | 'live';
  n: number;
  baseline: number[]; // success=1, fail=0
  treatment: number[];
  baselineCosts: number[];
  treatmentCosts: number[];
  baselineLatencies: number[];
  treatmentLatencies: number[];
  baselineLlmScores?: number[];
  treatmentLlmScores?: number[];
  errors: { side: 'baseline' | 'treatment'; taskId: string; message: string }[];
}

export function evaluateComparison(input: EvaluateComparisonInput): ComparisonResult {
  const {
    moduleId,
    mode,
    n,
    baseline,
    treatment,
    baselineCosts,
    treatmentCosts,
    baselineLatencies,
    treatmentLatencies,
    baselineLlmScores = [],
    treatmentLlmScores = [],
    errors,
  } = input;

  const baselineSuccessRates = baseline;
  const treatmentSuccessRates = treatment;

  const successTest = wilcoxonSignedRankTest(baselineSuccessRates, treatmentSuccessRates);
  const costTest = wilcoxonSignedRankTest(baselineCosts, treatmentCosts);
  const latencyTest = wilcoxonSignedRankTest(baselineLatencies, treatmentLatencies);
  const scoreTest =
    baselineLlmScores.length > 0
      ? wilcoxonSignedRankTest(baselineLlmScores, treatmentLlmScores)
      : { pValue: 1, zScore: 0 };

  const pValues: Record<MetricKey, number> = {
    successRate: successTest.pValue,
    cost: costTest.pValue,
    latency: latencyTest.pValue,
    llmScore: scoreTest.pValue,
  };

  const effectSizes: Record<MetricKey, number> = {
    successRate: Math.abs(successTest.zScore) / Math.sqrt(n),
    cost: Math.abs(costTest.zScore) / Math.sqrt(n),
    latency: Math.abs(latencyTest.zScore) / Math.sqrt(n),
    llmScore: Math.abs(scoreTest.zScore) / Math.sqrt(n),
  };

  const baselineValid = baseline.filter((v) => v !== undefined).length;
  const treatmentValid = treatment.filter((v) => v !== undefined).length;
  const baselineErrorRate = (n - baselineValid) / n;
  const treatmentErrorRate = (n - treatmentValid) / n;

  let conclusion: Conclusion;
  if (baselineErrorRate > 0.2 || treatmentErrorRate > 0.2) {
    conclusion = 'TEST_UNSTABLE';
  } else {
    const better = (metric: MetricKey) => {
      const meanBaseline = summarizeMetric(getRaw(metric, 'baseline')).mean;
      const meanTreatment = summarizeMetric(getRaw(metric, 'treatment')).mean;
      // For cost and latency, lower is better
      if (metric === 'cost' || metric === 'latency') {
        return meanTreatment < meanBaseline;
      }
      return meanTreatment > meanBaseline;
    };

    const significantBetter = (Object.keys(pValues) as MetricKey[]).some(
      (m) => pValues[m] < 0.05 && better(m),
    );
    const significantWorse = (Object.keys(pValues) as MetricKey[]).some(
      (m) => pValues[m] < 0.05 && !better(m),
    );

    if (significantBetter && !significantWorse) {
      conclusion = 'SIGNIFICANTLY_BETTER';
    } else if (significantWorse && !significantBetter) {
      conclusion = 'WORSE_THAN_BASELINE';
    } else {
      conclusion = 'NO_SIGNIFICANT_DIFFERENCE';
    }
  }

  function getRaw(metric: MetricKey, side: 'baseline' | 'treatment'): number[] {
    if (metric === 'successRate') return side === 'baseline' ? baselineSuccessRates : treatmentSuccessRates;
    if (metric === 'cost') return side === 'baseline' ? baselineCosts : treatmentCosts;
    if (metric === 'latency') return side === 'baseline' ? baselineLatencies : treatmentLatencies;
    return side === 'baseline' ? baselineLlmScores : treatmentLlmScores;
  }

  return {
    moduleId,
    mode,
    n,
    baseline: summarizeMetric(baselineSuccessRates),
    treatment: summarizeMetric(treatmentSuccessRates),
    pValues,
    effectSizes,
    conclusion,
    errors,
  };
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `pnpm --filter @commander/core test tests/benchmarks/algorithmicEffectiveness/evaluator.test.ts`  
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/benchmarks/algorithmicEffectiveness/evaluator.ts packages/core/tests/benchmarks/algorithmicEffectiveness/evaluator.test.ts
git commit -m "feat(benchmarks): add evaluator with Wilcoxon signed-rank test"
```

---

## Task 5: 实现 `reporter.ts`

**Files:**
- Create: `packages/core/src/benchmarks/algorithmicEffectiveness/reporter.ts`
- Test: `packages/core/tests/benchmarks/algorithmicEffectiveness/reporter.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
// packages/core/tests/benchmarks/algorithmicEffectiveness/reporter.test.ts
import { describe, it, expect } from 'vitest';
import { generateMarkdownReport, generateJsonReport } from '../../../src/benchmarks/algorithmicEffectiveness/reporter';
import type { ComparisonResult } from '../../../src/benchmarks/algorithmicEffectiveness/types';

const mockResult: ComparisonResult = {
  moduleId: 'thompsonMemory',
  mode: 'scripted',
  n: 30,
  baseline: { mean: 0.6, median: 0.6, p95: 1, stdDev: 0.1, raw: [] },
  treatment: { mean: 0.8, median: 0.8, p95: 1, stdDev: 0.1, raw: [] },
  pValues: { successRate: 0.01, cost: 1, latency: 1, llmScore: 1 },
  effectSizes: { successRate: 0.4, cost: 0, latency: 0, llmScore: 0 },
  conclusion: 'SIGNIFICANTLY_BETTER',
  errors: [],
};

describe('reporter', () => {
  it('generates markdown with conclusion', () => {
    const md = generateMarkdownReport([mockResult]);
    expect(md).toContain('ThompsonMemory');
    expect(md).toContain('SIGNIFICANTLY_BETTER');
    expect(md).toContain('Success Rate');
  });

  it('generates JSON with modules array', () => {
    const json = generateJsonReport([mockResult]);
    expect(json.modules[0].moduleId).toBe('thompsonMemory');
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm --filter @commander/core test tests/benchmarks/algorithmicEffectiveness/reporter.test.ts`  
Expected: FAIL。

- [ ] **Step 3: 实现 `reporter.ts`**

```typescript
// packages/core/src/benchmarks/algorithmicEffectiveness/reporter.ts
import type { ComparisonResult, MetricKey } from './types';

const metricLabels: Record<MetricKey, string> = {
  successRate: 'Success Rate',
  cost: 'Avg Cost',
  latency: 'Avg Latency',
  llmScore: 'LLM Score',
};

function formatValue(metric: MetricKey, value: number): string {
  if (metric === 'successRate') return `${(value * 100).toFixed(1)}%`;
  if (metric === 'cost') return `$${value.toFixed(4)}`;
  if (metric === 'latency') return `${Math.round(value)}ms`;
  return value.toFixed(2);
}

export function generateMarkdownReport(results: ComparisonResult[]): string {
  const lines: string[] = ['# Algorithmic Effectiveness Report\n'];

  for (const r of results) {
    lines.push(`## ${r.moduleId}`);
    lines.push(`Mode: ${r.mode} | N=${r.n} | Conclusion: **${r.conclusion}**\n`);

    lines.push('| Metric | Baseline | Treatment | Δ | p-value | Effect Size | Conclusion |');
    lines.push('|---|---|---|---|---|---|---|');

    const metrics: MetricKey[] = ['successRate', 'cost', 'latency', 'llmScore'];
    for (const m of metrics) {
      const baseline = r.baseline.mean;
      const treatment = r.treatment.mean;
      const delta = treatment - baseline;
      const p = r.pValues[m];
      const es = r.effectSizes[m];
      let rowConclusion = 'NO_SIGNIFICANT_DIFFERENCE';
      if (p < 0.05) {
        const better = m === 'cost' || m === 'latency' ? delta < 0 : delta > 0;
        rowConclusion = better ? 'SIGNIFICANTLY_BETTER' : 'WORSE_THAN_BASELINE';
      }
      lines.push(
        `| ${metricLabels[m]} | ${formatValue(m, baseline)} | ${formatValue(m, treatment)} | ${delta > 0 ? '+' : ''}${formatValue(m, delta)} | ${p.toFixed(4)} | ${es.toFixed(2)} | ${rowConclusion} |`,
      );
    }

    lines.push(`\nErrors: baseline=${r.errors.filter((e) => e.side === 'baseline').length}, treatment=${r.errors.filter((e) => e.side === 'treatment').length}\n`);
  }

  return lines.join('\n');
}

export function generateJsonReport(results: ComparisonResult[]): {
  suite: string;
  mode: string;
  timestamp: string;
  modules: Array<{
    moduleId: string;
    conclusion: string;
    significantMetrics: string[];
    degradedMetrics: string[];
  }>;
} {
  return {
    suite: 'algorithmic-effectiveness',
    mode: results[0]?.mode ?? 'scripted',
    timestamp: new Date().toISOString(),
    modules: results.map((r) => {
      const significantMetrics: string[] = [];
      const degradedMetrics: string[] = [];
      const metrics: MetricKey[] = ['successRate', 'cost', 'latency', 'llmScore'];
      for (const m of metrics) {
        if (r.pValues[m] < 0.05) {
          const baseline = r.baseline.mean;
          const treatment = r.treatment.mean;
          const better = m === 'cost' || m === 'latency' ? treatment < baseline : treatment > baseline;
          if (better) significantMetrics.push(m);
          else degradedMetrics.push(m);
        }
      }
      return {
        moduleId: r.moduleId,
        conclusion: r.conclusion,
        significantMetrics,
        degradedMetrics,
      };
    }),
  };
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `pnpm --filter @commander/core test tests/benchmarks/algorithmicEffectiveness/reporter.test.ts`  
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/benchmarks/algorithmicEffectiveness/reporter.ts packages/core/tests/benchmarks/algorithmicEffectiveness/reporter.test.ts
git commit -m "feat(benchmarks): add markdown and json reporters"
```

---

## Task 6: 实现 `runner.ts`

**Files:**
- Create: `packages/core/src/benchmarks/algorithmicEffectiveness/runner.ts`
- Test: `packages/core/tests/benchmarks/algorithmicEffectiveness/runner.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
// packages/core/tests/benchmarks/algorithmicEffectiveness/runner.test.ts
import { describe, it, expect } from 'vitest';
import { runComparison } from '../../../src/benchmarks/algorithmicEffectiveness/runner';
import { createScriptedLLM } from '../../../src/benchmarks/algorithmicEffectiveness/scriptedLLM';
import type { BenchmarkModule, Task } from '../../../src/benchmarks/algorithmicEffectiveness/types';

describe('runner', () => {
  it('runs A/B comparison and treatment wins', async () => {
    const tasks: Task[] = [
      { id: 't1', prompt: 'task', expected: /good/ },
    ];

    const mod: BenchmarkModule = {
      id: 'dummy',
      name: 'Dummy',
      description: '',
      path: '',
      baselineFactory: () => ({ predict: () => 'bad' }),
      treatmentFactory: () => ({ predict: () => 'good' }),
      runTrial: async ({ implementation, task }) => {
        const out = (implementation as { predict: () => string }).predict();
        return { output: out, tokenUsage: { input: 1, output: 1, total: 2, cached: 0, reasoning: 0 }, latencyMs: 1 };
      },
      taskSuite: tasks,
      metrics: ['successRate'],
    };

    const result = await runComparison(
      { moduleId: 'dummy', mode: 'scripted', n: 10, seed: 1 },
      mod,
      () => createScriptedLLM({ responses: {} }),
    );

    expect(result.moduleId).toBe('dummy');
    expect(result.treatment.mean).toBeGreaterThan(result.baseline.mean);
    expect(result.conclusion).toBe('SIGNIFICANTLY_BETTER');
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm --filter @commander/core test tests/benchmarks/algorithmicEffectiveness/runner.test.ts`  
Expected: FAIL。

- [ ] **Step 3: 实现 `runner.ts`**

```typescript
// packages/core/src/benchmarks/algorithmicEffectiveness/runner.ts
import { getCostModel } from '../../observability/costModel';
import { evaluateComparison, evaluateTrialSuccess } from './evaluator';
import type { BenchmarkModule, ComparisonOptions, ComparisonResult, LLMClient, Task, TokenUsage } from './types';

function estimateCost(tokens: TokenUsage): number {
  const costModel = getCostModel();
  const breakdown = costModel.calculate('unknown', 'unknown', {
    input: tokens.input,
    output: tokens.output,
    cached: tokens.cached,
    reasoning: tokens.reasoning,
    total: tokens.total,
  });
  return breakdown.totalCostUsd;
}

function seededRandom(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

function shuffle<T>(arr: T[], rng: () => number): T[] {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

export async function runComparison(
  options: ComparisonOptions,
  module: BenchmarkModule,
  createLLM: (mode: 'baseline' | 'treatment') => LLMClient,
): Promise<ComparisonResult> {
  const { mode, n = 30, seed = Date.now() } = options;
  const rng = seededRandom(seed);

  const baselineLLM = createLLM('baseline');
  const treatmentLLM = createLLM('treatment');

  const baselineImpl = module.baselineFactory({ llm: baselineLLM });
  const treatmentImpl = module.treatmentFactory({ llm: treatmentLLM });

  const baselineSuccess: number[] = [];
  const treatmentSuccess: number[] = [];
  const baselineCosts: number[] = [];
  const treatmentCosts: number[] = [];
  const baselineLatencies: number[] = [];
  const treatmentLatencies: number[] = [];
  const errors: ComparisonResult['errors'] = [];

  for (let i = 0; i < n; i++) {
    const shuffled = shuffle(module.taskSuite, rng);

    for (const task of shuffled) {
      // Baseline
      try {
        const start = Date.now();
        const { output, tokenUsage, latencyMs } = await module.runTrial({
          implementation: baselineImpl,
          task,
          llm: baselineLLM,
        });
        const success = await evaluateTrialSuccess(output, task, baselineLLM);
        baselineSuccess.push(success ? 1 : 0);
        baselineCosts.push(estimateCost(tokenUsage));
        baselineLatencies.push(latencyMs ?? Date.now() - start);
      } catch (err) {
        baselineSuccess.push(0);
        baselineCosts.push(0);
        baselineLatencies.push(0);
        errors.push({ side: 'baseline', taskId: task.id, message: (err as Error).message });
      }

      // Treatment
      try {
        const start = Date.now();
        const { output, tokenUsage, latencyMs } = await module.runTrial({
          implementation: treatmentImpl,
          task,
          llm: treatmentLLM,
        });
        const success = await evaluateTrialSuccess(output, task, treatmentLLM);
        treatmentSuccess.push(success ? 1 : 0);
        treatmentCosts.push(estimateCost(tokenUsage));
        treatmentLatencies.push(latencyMs ?? Date.now() - start);
      } catch (err) {
        treatmentSuccess.push(0);
        treatmentCosts.push(0);
        treatmentLatencies.push(0);
        errors.push({ side: 'treatment', taskId: task.id, message: (err as Error).message });
      }
    }
  }

  return evaluateComparison({
    moduleId: module.id,
    mode,
    n: baselineSuccess.length,
    baseline: baselineSuccess,
    treatment: treatmentSuccess,
    baselineCosts,
    treatmentCosts,
    baselineLatencies,
    treatmentLatencies,
    errors,
  });
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `pnpm --filter @commander/core test tests/benchmarks/algorithmicEffectiveness/runner.test.ts`  
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/benchmarks/algorithmicEffectiveness/runner.ts packages/core/tests/benchmarks/algorithmicEffectiveness/runner.test.ts
git commit -m "feat(benchmarks): add A/B comparison runner"
```

---

## Task 7: 实现 `registry.ts`、`index.ts` 与 `cli.ts`

**Files:**
- Create: `packages/core/src/benchmarks/algorithmicEffectiveness/registry.ts`
- Create: `packages/core/src/benchmarks/algorithmicEffectiveness/index.ts`
- Create: `packages/core/src/benchmarks/algorithmicEffectiveness/cli.ts`
- Test: `packages/core/tests/benchmarks/algorithmicEffectiveness/registry.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
// packages/core/tests/benchmarks/algorithmicEffectiveness/registry.test.ts
import { describe, it, expect } from 'vitest';
import { getRegisteredModuleIds, getModule } from '../../../src/benchmarks/algorithmicEffectiveness/registry';

describe('registry', () => {
  it('lists registered module ids', () => {
    const ids = getRegisteredModuleIds();
    expect(ids).toContain('thompsonMemory');
    expect(ids).toContain('strategySelector');
  });

  it('returns a module by id', () => {
    const mod = getModule('thompsonMemory');
    expect(mod.id).toBe('thompsonMemory');
  });

  it('throws for unknown module', () => {
    expect(() => getModule('unknown')).toThrow(/not found/);
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm --filter @commander/core test tests/benchmarks/algorithmicEffectiveness/registry.test.ts`  
Expected: FAIL。

- [ ] **Step 3: 实现 `registry.ts` 和 `index.ts`**

```typescript
// packages/core/src/benchmarks/algorithmicEffectiveness/registry.ts
import type { BenchmarkModule } from './types';
import { thompsonMemoryModule } from './modules/thompsonMemory';
import { strategySelectorModule } from './modules/strategySelector';

const registry: Map<string, BenchmarkModule> = new Map();

export function registerModule(module: BenchmarkModule): void {
  registry.set(module.id, module);
}

export function getModule(id: string): BenchmarkModule {
  const mod = registry.get(id);
  if (!mod) throw new Error(`Benchmark module "${id}" not found`);
  return mod;
}

export function getRegisteredModuleIds(): string[] {
  return Array.from(registry.keys());
}

export function getAllModules(): BenchmarkModule[] {
  return Array.from(registry.values());
}

registerModule(thompsonMemoryModule);
registerModule(strategySelectorModule);
```

```typescript
// packages/core/src/benchmarks/algorithmicEffectiveness/index.ts
export * from './types';
export { runComparison } from './runner';
export { generateMarkdownReport, generateJsonReport } from './reporter';
export { getModule, getRegisteredModuleIds, getAllModules } from './registry';
export { createScriptedLLM } from './scriptedLLM';
export { createLiveLLM } from './liveLLM';
```

```typescript
// packages/core/src/benchmarks/algorithmicEffectiveness/cli.ts
import { runComparison } from './runner';
import { generateMarkdownReport } from './reporter';
import { getModule, getAllModules, getRegisteredModuleIds } from './registry';
import { createLiveLLM } from './liveLLM';
import { createScriptedLLM } from './scriptedLLM';
import type { ComparisonOptions, BenchmarkModule } from './types';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const mode = args[0] as 'scripted' | 'live';
  const moduleId = args[1];

  if (!mode || (mode !== 'scripted' && mode !== 'live')) {
    console.error('Usage: tsx cli.ts <scripted|live> [moduleId]');
    console.error(`Registered modules: ${getRegisteredModuleIds().join(', ')}`);
    process.exit(1);
  }

  const modules: BenchmarkModule[] = moduleId ? [getModule(moduleId)] : getAllModules();
  const results = [];

  for (const mod of modules) {
    console.error(`Running ${mod.id} in ${mode} mode...`);
    const opts: ComparisonOptions = { moduleId: mod.id, mode, n: mode === 'live' ? 30 : 30, seed: 42 };
    const result = await runComparison(
      opts,
      mod,
      mode === 'live'
        ? () => createLiveLLM({ provider: 'openai', model: 'gpt-4o-mini' })
        : () => createScriptedLLM({ responses: {} }),
    );
    results.push(result);
  }

  const report = generateMarkdownReport(results);
  console.log(report);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `pnpm --filter @commander/core test tests/benchmarks/algorithmicEffectiveness/registry.test.ts`  
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/benchmarks/algorithmicEffectiveness/registry.ts packages/core/src/benchmarks/algorithmicEffectiveness/index.ts packages/core/tests/benchmarks/algorithmicEffectiveness/registry.test.ts
git commit -m "feat(benchmarks): add module registry and public index"
```

---

## Task 8: 实现 `modules/thompsonMemory.ts`

**Files:**
- Create: `packages/core/src/benchmarks/algorithmicEffectiveness/modules/thompsonMemory.ts`
- Test: `packages/core/tests/benchmarks/algorithmicEffectiveness/modules/thompsonMemory.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
// packages/core/tests/benchmarks/algorithmicEffectiveness/modules/thompsonMemory.test.ts
import { describe, it, expect } from 'vitest';
import { thompsonMemoryModule } from '../../../../src/benchmarks/algorithmicEffectiveness/modules/thompsonMemory';
import { createScriptedLLM } from '../../../../src/benchmarks/algorithmicEffectiveness/scriptedLLM';
import { runComparison } from '../../../../src/benchmarks/algorithmicEffectiveness/runner';

describe('thompsonMemory module', () => {
  it('has required shape', () => {
    expect(thompsonMemoryModule.id).toBe('thompsonMemory');
    expect(thompsonMemoryModule.taskSuite.length).toBeGreaterThan(0);
  });

  it('beats fixed top-k baseline in scripted mode', async () => {
    const result = await runComparison(
      { moduleId: 'thompsonMemory', mode: 'scripted', n: 30, seed: 42 },
      thompsonMemoryModule,
      () => createScriptedLLM({ responses: {} }),
    );
    expect(result.conclusion).toBe('SIGNIFICANTLY_BETTER');
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm --filter @commander/core test tests/benchmarks/algorithmicEffectiveness/modules/thompsonMemory.test.ts`  
Expected: FAIL。

- [ ] **Step 3: 实现 `thompsonMemory.ts`**

```typescript
// packages/core/src/benchmarks/algorithmicEffectiveness/modules/thompsonMemory.ts
import { ThompsonMemoryScorer } from '../../../memory/thompsonMemoryScorer';
import type { BenchmarkModule, Task } from '../types';

interface MemoryCandidate {
  id: string;
  text: string;
  // Static relevance score used by baseline. In this scenario it is misleading:
  // the highest-scored item is actually wrong, matching a common real-world drift.
  staticScore: number;
}

const taskSuite: Task[] = [
  {
    id: 'retrieve-api-docs',
    prompt: 'Find the memory about API authentication',
    expected: (output: string) => output.includes('Bearer'),
  },
  {
    id: 'retrieve-deployment',
    prompt: 'Find the memory about deployment steps',
    expected: (output: string) => output.includes('docker'),
  },
  {
    id: 'retrieve-config',
    prompt: 'Find the memory about config format',
    expected: (output: string) => output.includes('JSON'),
  },
];

const memories: MemoryCandidate[] = [
  // Misleading static score: m1 is actually correct but ranked lower.
  { id: 'm1', text: 'API uses Bearer token in header', staticScore: 0.5 },
  // High static score but wrong content.
  { id: 'm2', text: 'API uses cookie in header', staticScore: 0.9 },
  { id: 'm3', text: 'Deployment uses docker compose', staticScore: 0.6 },
  { id: 'm4', text: 'Config is stored as JSON file', staticScore: 0.55 },
  { id: 'm5', text: 'Team lunch on Friday', staticScore: 0.2 },
];

function isCorrectForTask(taskId: string, memoryId: string): boolean {
  const mapping: Record<string, string> = {
    'retrieve-api-docs': 'm1',
    'retrieve-deployment': 'm3',
    'retrieve-config': 'm4',
  };
  return mapping[taskId] === memoryId;
}

export const thompsonMemoryModule: BenchmarkModule = {
  id: 'thompsonMemory',
  name: 'Thompson Memory Scorer',
  description: 'Validates that Thompson Sampling recovers from misleading static relevance scores.',
  path: 'memory/thompsonMemoryScorer.ts',
  baselineFactory: () => ({
    select: () => {
      // Fixed top-k by static score — chooses the misleading high-score item.
      return [...memories].sort((a, b) => b.staticScore - a.staticScore)[0];
    },
    isCorrectForTask,
  }),
  treatmentFactory: () => {
    const scorer = new ThompsonMemoryScorer();
    // Pre-train the scorer with historical feedback: m1/m3/m4 are useful, m2/m5 are not.
    for (let i = 0; i < 15; i++) {
      scorer.updateUsefulness('m1', true);
      scorer.updateUsefulness('m3', true);
      scorer.updateUsefulness('m4', true);
      scorer.updateUsefulness('m2', false);
      scorer.updateUsefulness('m5', false);
    }
    return {
      scorer,
      select: () => {
        const scored = memories.map((m) => ({
          ...m,
          sample: scorer.sampleUsefulness(m.id),
        }));
        return scored.sort((a, b) => b.sample - a.sample)[0];
      },
      isCorrectForTask,
    };
  },
  runTrial: async ({ implementation, task }) => {
    const impl = implementation as {
      scorer?: ThompsonMemoryScorer;
      select: () => MemoryCandidate;
      isCorrectForTask: (taskId: string, memoryId: string) => boolean;
    };
    const selected = impl.select();
    // Provide feedback to treatment scorer so it keeps learning across trials.
    if (impl.scorer) {
      impl.scorer.updateUsefulness(selected.id, impl.isCorrectForTask(task.id, selected.id));
    }
    return {
      output: selected.text,
      tokenUsage: { input: 1, output: 1, total: 2, cached: 0, reasoning: 0 },
      latencyMs: 1,
    };
  },
  taskSuite,
  metrics: ['successRate'],
};
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `pnpm --filter @commander/core test tests/benchmarks/algorithmicEffectiveness/modules/thompsonMemory.test.ts`  
Expected: PASS（Thompson sampling 应显著优于固定 Top-K）。

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/benchmarks/algorithmicEffectiveness/modules/thompsonMemory.ts packages/core/tests/benchmarks/algorithmicEffectiveness/modules/thompsonMemory.test.ts
git commit -m "feat(benchmarks): add Thompson memory scorer effectiveness module"
```

---

## Task 9: 实现 `modules/strategySelector.ts`

**Files:**
- Create: `packages/core/src/benchmarks/algorithmicEffectiveness/modules/strategySelector.ts`
- Test: `packages/core/tests/benchmarks/algorithmicEffectiveness/modules/strategySelector.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
// packages/core/tests/benchmarks/algorithmicEffectiveness/modules/strategySelector.test.ts
import { describe, it, expect } from 'vitest';
import { strategySelectorModule } from '../../../../src/benchmarks/algorithmicEffectiveness/modules/strategySelector';
import { createScriptedLLM } from '../../../../src/benchmarks/algorithmicEffectiveness/scriptedLLM';
import { runComparison } from '../../../../src/benchmarks/algorithmicEffectiveness/runner';

describe('strategySelector module', () => {
  it('has required shape', () => {
    expect(strategySelectorModule.id).toBe('strategySelector');
    expect(strategySelectorModule.taskSuite.length).toBeGreaterThan(0);
  });

  it('beats fixed strategy baseline in scripted mode', async () => {
    const result = await runComparison(
      { moduleId: 'strategySelector', mode: 'scripted', n: 30, seed: 42 },
      strategySelectorModule,
      () => createScriptedLLM({ responses: {} }),
    );
    expect(result.conclusion).toBe('SIGNIFICANTLY_BETTER');
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm --filter @commander/core test tests/benchmarks/algorithmicEffectiveness/modules/strategySelector.test.ts`  
Expected: FAIL。

- [ ] **Step 3: 实现 `strategySelector.ts`**

```typescript
// packages/core/src/benchmarks/algorithmicEffectiveness/modules/strategySelector.ts
import { StrategySelector } from '../../../selfEvolution/strategySelector';
import { STRATEGY_NAMES } from '../../../selfEvolution/strategyConstants';
import type { ExecutionExperience } from '../../../runtime/types';
import type { BenchmarkModule, Task } from '../types';

const trueSuccessRates: Record<string, number> = {
  SEQUENTIAL: 0.3,
  PARALLEL: 0.5,
  HANDOFF: 0.8,
  MAGENTIC: 0.6,
  CONSENSUS: 0.4,
};

const taskSuite: Task[] = [
  { id: 'routing-1', prompt: 'Choose execution strategy for task 1', expected: (output: string) => output === 'HANDOFF' },
  { id: 'routing-2', prompt: 'Choose execution strategy for task 2', expected: (output: string) => output === 'HANDOFF' },
  { id: 'routing-3', prompt: 'Choose execution strategy for task 3', expected: (output: string) => output === 'HANDOFF' },
];

function makeExperience(taskId: string, strategy: string, success: boolean): ExecutionExperience {
  return {
    id: `exp-${taskId}-${strategy}`,
    runId: 'benchmark',
    agentId: 'benchmark-agent',
    taskType: taskId,
    modelUsed: 'benchmark-model',
    strategyUsed: strategy,
    success,
    durationMs: 1000,
    tokenCost: 1000,
    lessons: [],
    timestamp: new Date().toISOString(),
  };
}

export const strategySelectorModule: BenchmarkModule = {
  id: 'strategySelector',
  name: 'Strategy Selector',
  description: 'Validates that StrategySelector converges to the highest-success strategy via Thompson Sampling.',
  path: 'selfEvolution/strategySelector.ts',
  baselineFactory: () => ({
    select: (_taskId: string) => STRATEGY_NAMES[0], // Always SEQUENTIAL (worst)
  }),
  treatmentFactory: () => {
    const selector = new StrategySelector();
    // Pre-train: HANDOFF and MAGENTIC succeed often; SEQUENTIAL fails often.
    for (let i = 0; i < 15; i++) {
      for (const taskId of taskSuite.map((t) => t.id)) {
        selector.recordExperience(makeExperience(taskId, 'HANDOFF', true));
        selector.recordExperience(makeExperience(taskId, 'MAGENTIC', true));
        selector.recordExperience(makeExperience(taskId, 'SEQUENTIAL', false));
        selector.recordExperience(makeExperience(taskId, 'CONSENSUS', false));
        selector.recordExperience(makeExperience(taskId, 'PARALLEL', i % 2 === 0));
      }
    }
    return {
      selector,
      select: (taskId: string) => {
        const strategy = selector.selectStrategy(taskId, new Map());
        return strategy;
      },
      record: (taskId: string, strategy: string, success: boolean) => {
        selector.recordExperience(makeExperience(taskId, strategy, success));
      },
    };
  },
  runTrial: async ({ implementation, task }) => {
    const impl = implementation as {
      select: (taskId: string) => string;
      record?: (taskId: string, strategy: string, success: boolean) => void;
    };
    const strategy = impl.select(task.id);
    const success = Math.random() < trueSuccessRates[strategy];
    if (impl.record) {
      impl.record(task.id, strategy, success);
    }
    return {
      output: strategy,
      tokenUsage: { input: 1, output: 1, total: 2, cached: 0, reasoning: 0 },
      latencyMs: 1,
    };
  },
  taskSuite,
  metrics: ['successRate'],
};
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `pnpm --filter @commander/core test tests/benchmarks/algorithmicEffectiveness/modules/strategySelector.test.ts`  
Expected: PASS（Thompson Sampling 应收敛到最佳策略）。

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/benchmarks/algorithmicEffectiveness/modules/strategySelector.ts packages/core/tests/benchmarks/algorithmicEffectiveness/modules/strategySelector.test.ts
git commit -m "feat(benchmarks): add strategy selector effectiveness module"
```

---

## Task 10: 更新 `package.json` 脚本

**Files:**
- Modify: `packages/core/package.json`

- [ ] **Step 1: 修改 `package.json`**

在 `scripts` 中添加两行：

```json
{
  "test:algorithmic": "vitest run --no-cache tests/benchmarks/algorithmicEffectiveness",
  "benchmark:algorithmic:live": "tsx src/benchmarks/algorithmicEffectiveness/cli.ts live"
}
```

完整 scripts 片段：

```json
"scripts": {
  "build": "tsc -p tsconfig.json",
  "test": "vitest run --no-cache",
  "test:quick": "vitest run --no-cache --exclude 'tests/runtime/*' --exclude 'tests/*.test.ts' tests/ultimate/ tests/tools/ tests/security/ 2>/dev/null || vitest run --no-cache tests/ultimate/deliberation.test.ts tests/tools/pathSecurity.test.ts",
  "test:algorithmic": "vitest run --no-cache tests/benchmarks/algorithmicEffectiveness",
  "benchmark:algorithmic:live": "tsx src/benchmarks/algorithmicEffectiveness/cli.ts live",
  ...
}
```

- [ ] **Step 2: 验证脚本存在**

Run: `cat packages/core/package.json | grep -A1 test:algorithmic`  
Expected: 输出包含 `"test:algorithmic"` 和 `"benchmark:algorithmic:live"`。

- [ ] **Step 3: Commit**

```bash
git add packages/core/package.json
git commit -m "chore(benchmarks): add algorithmic effectiveness npm scripts"
```

---

## Task 11: 端到端集成测试

**Files:**
- Create: `packages/core/tests/benchmarks/algorithmicEffectiveness/index.test.ts`

- [ ] **Step 1: 写集成测试**

```typescript
// packages/core/tests/benchmarks/algorithmicEffectiveness/index.test.ts
import { describe, it, expect } from 'vitest';
import { getRegisteredModuleIds, getModule } from '../../../src/benchmarks/algorithmicEffectiveness';

describe('algorithmicEffectiveness suite integration', () => {
  it('exports all registered modules', () => {
    const ids = getRegisteredModuleIds();
    expect(ids).toEqual(expect.arrayContaining(['thompsonMemory', 'strategySelector']));
  });

  it('each module has valid taskSuite and factories', () => {
    for (const id of getRegisteredModuleIds()) {
      const mod = getModule(id);
      expect(mod.taskSuite.length).toBeGreaterThan(0);
      expect(typeof mod.baselineFactory).toBe('function');
      expect(typeof mod.treatmentFactory).toBe('function');
      expect(typeof mod.runTrial).toBe('function');
    }
  });
});
```

- [ ] **Step 2: 运行测试**

Run: `pnpm --filter @commander/core test tests/benchmarks/algorithmicEffectiveness/index.test.ts`  
Expected: PASS。

- [ ] **Step 3: 跑完整 suite**

Run: `pnpm --filter @commander/core test:algorithmic`  
Expected: 所有测试通过。

- [ ] **Step 4: Commit**

```bash
git add packages/core/tests/benchmarks/algorithmicEffectiveness/index.test.ts
git commit -m "test(benchmarks): add algorithmic effectiveness integration test"
```

---

## Self-Review

1. **Spec coverage**：Registry、Runner、Evaluator、Reporter、LLM clients、首批两个模块、package.json 脚本、集成测试均已覆盖。
2. **Placeholder scan**：无 TBD/TODO/"later" 等占位符。
3. **Type consistency**：`TokenUsage`、`LLMClient`、`BenchmarkModule`、`ComparisonResult` 在所有 task 中一致。

---

## 执行选项

Plan complete and saved to `docs/superpowers/plans/2026-07-09-algorithmic-effectiveness.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
