#!/usr/bin/env node
/**
 * Benchmark Runner — single interface for all benchmarks.
 *
 * Usage:
 *   commander benchmark gaia.yaml                       # Run GAIA benchmark
 *   commander benchmark config.yaml --parallel 5         # 5 concurrent requests
 *   commander benchmark config.yaml --output ./results   # Custom output dir
 *   commander benchmark --list                           # List available configs
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { env } from 'process';

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
    tools?: any[];
  };
}

export interface BenchmarkItem {
  task_id?: string;
  id?: string | number;
  prompt?: string;
  question?: string;
  answer?: string;
  expected?: string;
  [key: string]: any;
}

export interface BenchmarkResult {
  task_id: string;
  prompt: string;
  expected: string;
  response: string | null;
  correct: boolean;
  durationMs: number;
  error?: string;
}

export interface BenchmarkSummary {
  benchmark: string;
  total: number;
  correct: number;
  accuracy: string;
  totalDurationMs: number;
  results: BenchmarkResult[];
  config: BenchmarkConfig['benchmark'];
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
    return JSON.parse(raw);
  }
  return yaml.load(raw) as BenchmarkConfig;
}

// ============================================================================
// Dataset loading
// ============================================================================

function readTextFile(p: string): string {
  if (p.endsWith('.gz')) {
    const zlib = require('zlib');
    return zlib.gunzipSync(fs.readFileSync(p)).toString('utf-8');
  }
  return fs.readFileSync(p, 'utf-8');
}

function loadDataset(cfg: BenchmarkConfig['benchmark']): BenchmarkItem[] {
  const p = expandHome(cfg.dataset);
  const fmt = cfg.format;

  if (!fs.existsSync(p)) {
    console.error(`  Dataset not found: ${p}`);
    return [];
  }

  if (fmt === 'jsonl') {
    return readTextFile(p)
      .split('\n')
      .filter((l: string) => l.trim())
      .map((l: string) => JSON.parse(l));
  }

  if (fmt === 'json') {
    const d = JSON.parse(readTextFile(p));
    if (Array.isArray(d)) return d;
    return d.data || d.questions || d.tasks || [];
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
    // Arrow format — try to extract via Python helper
    if (!fs.existsSync(p)) {
      console.error(`  Dataset not found: ${p}`);
      return [];
    }
    const jsonPath = p.replace(/\.arrow$/, '.json');
    if (fs.existsSync(jsonPath)) {
      return JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
    }
    // Try to convert via Python
    console.error(`  Arrow format requires conversion. Run:`);
    console.error(`    python3 -c "import pyarrow; import json; t = pyarrow.feather.read_table('${p}'); print(json.dumps(t.to_pydict()))" > ${jsonPath}`);
    return [];
  }

  return [];
}

// ============================================================================
// Prompt building
// ============================================================================

function buildPrompt(bench: BenchmarkConfig['benchmark'], item: BenchmarkItem): string {
  const promptKey = bench.prompt_key || 'prompt';
  if (bench.type === 'function_calling') {
    const toolsStr = JSON.stringify(bench.tools || [], null, 2);
    return `Available tools:\n${toolsStr}\n\nUser: ${item[promptKey] || item.prompt || item.question || ''}`;
  }
  return item[promptKey] || item.prompt || item.question || '';
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
  // Try .env first
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
  // Fallback to env var
  return env.OPENAI_API_KEY || env.MIMO_API_KEY || '';
}

async function callModel(apiCfg: ApiConfig, prompt: string): Promise<string | null> {
  const url = `${apiCfg.baseUrl}/chat/completions`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 60000);
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiCfg.apiKey}`,
        },
        body: JSON.stringify({
          model: apiCfg.model,
          temperature: apiCfg.temperature,
          top_p: 0.95,
          max_tokens: 1024,
          messages: [{ role: 'user', content: prompt.slice(0, 3000) }],
          chat_template_kwargs: { enable_thinking: false },
        }),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!resp.ok) {
        const text = await resp.text();
        console.error(`    API ${resp.status}: ${text.slice(0, 200)}`);
        if (attempt < 2) await new Promise(r => setTimeout(r, 3000));
        continue;
      }
      const data = await resp.json() as any;
      return data.choices?.[0]?.message?.content || null;
    } catch (err: any) {
      if (attempt < 2) {
        await new Promise(r => setTimeout(r, 3000));
      } else {
        console.error(`    API error: ${err?.message || err}`);
      }
    }
  }
  return null;
}

// ============================================================================
// Scoring
// ============================================================================

function scoreResponse(bench: BenchmarkConfig['benchmark'], item: BenchmarkItem, response: string | null): boolean {
  const answerKey = bench.answer_key || 'answer';
  let expected = String(item[answerKey] || item.expected || item.answer || '').trim().toLowerCase();
  if (!expected) {
    return response !== null && response.length > 10;
  }
  const mc = (response || '').trim().toLowerCase().replace(/[.!?]+$/, '');
  const ec = expected.replace(/[.!?]+$/, '');
  return mc === ec || mc.includes(ec) || ec.includes(mc);
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

  console.log(`\n  ${'='.repeat(50)}`);
  console.log(`  Benchmark: ${bench.name}`);
  console.log(`  Dataset:   ${items.length} items`);
  console.log(`  Model:     ${apiCfg.model}`);
  console.log(`  Parallel:  ${parallel}`);
  console.log(`  ${'='.repeat(50)}\n`);

  // Process in batches
  for (let i = 0; i < items.length; i += parallel) {
    const batch = items.slice(i, i + parallel);
    const batchResults = await Promise.all(
      batch.map(async (item, batchIdx) => {
        const idx = i + batchIdx;
        const taskId = String(item.task_id ?? item.id ?? idx);
        const prompt = buildPrompt(bench, item);

        const t0 = Date.now();
        const response = await callModel(apiCfg, prompt);
        const durationMs = Date.now() - t0;

        const correct = scoreResponse(bench, item, response);

        const result: BenchmarkResult = {
          task_id: taskId,
          prompt: prompt.slice(0, 100),
          expected: String(item[bench.answer_key || 'answer'] || item.expected || ''),
          response,
          correct,
          durationMs,
          error: response === null ? 'API failed after 3 retries' : undefined,
        };

        // Save raw response
        const safeId = taskId.replace(/[/\\]/g, '_');
        fs.writeFileSync(
          path.join(respDir, `${safeId}.json`),
          JSON.stringify({ input: item, output: response, correct }, null, 2),
          'utf-8'
        );

        const icon = response === null ? '⚠️' : correct ? '✅' : '❌';
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

  const summary: BenchmarkSummary = {
    benchmark: bench.name,
    total: results.length,
    correct: correctCount,
    accuracy,
    totalDurationMs,
    results,
    config: bench,
  };

  // Save summary
  const summaryPath = path.join(resultDir, 'results.json');
  fs.writeFileSync(summaryPath, JSON.stringify({
    benchmark: summary.benchmark,
    total: summary.total,
    correct: summary.correct,
    accuracy: summary.accuracy,
    totalDurationMs: summary.totalDurationMs,
    config: bench,
  }, null, 2), 'utf-8');

  // Print summary
  console.log(`\n  ${'='.repeat(50)}`);
  console.log(`  ${bench.name}: ${accuracy}`);
  console.log(`  ${correctCount}/${results.length} correct`);
  console.log(`  Duration: ${(totalDurationMs / 1000).toFixed(1)}s`);
  console.log(`  Results:  ${summaryPath}`);
  console.log(`  ${'='.repeat(50)}\n`);

  return summary;
}

// ============================================================================
// CLI entry
// ============================================================================

function listConfigs(configDir?: string): string[] {
  const dir = configDir || path.join(process.cwd(), 'benchmarks', 'configs');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.endsWith('.yaml') || f.endsWith('.yml') || f.endsWith('.json'));
}

export async function main(args: string[]): Promise<void> {
  if (args.includes('--list') || args.includes('-l')) {
    const configs = listConfigs();
    if (configs.length === 0) {
      console.log('  No benchmark configs found in benchmarks/configs/');
      return;
    }
    console.log('\n  Available benchmarks:\n');
    for (const c of configs) {
      const cfg = loadConfig(path.join(process.cwd(), 'benchmarks', 'configs', c));
      console.log(`    ${c.padEnd(25)} ${cfg.benchmark.name} (${cfg.benchmark.type}, ${cfg.benchmark.format})`);
    }
    console.log();
    return;
  }

  if (args.length === 0 || args[0] === 'help' || args[0] === '--help') {
    console.log(`
  Usage:
    commander benchmark <config.yaml> [options]

  Options:
    --model <name>       Model to use (default: mimo-v2.5-pro)
    --output <dir>       Output directory (default: ./benchmarks)
    --parallel <n>       Parallel requests (default: 1)
    --max <n>            Max items to process
    --list, -l           List available benchmark configs
    --help               Show this help
`);
    return;
  }

  const configArg = args[0];
  let configPath: string;
  if (fs.existsSync(configArg)) {
    configPath = configArg;
  } else {
    configPath = path.join(process.cwd(), 'benchmarks', 'configs', configArg);
    if (!fs.existsSync(configPath)) {
      configPath = path.join(process.cwd(), 'benchmarks', configArg);
    }
  }

  if (!fs.existsSync(configPath)) {
    console.error(`  Config not found: ${configArg}`);
    process.exit(1);
  }

  const opts: RunnerOptions = {};
  const argIdx = args.indexOf('--model');
  if (argIdx !== -1 && args[argIdx + 1]) opts.model = args[argIdx + 1];
  const outIdx = args.indexOf('--output');
  if (outIdx !== -1 && args[outIdx + 1]) opts.outputDir = args[outIdx + 1];
  const parIdx = args.indexOf('--parallel');
  if (parIdx !== -1 && args[parIdx + 1]) opts.parallel = parseInt(args[parIdx + 1], 10) || 1;
  const maxIdx = args.indexOf('--max');
  if (maxIdx !== -1 && args[maxIdx + 1]) opts.maxItems = parseInt(args[maxIdx + 1], 10) || undefined;

  await runBenchmark(configPath, opts);
}

// Allow direct execution
const isMain = process.argv[1]?.endsWith('benchmarkRunner.ts');
if (isMain) {
  main(process.argv.slice(3)).catch(err => {
    console.error(`\n  Fatal: ${err.message}\n`);
    process.exit(1);
  });
}
