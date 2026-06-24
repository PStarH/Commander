#!/usr/bin/env tsx
/**
 * scripts/benchmark-topology.ts — Benchmark all 10 orchestration topologies.
 *
 * Measures end-to-end latency, token consumption, and failure rate for every
 * topology pattern against a live LLM provider (OpenAI-compatible API).
 *
 * Topology patterns simulated:
 *
 *   SINGLE              1 completion                              cost×1.0
 *   SEQUENTIAL          3 serial, each gets prior context         cost×1.1
 *   PARALLEL            3 parallel + aggregation                  cost×2.0
 *   HIERARCHICAL        1 planner → 3 workers + synthesis         cost×3.0
 *   HYBRID              2 parallel chains of 2 serial each + merge cost×4.0
 *   DEBATE              3 parallel + judge                        cost×3.5
 *   ENSEMBLE            3 parallel (diff prompts) + vote          cost×3.0
 *   EVALUATOR_OPTIMIZER 1 gen → 1 eval → 1 refine                 cost×2.5
 *   HANDOFF             3 serial with full context handoff        cost×2.0
 *   CONSENSUS           3 rounds × 3 agents, shared context       cost×3.5
 *
 * Usage:
 *   OPENAI_API_KEY=sk-... npx tsx scripts/benchmark-topology.ts
 *   OPENAI_API_KEY=sk-... npx tsx scripts/benchmark-topology.ts --topology=hybrid --iterations=10
 *   OPENAI_API_KEY=sk-... npx tsx scripts/benchmark-topology.ts --topology=all --iterations=10 --output=report.json
 *   # True parallelism (requires high rate-limit provider)
 *   OPENAI_API_KEY=sk-... npx tsx scripts/benchmark-topology.ts --delay=0 --iterations=10
 *   # Multi-provider comparison (run once per provider, then compare reports)
 *   OPENAI_BASE_URL=https://api.anthropic.com/v1 OPENAI_API_KEY=... npx tsx scripts/benchmark-topology.ts --model=claude-3-5-sonnet --output=anthropic.json
 *   OPENAI_BASE_URL=https://api.openai.com/v1 OPENAI_API_KEY=... npx tsx scripts/benchmark-topology.ts --model=gpt-4o --output=openai.json
 *
 * Exit codes:
 *   0   All iterations completed (some failures allowed)
 *   1   All iterations failed (provider unreachable or auth error)
 *   2   Configuration error
 */
import { reportSilentFailure } from '../packages/core/src/silentFailureReporter';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { getGlobalLearnedWeights } from '../packages/core/src/ultimate/topologyStores';
import type { OrchestrationTopology } from '../packages/core/src/ultimate/types';

// ─── Configuration ──────────────────────────────────────────────────────────

const DEFAULT_MODEL = 'gpt-4o';
const DEFAULT_ITERATIONS = 10;
const DEFAULT_TOPOLOGY = 'all';
const DEFAULT_DELAY_MS = 3500;
// When delay is 0, parallel topologies run with true concurrency. This requires
// a provider with generous rate limits; on free tiers you will hit 429s.         // ~17 RPM — avoids StepFun rate limits
const DEFAULT_RPM = 20;
const MAX_429_RETRIES = 3;
const SYSTEM_DEFAULT =
  'You are a precise, concise engineering assistant. Respond in 2-4 sentences.';
const SYSTEM_EXPERT =
  'You are a senior software architect. Provide detailed, technically precise answers.';
const SYSTEM_CREATIVE =
  'You are an innovative thinker who approaches problems from unusual angles. Be creative but rigorous.';
const SYSTEM_CRITIC =
  'You are a critical reviewer. Identify flaws, gaps, and improvement opportunities in the provided answer.';

