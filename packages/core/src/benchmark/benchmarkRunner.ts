#!/usr/bin/env node
/**
 * Benchmark Runner — single interface for all benchmarks.
 *
 * Usage:
 *   commander benchmark config.yaml --parallel 5         # 5 concurrent requests
 *   commander benchmark config.yaml --output ./results   # Custom output dir
 *   commander benchmark --list                           # List available configs
 */

import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import * as yaml from 'js-yaml';
import { env } from 'process';
import { getGlobalLogger } from '../logging';

// ============================================================================
// Types
// ============================================================================

export interface BenchmarkConfig {
  benchmark: {
    name: string;
    type: 'generation' | 'chat' | 'function_calling';
    dataset: string;
    format: 'jsonl' | 'json' | 'csv' | 'arrow';
    temperature: number;
    answer_key?: string;
    prompt_key?: string;
    evaluator?: 'exact_match' | 'llm_judge';
    tools?: Array<{ name: string; description: string; parameters: Record<string, unknown> }>;
  };
}

export interface BenchmarkItem {
  task_id?: string;
  id?: string | number;
  prompt?: string;
  question?: string;
  answer?: string;
  expected?: string;
  [key: string]: unknown;
}

export interface BenchmarkResult {
  task_id: string;
  prompt: string;
  expected: string;
  response: string | null;
  correct: boolean;
  durationMs: number;
  error?: string;
  toolCorrect?: boolean;
  paramCorrect?: boolean;
}

export interface BenchmarkSummary {
  benchmark: string;
  total: number;
  correct: number;
  accuracy: string;
  totalDurationMs: number;
  results: BenchmarkResult[];
  config: BenchmarkConfig['benchmark'];
  byCategory?: Record<string, { t: number; p: number; total: number }>;
}

// ============================================================================
// Config loading
// ============================================================================

function expandHome(p: string): string {
  if (p.startsWith('~/')) return path.join(env.HOME || '/tmp', p.slice(2));
  return p;
}

export function loadConfig(configPath: string): BenchmarkConfig {
  const raw = fs.readFileSync(configPath, 'utf-8');
  if (configPath.endsWith('.json')) {
    try { return JSON.parse(raw); } catch (e) { throw new Error(`Invalid JSON in config ${configPath}: ${(e as Error).message}`); }
  }
  return yaml.load(raw) as BenchmarkConfig;
}

// ============================================================================
// Dataset loading
// ============================================================================

function readTextFile(p: string): string {
  if (p.endsWith('.gz')) {
    return zlib.gunzipSync(fs.readFileSync(p)).toString('utf-8');
  }
  return fs.readFileSync(p, 'utf-8');
}

function loadDataset(cfg: BenchmarkConfig['benchmark']): BenchmarkItem[] {
  const p = expandHome(cfg.dataset);
  const fmt = cfg.format;

  if (!fs.existsSync(p)) {
    getGlobalLogger().error('BenchmarkRunner', `Dataset not found: ${p}`);
    return [];
  }

  if (fmt === 'jsonl') {
    const lines = readTextFile(p)
      .split('\n')
      .filter((l: string) => l.trim());
    const items: BenchmarkItem[] = [];
    for (const l of lines) {
      try { items.push(JSON.parse(l)); } catch (e) { getGlobalLogger().error('BenchmarkRunner', `Skipping invalid JSONL line: ${(e as Error).message.slice(0, 80)}`); }
    }
    return items;
  }

  if (fmt === 'json') {
    let d: unknown;
    try { d = JSON.parse(readTextFile(p)); } catch (e) { getGlobalLogger().error('BenchmarkRunner', `Invalid JSON dataset: ${(e as Error).message.slice(0, 80)}`); return []; }
    if (Array.isArray(d)) return d as BenchmarkItem[];
    const obj = d as Record<string, unknown>;
    return (obj.data ?? obj.questions ?? obj.tasks ?? []) as BenchmarkItem[];
  }

  if (fmt === 'csv') {
    const lines = readTextFile(p).split('\n').filter(l => l.trim());
    if (lines.length < 2) return [];
    const headers = lines[0].split(',').map(h => h.trim());
    return lines.slice(1).map(line => {
      const vals = line.split(',').map(v => v.trim());
      const obj: Record<string, string> = {};
      headers.forEach((h, i) => { obj[h] = vals[i] || ''; });
      return obj;
    });
  }

  if (fmt === 'arrow') {
    const jsonPath = p.replace(/\.arrow$/, '.json');
    if (fs.existsSync(jsonPath)) {
      try { return JSON.parse(fs.readFileSync(jsonPath, 'utf-8')); } catch (e) { getGlobalLogger().error('BenchmarkRunner', `Invalid JSON in ${jsonPath}: ${(e as Error).message.slice(0, 80)}`); return []; }
    }
    getGlobalLogger().error('BenchmarkRunner', `Arrow format requires conversion. Run: python3 -c "import pyarrow.ipc as ipc; import json; t = ipc.open_stream(open('${p}','rb')).read_all(); print(json.dumps(t.to_pydict(), default=str))" > ${jsonPath}`);
    return [];
  }

  return [];
}

