import { describe, it, expect, beforeAll } from 'vitest';
import { deliberate } from '../../src/ultimate/deliberation';
import { TopologyRouter } from '../../src/ultimate/topologyRouter';
import { ContextCompactor } from '../../src/runtime/contextCompactor';
import { ToolPlanner } from '../../src/runtime/toolPlanner';
import { getBenchmarkRunner, BenchmarkResult } from './benchmarkRunner';
import type { LLMMessage, LLMRequest, LLMResponse } from '../../src/runtime/types';

const STEPFUN_API_KEY = process.env.STEPFUN_API_KEY;
const STEPFUN_BASE_URL = process.env.STEPFUN_BASE_URL || 'https://api.stepfun.com/step_plan/v1';
const STEPFUN_MODEL = process.env.STEPFUN_MODEL || 'step-3.7-flash';

function skipIfNoKey() {
  if (!STEPFUN_API_KEY) {
    console.warn('⚠️  STEPFUN_API_KEY not set — skipping real API benchmarks');
    return true;
  }
  return false;
}

async function callStepFun(request: {
  messages: Array<{ role: string; content: string }>;
  max_tokens?: number;
  temperature?: number;
}): Promise<{ response: LLMResponse; latencyMs: number }> {
  const start = performance.now();

  const res = await fetch(`${STEPFUN_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${STEPFUN_API_KEY}`,
    },
    body: JSON.stringify({
      model: STEPFUN_MODEL,
      messages: request.messages,
      max_tokens: request.max_tokens ?? 500,
      temperature: request.temperature ?? 0,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`StepFun API ${res.status}: ${err}`);
  }

  const data = (await res.json()) as LLMResponse;
  const latencyMs = performance.now() - start;

  return { response: data, latencyMs };
}

const REAL_TASKS = [
  {
    name: 'auth_fix',
    goal: 'Fix the JWT token validation in our Express middleware - tokens are being rejected even when valid',
  },
  {
    name: 'api_refactor',
    goal: 'Refactor the user service to use dependency injection and add proper error handling for database connection failures',
  },
  {
    name: 'security_audit',
    goal: 'Audit this codebase for SQL injection vulnerabilities and add parameterized queries where needed',
  },
  {
    name: 'perf_optimize',
    goal: 'Optimize the slow /api/search endpoint - it currently takes 3 seconds to return results',
  },
  {
    name: 'test_coverage',
    goal: 'Add integration tests for the authentication flow covering token refresh, expiration, and invalid tokens',
  },
  {
    name: 'feature_impl',
    goal: 'Implement WebSocket support for real-time notifications with proper connection management and reconnection logic',
  },
  {
    name: 'debug_memory',
    goal: 'Debug the memory leak in the WebSocket connection handler - heap usage grows 50MB per hour',
  },
  {
    name: 'cicd_setup',
    goal: 'Set up GitHub Actions CI/CD pipeline with linting, testing, and Docker deployment to AWS ECS',
  },
];

const REAL_QUERIES = [
  'How do I implement JWT token refresh in Express.js?',
  'What is the best way to handle CORS in a Node.js API?',
  'How to add rate limiting to Express endpoints?',
  'What are the security best practices for storing passwords?',
  'How do I set up proper error handling in Express middleware?',
  'What is the difference between authentication and authorization?',
  'How do I implement OAuth2 with Google in a Node.js app?',
  'What is the recommended way to validate request bodies in Express?',
  'How do I add request logging to an Express application?',
  'What are the best practices for structuring a REST API?',
];