const BENCHMARK_TASKS = [
  // ── Coding / Implementation ──
  'Write a Python function that merges overlapping intervals. Input: [(1,3),(2,6),(8,10),(15,18)]. Return sorted merged list.',
  'Implement a rate limiter class in TypeScript with sliding window. Support configurable max requests per windowMs.',
  'Write a SQL query to find the top 3 products by revenue per category. Schema: products(id,name,category_id), order_items(product_id,quantity,price_usd).',
  'Given a nested object {a:{b:{c:1,d:2},e:3},f:4}, write a function deepFlatten that returns {"a.b.c":1,"a.b.d":2,"a.e":3,"f":4}.',
  'Implement a PromiseQueue class with concurrency limit. Tasks added via add(fn) run with at most N concurrent promises.',
  // ── Security / Audit ──
  'Audit this Express.js snippet for vulnerabilities: app.post("/login", (req,res) => { const q = `SELECT * FROM users WHERE email="${req.body.email}"`; db.query(q, (err,rows) => {...}); }). List every issue.',
  'A company stores passwords as SHA-256 hashes without salt. Explain why this is compromised and what they should use instead.',
  "You find this CSP header: default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.example.com; object-src 'none'. What attacks can still execute?",
  // ── Creative / Writing ──
  'Write a 4-line product description for a SaaS that turns Slack messages into Jira tickets. Target: engineering managers. Tone: playful but professional.',
  'Brainstorm 5 name ideas for a developer tool that catches staging-vs-production config drift. Explain the reasoning behind each.',
  'Argue both sides: should a startup build their own analytics pipeline or buy Mixpanel/Amplitude? Give 2 points each, then a verdict.',
  // ── Math / Logic / Reasoning ──
  'You have 9 identical-looking balls, one heavier. Find it in exactly 2 weighings on a balance scale. Describe the decision tree.',
  'A train leaves Station A at 60 mph toward Station B 200 miles away. Another train leaves Station B at 40 mph toward Station A. They start at the same time. A bird flies 80 mph back and forth between them until they meet. How far does the bird travel?',
  'A software team completes 8 story points per sprint. Their backlog has 120 story points. In sprint 4 they will add a new feature estimated at 18 SP. In what sprint will they finish the original backlog?',
  // ── Planning / Strategy ──
  'Outline a 5-step migration plan from a monolith Node.js app to microservices. Consider: data consistency, deployment order, testing strategy, rollback.',
  'Your SaaS has 2 DB tables: users(50M rows) and orders(200M rows). Queries on orders by user_id are slow. Design the indexing strategy.',
  // ── Debugging / Troubleshooting ──
  'A Next.js app loads fine in dev but returns 502 in production after deployment. No errors in logs. Systematic debug steps to find the root cause.',
  'A React component re-renders 200 times on mount. The parent uses useContext and passes a new object every render. Diagnose and fix.',
  'PostgreSQL query that ran in 200ms yesterday now takes 30s. Nothing was deployed. List every possible cause in priority order, from most to least likely.',
  // ── Architecture / Design ──
  'Design a URL shortener: generate, store, redirect, track clicks. 100M entries. Handle redirect in <10ms. 10k writes/sec.',
  'Design a distributed rate counter for a Black Friday sale. 1M concurrent users. Must be within 1% accuracy. Failover and burst handling.',
  'You need to serve real-time chat across 3 regions with <200ms P99 latency. Compare architectures: CRDT vs operational transform vs central relay.',
  // ── Code Review ──
  'Review this TypeScript: function get<T>(obj: any, path: string): T { return path.split(".").reduce((a,k) => a?.[k], obj) as T; } List type safety issues and the runtime bug.',
  'This Python function returns wrong results 5% of the time: def dedup(items): return list(set(items)). Items are dicts. Fix it and explain why this was broken.',
  // ── Factual / Explanation (varied domains) ──
  'Explain the difference between optimistic and pessimistic concurrency control. When would you pick each in a financial trading system?',
  'Describe the Linux OOM killer behavior. What determines which process gets killed? Can you influence it from userspace?',
  'How does gRPC bidirectional streaming work under the hood? HTTP/2 framing, flow control, and the lifecycle of a stream.',
  'Compare LSM-Tree (LevelDB/RocksDB) vs B+Tree (SQLite/InnoDB). Write amplification, read amplification, space amplification.',
  'How do CSS containment (contain: layout style paint) and content-visibility: auto improve rendering performance? Explain the rendering pipeline stages they skip.',
  // ── Prompt / LLM-specific ──
  'You need to extract structured data (date, amount, vendor, category) from receipt images using an LLM. Design the prompt template, handling OCR errors, multi-currency, and missing fields. Include few-shot examples.',
  'Compare chain-of-thought vs tree-of-thoughts prompting. For what task types does each excel? What are the token overhead costs?',
];