// ============================================================================
// Prompt building
// ============================================================================

function buildPrompt(bench: BenchmarkConfig['benchmark'], item: BenchmarkItem): string {
  const promptKey = bench.prompt_key || 'prompt';
  // For function_calling: tools are passed via API tools parameter, not in prompt text
  return String(item[promptKey] ?? item.prompt ?? item.question ?? '');
}

// ============================================================================
// API call
// ============================================================================

interface ApiConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  temperature: number;
}

function readApiKey(): string {
  const envPath = path.join(process.cwd(), '.env');
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf-8').split('\n');
    for (const l of lines) {
      const trimmed = l.trim();
      if (trimmed.startsWith('OPENAI_API_KEY=')) {
        return trimmed.split('=').slice(1).join('=').trim();
      }
      if (trimmed.startsWith('MIMO_API_KEY=')) {
        return trimmed.split('=').slice(1).join('=').trim();
      }
    }
  }
  return env.OPENAI_API_KEY || env.MIMO_API_KEY || '';
}

interface CallModelOptions {
  tools?: Array<{ name: string; description: string; parameters: Record<string, unknown> }>;
}

async function callModel(apiCfg: ApiConfig, prompt: string, options?: CallModelOptions): Promise<string | null> {
  const url = `${apiCfg.baseUrl}/chat/completions`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 60000);

      const messages: Array<{ role: string; content: string }> = [];

      // Add system prompt for function calling benchmarks
      if (options?.tools && options.tools.length > 0) {
        messages.push({
          role: 'system',
          content: [
            'You are a helpful assistant with access to tools. Follow these rules strictly:',
            '',
            'TOOL USE RULES:',
            '1. If the user\'s question can be answered from your general knowledge (e.g. "What is the capital of France?"), answer directly WITHOUT calling any tools.',
            '2. When a tool matches the user\'s intent, call it immediately with sensible defaults. NEVER ask for clarification — just use reasonable defaults for missing parameters.',
            '3. For email tools: use placeholder values for missing fields (e.g. subject="No Subject", body="Hello").',
            '4. When the user requests multiple actions in one message, call ALL necessary tools in a single response (parallel tool calls).',
            '5. Never refuse to call a tool because a parameter seems missing — use your best judgment for defaults.',
            '',
            'IMPORTANT: Call tools when needed. Do NOT call tools when the question is answerable from general knowledge alone.',
          ].join('\n'),
        });
      }

      messages.push({ role: 'user', content: prompt.slice(0, 3000) });

      const body: Record<string, unknown> = {
        model: apiCfg.model,
        temperature: apiCfg.temperature,
        top_p: 0.95,
        max_tokens: 1024,
        messages,
        chat_template_kwargs: { enable_thinking: false },
      };

      // Add tools for function calling benchmarks
      if (options?.tools && options.tools.length > 0) {
        body.tools = options.tools.map(t => ({
          type: 'function',
          function: {
            name: t.name,
            description: t.description,
            parameters: t.parameters,
          },
        }));
        body.tool_choice = 'auto';
      }

      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiCfg.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!resp.ok) {
        const text = await resp.text();
        getGlobalLogger().error('BenchmarkRunner', `API ${resp.status}: ${text.slice(0, 200)}`);
        if (attempt < 2) await new Promise(r => setTimeout(r, 3000));
        continue;
      }
      const data = await resp.json() as {
        choices?: Array<{
          message?: {
            content?: string;
            tool_calls?: Array<{
              id?: string;
              type?: string;
              function?: { name: string; arguments: string };
            }>;
          };
        }>;
      };
      const msg = data.choices?.[0]?.message;
      if (!msg) return null;

      // If tool_calls present, serialize as JSON for downstream parsing
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        return JSON.stringify({ tool_calls: msg.tool_calls });
      }
      return msg.content || null;
    } catch (err: unknown) {
      if (attempt < 2) {
        await new Promise(r => setTimeout(r, 3000));
      } else {
        getGlobalLogger().error('BenchmarkRunner', `API error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  return null;
}

// ============================================================================
// Scoring
// ============================================================================

/**
 * Extract the answer from an LLM response.
 */
function extractAnswer(response: string): string {
  if (!response) return '';
  const text = response.trim();

  const finalMatch = text.match(/FINAL\s*ANSWER:\s*(.+?)(?:\n|$)/i);
  if (finalMatch) return finalMatch[1].trim();

  const answerMatch = text.match(/(?:^|\n)\s*Answer:\s*(.+?)(?:\n|$)/i);
  if (answerMatch) return answerMatch[1].trim();

  const jsonMatch = text.match(/```json\s*(\{[\s\S]*?\})\s*```/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[1]);
      if (parsed.answer) return String(parsed.answer).trim();
    } catch { /* not valid JSON */ }
  }

  const lines = text.split('\n').filter(l => l.trim());
  if (lines.length >= 2) {
    const lastLine = lines[lines.length - 1].trim();
    if (lastLine.length < 100 && text.length > 200) {
      return lastLine;
    }
  }

  return text;
}

/**
 * Extract tool call name from a response.
 */
function extractToolCall(response: string): string | null {
  if (!response) return null;
  const text = response.trim();

  // Pattern 1: JSON tool_calls array
  const tcMatch = text.match(/"tool_calls"\s*:\s*\[([\s\S]*?)\]/);
  if (tcMatch) {
    try {
      const calls = JSON.parse(`[${tcMatch[1]}]`);
      if (calls.length > 0 && calls[0].function?.name) return calls[0].function.name;
    } catch { /* not valid JSON */ }
  }

  // Pattern 2: function_call with name
  const fnMatch = text.match(/"function"\s*:\s*\{[^}]*"name"\s*:\s*"([^"]+)"/);
  if (fnMatch) return fnMatch[1];

  // Pattern 3: XML-style tool call
  const xmlMatch = text.match(/<tool_call>[\s\S]*?name\s*[=:]\s*["']?(\w+)["']?[\s\S]*?<\/tool_call>/i);
  if (xmlMatch) return xmlMatch[1];

  // Pattern 4: Simple XML tool_call without closing tag
  const xmlSimple = text.match(/<tool_call>[\s\S]*?name\s*[=:]\s*["']?(\w+)["']?/i);
  if (xmlSimple) return xmlSimple[1];

  // Pattern 5: tool_name or function_name in text
  const nameMatch = text.match(/(?:tool_name|function_name)\s*[=:]\s*["']?(\w+)["']?/i);
  if (nameMatch) return nameMatch[1];

  return null;
}

interface ScoreResult {
  correct: boolean;
  toolCorrect?: boolean;
  paramCorrect?: boolean;
}

function scoreResponse(bench: BenchmarkConfig['benchmark'], item: BenchmarkItem, response: string | null): ScoreResult {
  const answerKey = bench.answer_key || 'answer';
  let expected = String(item[answerKey] || item.expected || item.answer || '').trim();

  // Function calling scoring (BFCL-style)
  if (bench.type === 'function_calling') {
    const toolCall = extractToolCall(response || '');
    const expectedTool = expected.toLowerCase();
    const cat = String(item.cat || item.category || '').toLowerCase();

    if (!expectedTool || expectedTool === 'none' || expectedTool === 'null') {
      if (cat === 'irrelevance') {
        const noCall = toolCall === null;
        return { correct: noCall, toolCorrect: noCall, paramCorrect: noCall };
      } else {
        // multiple/parallel: model SHOULD call tools
        const hasCall = toolCall !== null;
        return { correct: hasCall, toolCorrect: hasCall, paramCorrect: hasCall };
      }
    }

    const toolCorrect = toolCall?.toLowerCase() === expectedTool;
    return { correct: toolCorrect, toolCorrect, paramCorrect: toolCorrect };
  }

  // Standard text-based scoring
  if (!expected) {
    // SECURITY FIX: empty expected field means we cannot validate — count as fail, not pass
    // Previous bug: any response >10 chars was counted as correct, inflating scores
    return { correct: false };
  }

  const extracted = extractAnswer(response || '');
  const mc = extracted.trim().toLowerCase().replace(/[.!?]+$/, '');
  const ec = expected.toLowerCase().replace(/[.!?]+$/, '');

  const normalize = (s: string) => s.replace(/[^a-z0-9]/g, '').replace(/\s+/g, '');
  const mcNorm = normalize(mc);
  const ecNorm = normalize(ec);

  const correct = mc === ec || mc.includes(ec) || ec.includes(mc) || mcNorm === ecNorm;
  return { correct };
}

// ============================================================================
// Main runner
// ============================================================================

export interface RunnerOptions {
  model?: string;
  outputDir?: string;
  parallel?: number;
  maxItems?: number;
}

export async function runBenchmark(
  configPath: string,
  options: RunnerOptions = {}
): Promise<BenchmarkSummary> {
  const config = loadConfig(configPath);
  const bench = config.benchmark;
  const apiKey = readApiKey();

  if (!apiKey) {
    throw new Error('No API key found. Set OPENAI_API_KEY or MIMO_API_KEY in .env or environment.');
  }

  const apiCfg: ApiConfig = {
    apiKey,
    baseUrl: env.OPENAI_BASE_URL || 'https://token-plan-sgp.xiaomimimo.com/v1',
    model: options.model || 'mimo-v2.5-pro',
    temperature: bench.temperature ?? 0.2,
  };

  const dataset = loadDataset(bench);
  if (dataset.length === 0) {
    throw new Error(`Empty dataset for ${bench.name}`);
  }

  const items = options.maxItems ? dataset.slice(0, options.maxItems) : dataset;
  const parallel = options.parallel || 1;

  const outputDir = options.outputDir || path.join(process.cwd(), 'benchmarks');
  const resultDir = path.join(outputDir, bench.name);
  const respDir = path.join(resultDir, 'responses');
  fs.mkdirSync(respDir, { recursive: true });

  const results: BenchmarkResult[] = [];
  const startTime = Date.now();

  getGlobalLogger().info('BenchmarkRunner', `\n  ${'='.repeat(50)}`);
  getGlobalLogger().info('BenchmarkRunner', `  Benchmark: ${bench.name}`);
  getGlobalLogger().info('BenchmarkRunner', `  Dataset:   ${items.length} items`);
  getGlobalLogger().info('BenchmarkRunner', `  Model:     ${apiCfg.model}`);
  getGlobalLogger().info('BenchmarkRunner', `  Parallel:  ${parallel}`);
  getGlobalLogger().info('BenchmarkRunner', `  ${'='.repeat(50)}\n`);

  // Process in batches
  for (let i = 0; i < items.length; i += parallel) {
    const batch = items.slice(i, i + parallel);
    const batchResults = await Promise.all(
      batch.map(async (item, batchIdx) => {
        const idx = i + batchIdx;
        const taskId = String(item.task_id ?? item.id ?? idx);
        const prompt = buildPrompt(bench, item);

        const t0 = Date.now();
        const callOpts: CallModelOptions | undefined = bench.tools?.length ? { tools: bench.tools } : undefined;
        const response = await callModel(apiCfg, prompt, callOpts);
        const durationMs = Date.now() - t0;

        const score = scoreResponse(bench, item, response);
        const extractedAnswer = response ? extractAnswer(response) : '';

        const result: BenchmarkResult = {
          task_id: taskId,
          prompt: prompt.slice(0, 100),
          expected: String(item[bench.answer_key || 'answer'] || item.expected || ''),
          response,
          correct: score.correct,
          durationMs,
          error: response === null ? 'API failed after 3 retries' : undefined,
          toolCorrect: score.toolCorrect,
          paramCorrect: score.paramCorrect,
        };

        // Save raw response with extracted answer and scores
        const safeId = taskId.replace(/[/\\]/g, '_');
        fs.writeFileSync(
          path.join(respDir, `${safeId}.json`),
          JSON.stringify({ input: item, output: response, extracted_answer: extractedAnswer, ...score }, null, 2),
          'utf-8'
        );

        const icon = response === null ? '⚠️' : score.correct ? '✅' : '❌';
        process.stdout.write(`  [${idx + 1}/${items.length}] ${taskId.slice(0, 40).padEnd(42)} ${icon}\n`);

        return result;
      })
    );
    results.push(...batchResults);
  }

  const totalDurationMs = Date.now() - startTime;
  const correctCount = results.filter(r => r.correct).length;
  const accuracy = results.length > 0
    ? `${(correctCount / results.length * 100).toFixed(1)}%`
    : 'N/A';

  // Compute by_category breakdown for function_calling benchmarks
  let byCategory: Record<string, { t: number; p: number; total: number }> | undefined;
  if (bench.type === 'function_calling') {
    byCategory = {};
    for (let i = 0; i < results.length; i++) {
      const item = items[i];
      const cat = String(item.cat || item.category || 'unknown');
      if (!byCategory[cat]) byCategory[cat] = { t: 0, p: 0, total: 0 };
      byCategory[cat].total++;
      if (results[i].toolCorrect) byCategory[cat].t++;
      if (results[i].paramCorrect) byCategory[cat].p++;
    }
  }

  const summary: BenchmarkSummary = {
    benchmark: bench.name,
    total: results.length,
    correct: correctCount,
    accuracy,
    totalDurationMs,
    results,
    config: bench,
    byCategory,
  };

  // Compute tool/param accuracy for function_calling
  const toolCorrectCount = results.filter(r => r.toolCorrect).length;
  const paramCorrectCount = results.filter(r => r.paramCorrect).length;

  // Save summary
  const summaryPath = path.join(resultDir, 'results.json');
  const summaryData: Record<string, unknown> = {
    benchmark: summary.benchmark,
    total: summary.total,
    correct: summary.correct,
    accuracy: summary.accuracy,
    totalDurationMs: summary.totalDurationMs,
    config: bench,
  };
  if (byCategory) {
    summaryData.tool_selection = `${(toolCorrectCount / results.length * 100).toFixed(1)}%`;
    summaryData.parameter_accuracy = `${(paramCorrectCount / results.length * 100).toFixed(1)}%`;
    summaryData.tool_correct = toolCorrectCount;
    summaryData.param_correct = paramCorrectCount;
    summaryData.by_category = byCategory;
  }
  fs.writeFileSync(summaryPath, JSON.stringify(summaryData, null, 2), 'utf-8');

  getGlobalLogger().info('BenchmarkRunner', `\n  ${'='.repeat(50)}`);
  getGlobalLogger().info('BenchmarkRunner', `  ${bench.name}: ${accuracy}`);
  getGlobalLogger().info('BenchmarkRunner', `  ${correctCount}/${results.length} correct`);
  getGlobalLogger().info('BenchmarkRunner', `  Duration: ${(totalDurationMs / 1000).toFixed(1)}s`);
  getGlobalLogger().info('BenchmarkRunner', `  Results:  ${summaryPath}`);
  getGlobalLogger().info('BenchmarkRunner', `  ${'='.repeat(50)}\n`);

  return summary;
}

// ============================================================================
// CLI entry point
// ============================================================================

function listConfigs(): string[] {
  const dir = path.join(process.cwd(), 'benchmarks', 'configs');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.endsWith('.yaml') || f.endsWith('.yml') || f.endsWith('.json'));
}

export async function main(args: string[]): Promise<void> {
  if (args.includes('--list') || args.includes('-l')) {
    const configs = listConfigs();
    if (configs.length === 0) {
      getGlobalLogger().info('BenchmarkRunner', 'No benchmark configs found in benchmarks/configs/');
      return;
    }
    getGlobalLogger().info('BenchmarkRunner', '\n  Available benchmarks:\n');
    for (const c of configs) {
      const cfg = loadConfig(path.join(process.cwd(), 'benchmarks', 'configs', c));
      getGlobalLogger().info('BenchmarkRunner', `    ${c.padEnd(25)} ${cfg.benchmark.name} (${cfg.benchmark.type}, ${cfg.benchmark.format})`);
    }
    getGlobalLogger().info('BenchmarkRunner', '');
    return;
  }

  if (args.length === 0 || args[0] === 'help' || args[0] === '--help') {
    process.stdout.write(`
  Usage:
    commander benchmark <config.yaml> [options]

  Options:
    --model <name>       Model to use (default: mimo-v2.5-pro)
    --output <dir>       Output directory (default: ./benchmarks)
    --parallel <n>       Parallel requests (default: 1)
    --max <n>            Max items to process
    --list, -l           List available benchmark configs
`);
    return;
  }

  const configArg = args[0];
  if (!configArg) {
    getGlobalLogger().error('BenchmarkRunner', 'No config file specified');
    return;
  }

  // Resolve config path
  let configPath = configArg;
  if (!path.isAbsolute(configPath)) {
    const inConfigs = path.join(process.cwd(), 'benchmarks', 'configs', configPath);
    if (fs.existsSync(inConfigs)) {
      configPath = inConfigs;
    } else if (fs.existsSync(path.join(process.cwd(), configPath))) {
      configPath = path.join(process.cwd(), configPath);
    } else {
      getGlobalLogger().error('BenchmarkRunner', `Config not found: ${configArg}`);
      return;
    }
  }

  const opts: RunnerOptions = {};
  const argIdx = args.indexOf('--model');
  if (argIdx !== -1 && args[argIdx + 1]) opts.model = args[argIdx + 1];
  const outIdx = args.indexOf('--output');
  if (outIdx !== -1 && args[outIdx + 1]) opts.outputDir = args[outIdx + 1];
  const parIdx = args.indexOf('--parallel');
  if (parIdx !== -1 && args[parIdx + 1]) opts.parallel = parseInt(args[parIdx + 1], 10) || 1;
  const maxIdx = args.indexOf('--max');
  if (maxIdx !== -1 && maxIdx + 1 < args.length) opts.maxItems = parseInt(args[maxIdx + 1], 10) || undefined;

  await runBenchmark(configPath, opts);
}

const isMain = process.argv[1]?.endsWith('benchmarkRunner.ts');
if (isMain) {
  main(process.argv.slice(3)).catch(err => {
    getGlobalLogger().error('BenchmarkRunner', `Fatal: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