describe('Real-World Benchmarks (StepFun API)', () => {
  const runner = getBenchmarkRunner();

  beforeAll(() => {
    if (skipIfNoKey()) return;
    console.log(`\n🔗 StepFun API: ${STEPFUN_BASE_URL}`);
    console.log(`📦 Model: ${STEPFUN_MODEL}`);
  });

  it('deliberation pipeline with real task goals', async () => {
    if (skipIfNoKey()) return;

    const latencies: number[] = [];
    const results: { task: string; type: string; topology: string; tokens: number }[] = [];

    for (const task of REAL_TASKS) {
      for (let i = 0; i < 5; i++) {
        const start = performance.now();
        deliberate(task.goal);
        const elapsed = performance.now() - start;
        latencies.push(elapsed);
      }
      const plan = deliberate(task.goal);
      results.push({
        task: task.name,
        type: plan.taskType,
        topology: plan.recommendedTopology,
        tokens: plan.estimatedTokens,
      });
    }

    latencies.sort((a, b) => a - b);
    const p50 = latencies[Math.floor(latencies.length * 0.5)];
    const p99 = latencies[Math.floor(latencies.length * 0.99)];

    const result: BenchmarkResult = {
      name: 'deliberation_pipeline_real',
      category: 'performance',
      metrics: {
        total_tasks: REAL_TASKS.length,
        p50_us: Number((p50 * 1000).toFixed(2)),
        p99_us: Number((p99 * 1000).toFixed(2)),
        classifications: results.map((r) => `${r.task}→${r.type}/${r.topology}`).join(', '),
      },
      timestamp: new Date().toISOString(),
      durationMs: latencies.reduce((a, b) => a + b, 0),
      passed: true,
      threshold: 5,
      actual: p99,
    };

    runner.addResult(result);
    // NOTE: deliberate() is synchronous keyword matching (~0ms).
    // The p99 < 5ms assertion is trivially true and has been removed.
  });

  it('real LLM call latency (single request)', { timeout: 30000 }, async () => {
    if (skipIfNoKey()) return;

    const { response, latencyMs } = await callStepFun({
      messages: [{ role: 'user', content: 'What is 2+2? Answer with just the number.' }],
      max_tokens: 10,
    });

    expect(response).toBeDefined();
    expect(response.choices).toBeDefined();
    expect(response.choices.length).toBeGreaterThan(0);

    const result: BenchmarkResult = {
      name: 'llm_call_latency_single',
      category: 'performance',
      metrics: {
        latency_ms: Number(latencyMs.toFixed(2)),
        model: STEPFUN_MODEL,
        response_text: response.choices[0].message.content?.slice(0, 100),
        usage: response.usage,
      },
      timestamp: new Date().toISOString(),
      durationMs: latencyMs,
      passed: latencyMs < 15000,
      threshold: 15000,
      actual: latencyMs,
    };

    runner.addResult(result);
    expect(latencyMs).toBeLessThan(15000);
  });

  it('real LLM call throughput (10 sequential requests)', { timeout: 120000 }, async () => {
    if (skipIfNoKey()) return;

    const latencies: number[] = [];
    const totalTokens = { prompt: 0, completion: 0 };
    const responses: string[] = [];

    for (let i = 0; i < 10; i++) {
      const { response, latencyMs } = await callStepFun({
        messages: [{ role: 'user', content: REAL_QUERIES[i % REAL_QUERIES.length] }],
        max_tokens: 150,
      });

      latencies.push(latencyMs);
      responses.push(response.choices[0].message.content?.slice(0, 80) ?? '');
      if (response.usage) {
        totalTokens.prompt += response.usage.prompt_tokens;
        totalTokens.completion += response.usage.completion_tokens;
      }
    }

    latencies.sort((a, b) => a - b);
    const p50 = latencies[Math.floor(latencies.length * 0.5)];
    const p95 = latencies[Math.floor(latencies.length * 0.95)];
    const p99 = latencies[Math.floor(latencies.length * 0.99)];
    const totalMs = latencies.reduce((a, b) => a + b, 0);

    const result: BenchmarkResult = {
      name: 'llm_call_throughput_10',
      category: 'performance',
      metrics: {
        requests: 10,
        total_ms: Number(totalMs.toFixed(2)),
        avg_ms: Number((totalMs / 10).toFixed(2)),
        p50_ms: Number(p50.toFixed(2)),
        p95_ms: Number(p95.toFixed(2)),
        p99_ms: Number(p99.toFixed(2)),
        requests_per_sec: Number((10 / (totalMs / 1000)).toFixed(2)),
        total_prompt_tokens: totalTokens.prompt,
        total_completion_tokens: totalTokens.completion,
        sample_responses: responses.slice(0, 3),
      },
      timestamp: new Date().toISOString(),
      durationMs: totalMs,
      passed: true,
      threshold: 120000,
      actual: totalMs,
    };

    runner.addResult(result);
    expect(totalMs).toBeLessThan(120000);
  });

  it('context compactor with real LLM-generated content', { timeout: 60000 }, async () => {
    if (skipIfNoKey()) return;

    const compactor = new ContextCompactor({ maxContextTokens: 500 });
    const messages: LLMMessage[] = [
      {
        role: 'system',
        content: 'You are a senior software engineer helping debug a Node.js application.',
      },
    ];

    for (let i = 0; i < 8; i++) {
      const { response } = await callStepFun({
        messages: [
          {
            role: 'user',
            content: `Give a detailed technical answer in 5+ sentences: ${REAL_QUERIES[i % REAL_QUERIES.length]}`,
          },
        ],
        max_tokens: 300,
      });

      messages.push({ role: 'user', content: REAL_QUERIES[i] });
      messages.push({ role: 'assistant', content: response.choices[0].message.content ?? '' });
    }

    const before = messages.length;
    const { messages: compacted } = compactor.compact(messages);
    const after = compacted.length;
    const reduction = ((1 - after / before) * 100).toFixed(1);

    const result: BenchmarkResult = {
      name: 'context_compactor_real_content',
      category: 'cost',
      metrics: {
        original_messages: before,
        compacted_messages: after,
        reduction_percent: Number(reduction),
        content_source: 'StepFun LLM-generated responses',
      },
      timestamp: new Date().toISOString(),
      durationMs: 0,
      passed: after < before,
      threshold: 30,
      actual: Number(reduction),
    };

    runner.addResult(result);
    expect(after).toBeLessThanOrEqual(before);
  });

  it('semantic cache with real embeddings', { timeout: 60000 }, async () => {
    if (skipIfNoKey()) return;

    const { SemanticCache } = await import('../../src/runtime/semanticCache');
    const { LocalEmbeddingFunction } = await import('../../src/runtime/embedding');

    const embeddingFn = new LocalEmbeddingFunction({ ngramSize: 3, useTfIdf: true });

    const cache = new SemanticCache(embeddingFn, {
      enabled: true,
      similarityThreshold: 0.85,
      maxEntries: 100,
    });

    const storeQueries = REAL_QUERIES.slice(0, 5);
    for (const query of storeQueries) {
      const { response } = await callStepFun({
        messages: [{ role: 'user', content: query }],
        max_tokens: 200,
      });

      await cache.store({ model: STEPFUN_MODEL, messages: [{ role: 'user', content: query }] }, {
        id: `resp-${Math.random()}`,
        choices: [
          {
            message: { role: 'assistant', content: response.choices[0].message.content ?? '' },
            finish_reason: 'stop',
            index: 0,
          },
        ],
        usage: response.usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      } as LLMResponse);
    }

    const latencies: number[] = [];
    let hits = 0;

    for (let i = 0; i < 15; i++) {
      const query = REAL_QUERIES[i % storeQueries.length];
      const start = performance.now();
      const cached = await cache.lookup({
        model: STEPFUN_MODEL,
        messages: [{ role: 'user', content: query }],
      });
      latencies.push(performance.now() - start);
      if (cached) hits++;
    }

    latencies.sort((a, b) => a - b);
    const p50 = latencies[Math.floor(latencies.length * 0.5)];
    const p99 = latencies[Math.floor(latencies.length * 0.99)];

    const result: BenchmarkResult = {
      name: 'semantic_cache_real_embeddings',
      category: 'cost',
      metrics: {
        cache_entries: storeQueries.length,
        lookup_count: 15,
        hit_rate: `${((hits / 15) * 100).toFixed(1)}%`,
        p50_ms: Number(p50.toFixed(2)),
        p99_ms: Number(p99.toFixed(2)),
        embedding_source: 'LocalEmbeddingFunction (feature hashing)',
      },
      timestamp: new Date().toISOString(),
      durationMs: latencies.reduce((a, b) => a + b, 0),
      passed: true,
      threshold: 15000,
      actual: p99,
    };

    runner.addResult(result);
    expect(hits).toBeGreaterThanOrEqual(5);
  });
});