const MODEL_PRICING = {
  'gpt-4o': { input: 2.5, output: 10.0 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gpt-4-turbo': { input: 10.0, output: 30.0 },
  'gpt-3.5-turbo': { input: 0.5, output: 1.5 },
  'deepseek-chat': { input: 0.27, output: 1.1 },
  'deepseek-reasoner': { input: 0.55, output: 2.19 },
  'claude-3-5-sonnet-20241022': { input: 3.0, output: 15.0 },
  'claude-3-haiku-20240307': { input: 0.25, output: 1.25 },
  'step-3.7-flash': { input: 0.5, output: 2.0 },
};

const TOPO_CFG = {
  single: { c: 1.0, exp: '<5s' },
  sequential: { c: 1.1, exp: '10-30s' },
  parallel: { c: 2.0, exp: '15-45s' },
  hierarchical: { c: 3.0, exp: '30-120s' },
  hybrid: { c: 4.0, exp: '1-5min' },
  debate: { c: 3.5, exp: '30-90s' },
  ensemble: { c: 3.0, exp: '20-60s' },
  evaluator_optimizer: { c: 2.5, exp: '30-120s' },
  handoff: { c: 2.0, exp: '10-30s' },
  consensus: { c: 3.5, exp: '20-60s' },
};

type TopologyName = keyof typeof TOPO_CFG | 'all';
const TOPO_ORDER: TopologyName[] = [
  'single',
  'sequential',
  'parallel',
  'hierarchical',
  'hybrid',
  'debate',
  'ensemble',
  'evaluator_optimizer',
  'handoff',
  'consensus',
];

// ─── Types ──────────────────────────────────────────────────────────────────

interface CallResult {
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  success: boolean;
  error?: string;
}

interface AgentResult extends CallResult {
  agentIndex: number;
  phase: string;
}

interface RunResult {
  iteration: number;
  task: string;
  topology: string;
  agents: AgentResult[];
  wallClockMs: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  success: boolean;
  error?: string;
}

interface SummaryStats {
  topology: string;
  costMult: number;
  expectedLatency: string;
  totalRuns: number;
  successes: number;
  failures: number;
  failureRate: number;
  latencyMs: Record<string, number>;
  tokPerRun: number;
  tokInAvg: number;
  tokOutAvg: number;
  estCostUsd: number;
  callsPerRun: number;
}

interface Report {
  config: { model: string; provider: string; iterations: number; timestamp: string };
  connectivity: { ok: boolean; latencyMs: number };
  results: RunResult[];
  summary: Record<string, SummaryStats>;
  ranking: Array<{ topology: string; latencyAvg: number; costPer100: number; callsPerRun: number }>;
  commanderOverheadMs?: number;
  commanderTopology?: string;
}

// ─── Rate Limiter ────────────────────────────────────────────────────────────

let _rlDelayMs = DEFAULT_DELAY_MS;
let _rlLastTs = 0;
let _rlChain = Promise.resolve();

async function throttle(): Promise<void> {
  const prev = _rlChain;
  let release: () => void;
  _rlChain = new Promise<void>((r) => {
    release = r;
  });
  await prev;
  const now = Date.now();
  const elapsed = now - _rlLastTs;
  if (elapsed < _rlDelayMs) {
    await new Promise((r) => setTimeout(r, _rlDelayMs - elapsed));
  }
  _rlLastTs = Date.now();
  release!();
}

// ─── LLM Call ───────────────────────────────────────────────────────────────

async function callAPI(
  baseUrl: string,
  key: string,
  model: string,
  sys: string,
  user: string,
  signal?: AbortSignal,
): Promise<CallResult> {
  await throttle();
  const t0 = performance.now();
  let lastErr = '';
  for (let attempt = 0; attempt <= MAX_429_RETRIES; attempt++) {
    if (attempt > 0) {
      const backoff = Math.min(2000 * attempt, 10_000);
      await new Promise((r) => setTimeout(r, backoff));
      _rlLastTs = 0; // reset throttle after backoff
      await throttle();
    }
    try {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: sys },
            { role: 'user', content: user },
          ],
          max_tokens: 512,
          temperature: 0.3,
        }),
        signal,
      });
      const ms = Math.round(performance.now() - t0);
      if (!res.ok) {
        const b = await res.text().catch(() => '');
        const errMsg = `HTTP ${res.status}: ${b.slice(0, 200)}`;
        if (res.status === 429 && attempt < MAX_429_RETRIES) {
          lastErr = errMsg;
          continue;
        }
        return { latencyMs: ms, inputTokens: 0, outputTokens: 0, success: false, error: errMsg };
      }
      const d = await res.json();
      return {
        latencyMs: ms,
        inputTokens: d.usage?.prompt_tokens ?? 0,
        outputTokens: d.usage?.completion_tokens ?? 0,
        success: true,
      };
    } catch (e) {
      lastErr = (e as Error).message;
      if (attempt < MAX_429_RETRIES) continue;
      return {
        latencyMs: Math.round(performance.now() - t0),
        inputTokens: 0,
        outputTokens: 0,
        success: false,
        error: lastErr,
      };
    }
  }
  return {
    latencyMs: Math.round(performance.now() - t0),
    inputTokens: 0,
    outputTokens: 0,
    success: false,
    error: lastErr,
  };
}

// ─── Topology Runners ───────────────────────────────────────────────────────

type Runner = (ctx: {
  baseUrl: string;
  key: string;
  model: string;
  iter: number;
  task: string;
}) => Promise<RunResult>;

const RUNNERS: Record<string, Runner> = {};

RUNNERS.single = async (ctx) => {
  const r = await callAPI(ctx.baseUrl, ctx.key, ctx.model, SYSTEM_DEFAULT, ctx.task);
  return {
    iteration: ctx.iter,
    task: ctx.task,
    topology: 'single',
    agents: [{ agentIndex: 1, phase: 'call', ...r }],
    wallClockMs: r.latencyMs,
    totalInputTokens: r.inputTokens,
    totalOutputTokens: r.outputTokens,
    success: r.success,
    error: r.error,
  };
};

RUNNERS.sequential = async (ctx) => {
  const agents: AgentResult[] = [];
  let prev = '';
  for (let i = 0; i < 3; i++) {
    const p = i === 0 ? ctx.task : `${ctx.task}\n\nPrior: ${prev}\nAdd new insights.`;
    const r = await callAPI(ctx.baseUrl, ctx.key, ctx.model, SYSTEM_DEFAULT, p);
    agents.push({ agentIndex: i + 1, phase: `step${i + 1}`, ...r });
    if (!r.success) break;
    prev = `step${i + 1} done`;
  }
  const ok = agents.filter((a) => a.success);
  return {
    iteration: ctx.iter,
    task: ctx.task,
    topology: 'sequential',
    agents,
    wallClockMs: agents.reduce((s, a) => s + a.latencyMs, 0),
    totalInputTokens: ok.reduce((s, a) => s + a.inputTokens, 0),
    totalOutputTokens: ok.reduce((s, a) => s + a.outputTokens, 0),
    success: agents.every((a) => a.success),
    error: agents.find((a) => !a.success)?.error,
  };
};

RUNNERS.parallel = async (ctx) => {
  const N = 3;
  const agents: AgentResult[] = [];
  const results = await Promise.all(
    Array.from({ length: N }, (_, i) =>
      callAPI(ctx.baseUrl, ctx.key, ctx.model, SYSTEM_DEFAULT, ctx.task).then(
        (r) => ({ agentIndex: i + 1, phase: 'worker', ...r }) as AgentResult,
      ),
    ),
  );
  agents.push(...results);
  const ok = results.filter((r) => r.success);
  if (ok.length === N) {
    const agg = await callAPI(
      ctx.baseUrl,
      ctx.key,
      ctx.model,
      'You are a synthesis expert. Combine multiple answers into one.',
      `Question: "${ctx.task}"\n\nUnify the ${N} answers into a best response.`,
    );
    agents.push({ agentIndex: 0, phase: 'merge', ...agg });
  }
  const wallMs =
    Math.max(...results.map((r) => r.latencyMs)) +
    (agents.find((a) => a.phase === 'merge')?.latencyMs ?? 0);
  return {
    iteration: ctx.iter,
    task: ctx.task,
    topology: 'parallel',
    agents,
    wallClockMs: wallMs,
    totalInputTokens: agents.filter((a) => a.success).reduce((s, a) => s + a.inputTokens, 0),
    totalOutputTokens: agents.filter((a) => a.success).reduce((s, a) => s + a.outputTokens, 0),
    success: agents.every((a) => a.success),
  };
};

RUNNERS.hierarchical = async (ctx) => {
  const agents: AgentResult[] = [];
  const plan = await callAPI(
    ctx.baseUrl,
    ctx.key,
    ctx.model,
    'Decompose this task into 3 independent sub-tasks.',
    `Decompose into 3 sub-tasks:\n${ctx.task}`,
  );
  agents.push({ agentIndex: 0, phase: 'planner', ...plan });
  if (!plan.success) return buildFail('hierarchical', ctx, agents, plan);

  const workers = await Promise.all(
    Array.from({ length: 3 }, (_, i) =>
      callAPI(
        ctx.baseUrl,
        ctx.key,
        ctx.model,
        SYSTEM_EXPERT,
        `Sub-task ${i + 1} of: "${ctx.task}"\nResearch and provide findings.`,
      ).then((r) => ({ agentIndex: i + 1, phase: 'worker', ...r }) as AgentResult),
    ),
  );
  agents.push(...workers);
  const okW = workers.filter((w) => w.success);

  const syn = await callAPI(
    ctx.baseUrl,
    ctx.key,
    ctx.model,
    'Synthesis expert. Merge sub-task findings into one answer.',
    `Task: "${ctx.task}"\n\nMerge ${okW.length} worker findings.`,
  );
  agents.push({ agentIndex: 0, phase: 'synthesis', ...syn });

  return {
    ...buildFail('hierarchical', ctx, agents),
    wallClockMs: plan.latencyMs + Math.max(...workers.map((w) => w.latencyMs)) + syn.latencyMs,
    success: agents.every((a) => a.success),
  };
};

RUNNERS.hybrid = async (ctx) => {
  const agents: AgentResult[] = [];
  const chainResults: AgentResult[][] = [];
  for (let c = 0; c < 2; c++) {
    const chain: AgentResult[] = [];
    for (let s = 0; s < 2; s++) {
      const p =
        s === 0 ? `[Chain ${c + 1}] ${ctx.task}` : `[Chain ${c + 1}] Continue the analysis.`;
      const r = await callAPI(ctx.baseUrl, ctx.key, ctx.model, SYSTEM_DEFAULT, p);
      chain.push({ agentIndex: c * 2 + s + 1, phase: `c${c + 1}s${s + 1}`, ...r });
      if (!r.success) break;
    }
    chainResults.push(chain);
    agents.push(...chain);
  }
  const merge = await callAPI(
    ctx.baseUrl,
    ctx.key,
    ctx.model,
    'Merge specialist. Combine two parallel chains into one answer.',
    `Task: "${ctx.task}"\n\nMerge 2 parallel analyses.`,
  );
  agents.push({ agentIndex: 0, phase: 'merge', ...merge });

  const chainWalls = chainResults.map((ch) => Math.max(...ch.map((a) => a.latencyMs)));
  return {
    ...(buildFail('hybrid', ctx, agents) as RunResult),
    wallClockMs: Math.max(...chainWalls) + merge.latencyMs,
    success: agents.every((a) => a.success),
  };
};

RUNNERS.debate = async (ctx) => {
  const N = 3;
  const agents: AgentResult[] = [];
  const results = await Promise.all(
    Array.from({ length: N }, (_, i) =>
      callAPI(ctx.baseUrl, ctx.key, ctx.model, SYSTEM_DEFAULT, ctx.task).then(
        (r) => ({ agentIndex: i + 1, phase: 'debater', ...r }) as AgentResult,
      ),
    ),
  );
  agents.push(...results);
  const ok = results.filter((r) => r.success);
  if (ok.length === N) {
    const judge = await callAPI(
      ctx.baseUrl,
      ctx.key,
      ctx.model,
      'Judge. Evaluate which answer is best and explain why.',
      `Question: "${ctx.task}"\n\nPick the best of ${N} answers and justify.`,
    );
    agents.push({ agentIndex: 0, phase: 'judge', ...judge });
  }
  return {
    ...(buildFail('debate', ctx, agents) as RunResult),
    wallClockMs:
      Math.max(...results.map((r) => r.latencyMs)) +
      (agents.find((a) => a.phase === 'judge')?.latencyMs ?? 0),
    success: agents.every((a) => a.success),
  };
};

RUNNERS.ensemble = async (ctx) => {
  const agents: AgentResult[] = [];
  const sysPrompts = [SYSTEM_DEFAULT, SYSTEM_EXPERT, SYSTEM_CREATIVE];
  const results = await Promise.all(
    sysPrompts.map((sp, i) =>
      callAPI(ctx.baseUrl, ctx.key, ctx.model, sp, ctx.task).then(
        (r) => ({ agentIndex: i + 1, phase: `voter${i + 1}`, ...r }) as AgentResult,
      ),
    ),
  );
  agents.push(...results);
  const ok = results.filter((r) => r.success);
  if (ok.length === 3) {
    const vote = await callAPI(
      ctx.baseUrl,
      ctx.key,
      ctx.model,
      'Voting coordinator. Select the best answer from diverse perspectives.',
      `Question: "${ctx.task}"\n\nVote on best answer.`,
    );
    agents.push({ agentIndex: 0, phase: 'vote', ...vote });
  }
  return {
    ...(buildFail('ensemble', ctx, agents) as RunResult),
    wallClockMs:
      Math.max(...results.map((r) => r.latencyMs)) +
      (agents.find((a) => a.phase === 'vote')?.latencyMs ?? 0),
    success: agents.every((a) => a.success),
  };
};

RUNNERS.evaluator_optimizer = async (ctx) => {
  const agents: AgentResult[] = [];
  const gen = await callAPI(ctx.baseUrl, ctx.key, ctx.model, SYSTEM_EXPERT, ctx.task);
  agents.push({ agentIndex: 1, phase: 'generate', ...gen });
  if (!gen.success) return buildFail('evaluator_optimizer', ctx, agents, gen);

  const evalR = await callAPI(
    ctx.baseUrl,
    ctx.key,
    ctx.model,
    SYSTEM_CRITIC,
    `Evaluate this answer to: "${ctx.task}"\n\nIdentify specific flaws.`,
  );
  agents.push({ agentIndex: 2, phase: 'evaluate', ...evalR });
  if (!evalR.success) return buildFail('evaluator_optimizer', ctx, agents, evalR);

  const ref = await callAPI(
    ctx.baseUrl,
    ctx.key,
    ctx.model,
    SYSTEM_EXPERT,
    `Original: "${ctx.task}"\n\nImprove your previous answer based on evaluation feedback.`,
  );
  agents.push({ agentIndex: 3, phase: 'refine', ...ref });

  return {
    ...buildFail('evaluator_optimizer', ctx, agents),
    wallClockMs: agents.reduce((s, a) => s + a.latencyMs, 0),
    success: agents.every((a) => a.success),
  };
};

RUNNERS.handoff = async (ctx) => {
  const agents: AgentResult[] = [];
  let ctx_ = '';
  for (let i = 0; i < 3; i++) {
    const p = i === 0 ? ctx.task : `Handoff from A${i}. ${ctx_}\n\nContinue: "${ctx.task}".`;
    const r = await callAPI(
      ctx.baseUrl,
      ctx.key,
      ctx.model,
      i === 0 ? SYSTEM_DEFAULT : `You are Agent ${i + 1}. Review handoff context and continue.`,
      p,
    );
    agents.push({ agentIndex: i + 1, phase: `handoff${i + 1}`, ...r });
    if (!r.success) break;
    ctx_ = `A${i + 1} completed.`;
  }
  return {
    ...buildFail('handoff', ctx, agents),
    wallClockMs: agents.reduce((s, a) => s + a.latencyMs, 0),
    success: agents.every((a) => a.success),
  };
};

RUNNERS.consensus = async (ctx) => {
  const agents: AgentResult[] = [];
  let shared = '';
  for (let rnd = 0; rnd < 3; rnd++) {
    const ra = await Promise.all(
      Array.from({ length: 3 }, (_, i) =>
        callAPI(
          ctx.baseUrl,
          ctx.key,
          ctx.model,
          rnd === 0 ? SYSTEM_DEFAULT : `Round ${rnd + 1}. Shared: ${shared.slice(0, 200)}`,
          rnd === 0
            ? ctx.task
            : `Round ${rnd + 1}/3. Refine position toward convergence.\n${shared ? `Context: ${shared}` : ''}`,
        ).then((r) => ({ agentIndex: i + 1, phase: `r${rnd + 1}`, ...r }) as AgentResult),
      ),
    );
    agents.push(...ra);
    if (!ra.every((a) => a.success)) break;
    shared = `Round ${rnd + 1} converged.`;
  }
  return {
    ...buildFail('consensus', ctx, agents),
    wallClockMs: agents.reduce((s, a) => s + a.latencyMs, 0),
    success: agents.every((a) => a.success),
  };
};

function buildFail(
  topo: string,
  ctx: { iter: number; task: string },
  agents: AgentResult[],
  lastErr?: CallResult,
): RunResult {
  return {
    iteration: ctx.iter,
    task: ctx.task,
    topology: topo,
    agents,
    wallClockMs: agents.reduce((s, a) => s + a.latencyMs, 0),
    totalInputTokens: agents.filter((a) => a.success).reduce((s, a) => s + a.inputTokens, 0),
    totalOutputTokens: agents.filter((a) => a.success).reduce((s, a) => s + a.outputTokens, 0),
    success: agents.every((a) => a.success),
    error: lastErr?.error ?? agents.find((a) => !a.success)?.error,
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function pickTask(idx: number): string {
  return BENCHMARK_TASKS[idx % BENCHMARK_TASKS.length];
}

function buildSummary(topo: string, runs: RunResult[], model: string): SummaryStats {
  const ok = runs.filter((r) => r.success);
  const ls = ok.map((r) => r.wallClockMs).sort((a, b) => a - b);
  const tInp = ok.reduce((s, r) => s + r.totalInputTokens, 0);
  const tOut = ok.reduce((s, r) => s + r.totalOutputTokens, 0);
  const cfg = TOPO_CFG[topo as keyof typeof TOPO_CFG] ?? { c: 1, exp: '?' };
  const p = MODEL_PRICING[model];
  const cost = p ? (tInp / 1_000_000) * p.input + (tOut / 1_000_000) * p.output : 0;
  return {
    topology: topo,
    costMult: cfg.c,
    expectedLatency: cfg.exp,
    totalRuns: runs.length,
    successes: ok.length,
    failures: runs.length - ok.length,
    failureRate: runs.length > 0 ? (runs.length - ok.length) / runs.length : 0,
    latencyMs: {
      min: ls[0] ?? 0,
      p50: ls[Math.floor(ls.length * 0.5)] ?? 0,
      p95: ls[Math.floor(ls.length * 0.95)] ?? 0,
      max: ls[ls.length - 1] ?? 0,
      avg: ls.length > 0 ? Math.round(ls.reduce((a, b) => a + b, 0) / ls.length) : 0,
    },
    tokPerRun:
      ok.length > 0
        ? Math.round(
            ok.reduce((s, r) => s + r.totalInputTokens + r.totalOutputTokens, 0) / ok.length,
          )
        : 0,
    tokInAvg: ok.length > 0 ? Math.round(tInp / ok.length) : 0,
    tokOutAvg: ok.length > 0 ? Math.round(tOut / ok.length) : 0,
    estCostUsd: cost,
    callsPerRun:
      ok.length > 0 ? Math.round(ok.reduce((s, r) => s + r.agents.length, 0) / ok.length) : 0,
  };
}

function log(msg = ''): void {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
}

function printReport(rpt: Report): void {
  const bar = '═'.repeat(56);
  console.log(`\n${bar}\n  TOPOLOGY BENCHMARK REPORT\n${bar}\n`);
  console.log(`  Model:        ${rpt.config.model}`);
  console.log(`  Provider:     ${rpt.config.provider}`);
  console.log(`  Iterations:   ${rpt.config.iterations} per topology`);
  console.log(`  Timestamp:    ${rpt.config.timestamp}`);
  console.log(
    `  Connectivity: ${rpt.connectivity.ok ? 'OK' : 'FAIL'} (${rpt.connectivity.latencyMs}ms)\n`,
  );

  for (const [name, s] of Object.entries(rpt.summary)) {
    const icon = s.failureRate > 0.1 ? '!' : '.';
    console.log(
      `  ${name.toUpperCase().padEnd(22)} ${icon}  ${s.callsPerRun} calls ×${s.costMult}  ${fmtLat(s.latencyMs.avg).padEnd(10)} ${s.tokPerRun}tok/run  fail=${(s.failureRate * 100).toFixed(0)}%  $${s.estCostUsd.toFixed(4)}`,
    );
  }

  console.log(`\n  ${'─'.repeat(56)}`);
  console.log(
    `  ${'RANK'.padEnd(5)} ${'TOPOLOGY'.padEnd(20)} ${'LATENCY'.padEnd(12)} ${'COST/100'.padEnd(10)} ${'CALLS'.padEnd(6)} ${'× vs S'.padEnd(8)}`,
  );
  console.log(
    `  ${'─'.repeat(5)} ${'─'.repeat(20)} ${'─'.repeat(12)} ${'─'.repeat(10)} ${'─'.repeat(6)} ${'─'.repeat(8)}`,
  );
  const baseLat = rpt.ranking.find((r) => r.topology === 'single')?.latencyAvg ?? 1;
  rpt.ranking.forEach((r, i) => {
    const x = baseLat > 0 ? (((r.latencyAvg - baseLat) / baseLat) * 100).toFixed(0) : '-';
    console.log(
      `  ${String(i + 1).padEnd(5)} ${r.topology.padEnd(20)} ${fmtLat(r.latencyAvg).padEnd(12)} $${r.costPer100.toFixed(2).padEnd(7)} ${String(r.callsPerRun).padEnd(6)} ${x.startsWith('-') ? x : `+${x}`}%`,
    );
  });
  console.log();

  // Detail per topology
  console.log(`  ${'─'.repeat(56)}`);
  console.log(`  DETAIL (all measurements per-run)\n`);
  const h = `  ${'TOPOLOGY'.padEnd(20)} ${'LAT(min/p50/avg/p95)'.padEnd(26)} ${'TOKENS(in/out/tot)'.padEnd(22)} ${'COST'.padEnd(8)} ${'AGENTS'.padEnd(6)} OK/RUN`;
  console.log(h);
  console.log(`  ${'─'.repeat(82)}`);
  for (const s of Object.values(rpt.summary)) {
    const l = s.latencyMs;
    const latStr = `${fmtShort(l.min)}/${fmtShort(l.p50)}/${fmtShort(l.avg)}/${fmtShort(l.p95)}`;
    const tokStr = `${s.tokInAvg}/${s.tokOutAvg}/${s.tokPerRun}`;
    console.log(
      `  ${s.topology.padEnd(20)} ${latStr.padEnd(26)} ${tokStr.padEnd(22)} $${(s.estCostUsd / Math.max(1, s.totalRuns)).toFixed(4).padEnd(6)} ${String(s.callsPerRun).padEnd(6)} ${s.successes}/${s.totalRuns}`,
    );
  }
  console.log();
}

function fmtLat(ms: number): string {
  return ms >= 60_000 ? `${(ms / 60_000).toFixed(1)}min` : `${ms}ms`;
}
function fmtShort(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const get = (f: string, d: string) => {
    const i = args.findIndex((a) => a.startsWith(f));
    if (i === -1) return d;
    return (args[i].includes('=') ? args[i].split('=')[1] : args[i + 1]) ?? d;
  };
  const apiKey = process.env.OPENAI_API_KEY ?? process.env.COMMANDER_API_KEY ?? '';
  if (!apiKey) {
    console.error('FATAL: Missing API key. Set OPENAI_API_KEY.');
    return 2;
  }
  const model = get('--model', DEFAULT_MODEL);
  const baseUrl = process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1';
  const iterations = Math.max(
    1,
    Math.min(50, parseInt(get('--iterations', String(DEFAULT_ITERATIONS)), 10) || 1),
  );
  const delayRaw = parseInt(get('--delay', String(DEFAULT_DELAY_MS)), 10);
  _rlDelayMs = Number.isFinite(delayRaw) ? Math.max(0, delayRaw) : DEFAULT_DELAY_MS;
  const topoRaw = get('--topology', DEFAULT_TOPOLOGY).toLowerCase();
  const outputPath = args.find((a) => a.startsWith('--output='))?.split('=')[1];
  const tenantId = get('--tenant', deriveTenantId(baseUrl, model));

  if (topoRaw !== 'all' && !(topoRaw in TOPO_CFG)) {
    console.error(`FATAL: Invalid topology "${topoRaw}". Valid: all, ${TOPO_ORDER.join(', ')}`);
    return 2;
  }
  const topologies: string[] = topoRaw === 'all' ? [...TOPO_ORDER] : [topoRaw];

  console.log();
  log('Commander Topology Benchmark');
  log(
    `Model: ${model}  Iterations: ${iterations}  Topologies: ${topologies.length}  Delay: ${_rlDelayMs}ms`,
  );
  if (_rlDelayMs === 0) {
    log(
      'WARNING: --delay=0 enables true parallelism; ensure your provider can handle the request rate.',
    );
  }
  log();

  // Warmup
  log('Warmup ...');
  const warm = await callAPI(baseUrl, apiKey, model, SYSTEM_DEFAULT, 'Reply "ok".');
  if (!warm.success) {
    log(`Warmup FAILED: ${warm.error}`);
    return 1;
  }
  log(`Warmup OK: ${warm.latencyMs}ms\n`);

  // ── Commander framework overhead measurement ─────────────────────────────
  // Measure the actual overhead added by Commander's topology selection and
  // deliberation, independent of raw LLM latency.
  let commanderOverheadMs = 0;
  let commanderTopology: string | undefined;
  try {
    const { TopologyRouter } = await import('../packages/core/src/ultimate/topologyRouter');
    const { deliberate } = await import('../packages/core/src/ultimate/deliberation');
    const router = new TopologyRouter();

    const overheadStart = performance.now();
    const plan = deliberate(pickTask(0));
    const routeResult = router.route(plan);
    commanderOverheadMs = performance.now() - overheadStart;
    commanderTopology = routeResult.topology;

    log(
      `Commander overhead: ${commanderOverheadMs.toFixed(1)}ms (topology: ${commanderTopology})\n`,
    );
  } catch (e) {
    log(`Commander overhead measurement skipped: ${(e as Error).message}\n`);
  }

  const rpt: Report = {
    config: { model, provider: baseUrl, iterations, timestamp: new Date().toISOString() },
    connectivity: { ok: true, latencyMs: warm.latencyMs },
    results: [],
    summary: {},
    ranking: [],
    commanderOverheadMs,
    commanderTopology,
  };

  // Run each topology
  for (const topo of topologies) {
    const runner = RUNNERS[topo];
    if (!runner) {
      log(`Skip: no runner for ${topo}`);
      continue;
    }
    const cfg = TOPO_CFG[topo as keyof typeof TOPO_CFG];
    log(`${topo.toUpperCase()}  ×${cfg.c}  exp:${cfg.exp}  ${iterations} iterations`);

    const runs: RunResult[] = [];
    for (let i = 0; i < iterations; i++) {
      const task = pickTask(TOPO_ORDER.indexOf(topo as TopologyName) * 3 + i);
      const r = await runner({ baseUrl, key: apiKey, model, iter: i + 1, task });
      runs.push(r);
      if (r.success) {
        log(
          `  [${i + 1}/${iterations}] ${fmtShort(r.wallClockMs).padEnd(8)} ${r.totalInputTokens + r.totalOutputTokens}tok  ${r.agents.filter((a) => a.success).length}/${r.agents.length}ok`,
        );
      } else {
        log(`  [${i + 1}/${iterations}] FAIL: ${(r.error ?? '').slice(0, 60)}`);
      }
    }
    rpt.summary[topo] = buildSummary(topo, runs, model);
    rpt.results.push(...runs);
  }

  // Ranking
  const sorted = Object.values(rpt.summary).sort((a, b) => a.latencyMs.avg - b.latencyMs.avg);
  rpt.ranking = sorted.map((s) => ({
    topology: s.topology,
    latencyAvg: s.latencyMs.avg,
    costPer100: (s.estCostUsd / Math.max(1, s.totalRuns)) * 100,
    callsPerRun: s.callsPerRun,
  }));

  printReport(rpt);
  emitCalibration(rpt, tenantId);

  if (outputPath) {
    const p = resolve(outputPath);
    const d = p.slice(0, p.lastIndexOf('/'));
    if (d && !existsSync(d)) mkdirSync(d, { recursive: true });
    writeFileSync(p, JSON.stringify(rpt, null, 2));
    log(`Report saved to ${p}`);
  }

  const allFailed = rpt.results.length > 0 && rpt.results.every((r) => !r.success);
  return allFailed ? 1 : 0;
}

function fmtLatencyBand(ms: number): string {
  if (ms < 5000) return '< 5s';
  if (ms < 15000) return '5-15s';
  if (ms < 30000) return '10-30s';
  if (ms < 60000) return '30-60s';
  if (ms < 120000) return '30-120s';
  if (ms < 300000) return '1-5min';
  return '> 5min';
}

function deriveTenantId(baseUrl: string, model: string): string {
  try {
    const host = new URL(baseUrl).hostname.replace(/^api\./, '').replace(/\./g, '_');
    return `${host}__${model}`;
  } catch (err) {
    reportSilentFailure(err, 'benchmark-topology:874');
    return `unknown__${model}`;
  }
}

function emitCalibration(rpt: Report, tenantId: string): void {
  const learned = getGlobalLearnedWeights();
  const single = rpt.summary.single;
  const baselineCost = single ? single.estCostUsd / Math.max(1, single.totalRuns) : 0;
  const calibration: Record<
    string,
    {
      successRate: number;
      avgLatencyMs: number;
      p50LatencyMs: number;
      avgCostUsd: number;
      recommendedCostMultiplier: number;
      recommendedLatencyBand: string;
      signalsRecorded: number;
    }
  > = {};

  for (const [topo, stats] of Object.entries(rpt.summary)) {
    const avgCost = stats.estCostUsd / Math.max(1, stats.totalRuns);
    const recommendedCostMultiplier = baselineCost > 0 ? avgCost / baselineCost : stats.costMult;
    const recommendedLatencyBand = fmtLatencyBand(stats.latencyMs.p50);
    const successRate = stats.successes / Math.max(1, stats.totalRuns);
    const topoCanonical = topo.toUpperCase() as OrchestrationTopology;

    // Feed benchmark results back into the global LearnedWeights store so the
    // router adapts to observed success rates.
    learned.recordSignal('BENCHMARK', topoCanonical, successRate >= 0.5);

    // Record observed p50 latency so the router can use provider/model-specific
    // latency bands instead of hard-coded defaults.
    learned.recordCoordinationWeight(
      `latency_band_ms_${topoCanonical}`,
      'BENCHMARK',
      stats.latencyMs.p50,
      tenantId,
    );

    calibration[topoCanonical] = {
      successRate,
      avgLatencyMs: stats.latencyMs.avg,
      p50LatencyMs: stats.latencyMs.p50,
      avgCostUsd: avgCost,
      recommendedCostMultiplier,
      recommendedLatencyBand,
      signalsRecorded: 1,
    };
  }

  const outDir = resolve('.commander');
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const outPath = resolve(outDir, 'topology-calibration.json');
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        model: rpt.config.model,
        provider: rpt.config.provider,
        tenantId,
        timestamp: rpt.config.timestamp,
        baselineCostUsd: baselineCost,
        calibration,
      },
      null,
      2,
    ),
  );
  log(`Calibration saved to ${outPath}`);
}

main().then(
  (c) => process.exit(c),
  (e) => {
    console.error('FATAL:', e);
    process.exit(2);
  },
);
