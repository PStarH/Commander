#!/usr/bin/env npx tsx
/**
 * SWE-bench Runner — Commander Multi-Agent Pipeline
 *
 * Runs SWE-bench tasks through Commander's multi-agent system:
 * Planner → Localizer → Coder → Tester (with retry)
 *
 * Usage:
 *   npx tsx benchmarks/swebench/run_swebench_commander.ts [--max N] [--subset verified|lite|full] [--dry-run]
 *
 * Output:
 *   benchmarks/swebench/predictions.jsonl — ready for swebench evaluation
 *   benchmarks/swebench/results.json — summary statistics
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

// ── Load .env ────────────────────────────────────────────────────────────────
function loadEnv(): void {
  let dir = process.cwd();
  for (let i = 0; i < 5; i++) {
    const envPath = path.join(dir, '.env');
    if (fs.existsSync(envPath)) {
      for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx === -1) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        const val = trimmed.slice(eqIdx + 1).trim();
        if (key && val && !process.env[key]) process.env[key] = val;
      }
      return;
    }
    dir = path.dirname(dir);
  }
}
loadEnv();

// ── Config ───────────────────────────────────────────────────────────────────
import { createSWEBenchAgent, type SWEInstance, type SWEResult } from './swebench_agent';

const BASE_URL = process.env.OPENAI_BASE_URL || process.env.MIMO_BASE_URL || 'https://token-plan-sgp.xiaomimimo.com/v1';
const API_KEY = process.env.OPENAI_API_KEY || process.env.MIMO_API_KEY || '';
const MODEL = process.env.OPENAI_MODEL || process.env.MIMO_MODEL || 'mimo-v2.5-pro';

const DATASETS: Record<string, string> = {
  verified: 'princeton-nlp/SWE-bench_Verified',
  lite: 'princeton-nlp/SWE-bench_Lite',
  full: 'princeton-nlp/SWE-bench',
};

// ── Args ─────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const maxInstances = parseInt(args.find((_, i, a) => a[i - 1] === '--max') || '500');
const subset = args.find((_, i, a) => a[i - 1] === '--subset') || 'verified';
const dryRun = args.includes('--dry-run');
const datasetPath = args.find((_, i, a) => a[i - 1] === '--dataset') || '';
const outputDir = path.join(__dirname, 'results');
const predictionsPath = path.join(outputDir, 'predictions.jsonl');
const resultsPath = path.join(outputDir, 'results.json');

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n🚀 SWE-bench Commander Runner`);
  console.log(`   Model: ${MODEL}`);
  console.log(`   Subset: ${subset}`);
  console.log(`   Max instances: ${maxInstances}`);
  console.log(`   Dry run: ${dryRun}\n`);

  if (!API_KEY) {
    console.error('❌ No API key found. Set OPENAI_API_KEY or MIMO_API_KEY in .env');
    process.exit(1);
  }

  // Load dataset
  const instances = await loadDataset(datasetPath || undefined);
  const toRun = instances.slice(0, maxInstances);
  console.log(`📋 Loaded ${instances.length} instances, running ${toRun.length}\n`);

  if (dryRun) {
    console.log('🔍 Dry run — showing first 3 instances:');
    for (const inst of toRun.slice(0, 3)) {
      console.log(`  - ${inst.instance_id}: ${inst.problem_statement.slice(0, 100)}...`);
    }
    return;
  }

  // Setup output
  fs.mkdirSync(outputDir, { recursive: true });
  const predictionsStream = fs.createWriteStream(predictionsPath, { flags: 'a' });

  // Create agent
  const agent = createSWEBenchAgent(BASE_URL, API_KEY, MODEL);

  // Run instances
  const results: SWEResult[] = [];
  let resolved = 0;
  let failed = 0;
  let errors = 0;
  const startTime = Date.now();

  for (let i = 0; i < toRun.length; i++) {
    const instance = toRun[i];
    const progress = `[${i + 1}/${toRun.length}]`;

    process.stdout.write(`${progress} ${instance.instance_id}...`);

    try {
      // Create a temporary repo directory for this instance
      const repoDir = `/tmp/swebench_${instance.instance_id.replace(/[^a-zA-Z0-9]/g, '_')}`;

      // Clone and checkout the repo at the base commit
      await setupRepo(instance, repoDir);

      // Run the agent
      const result = await agent.solve(instance, repoDir);

      results.push(result);

      // Write prediction in SWE-bench format
      const prediction = {
        instance_id: instance.instance_id,
        model_name_or_path: 'commander-swebench',
        model_patch: result.model_patch,
      };
      predictionsStream.write(JSON.stringify(prediction) + '\n');

      // Update counters
      if (result.status === 'resolved') {
        resolved++;
        console.log(` ✅ (${result.duration_ms}ms, ${result.tokens_used} tokens)`);
      } else if (result.status === 'error') {
        errors++;
        console.log(` ❌ ERROR (${result.duration_ms}ms)`);
      } else {
        failed++;
        console.log(` ❌ (${result.duration_ms}ms, ${result.tokens_used} tokens)`);
      }

      // Cleanup
      await cleanupRepo(repoDir);

      // Progress report every 10 instances
      if ((i + 1) % 10 === 0) {
        const elapsed = (Date.now() - startTime) / 1000;
        const rate = (i + 1) / elapsed;
        const eta = (toRun.length - i - 1) / rate;
        console.log(`\n📊 Progress: ${resolved}/${i + 1} resolved (${((resolved / (i + 1)) * 100).toFixed(1)}%) | ETA: ${(eta / 60).toFixed(0)} min\n`);
      }
    } catch (error: any) {
      errors++;
      console.log(` ❌ EXCEPTION: ${error.message?.slice(0, 100)}`);
    }
  }

  predictionsStream.end();

  // Final summary
  const totalDuration = Date.now() - startTime;
  const summary = {
    benchmark: 'swebench',
    subset,
    model: MODEL,
    total: toRun.length,
    resolved,
    failed,
    errors,
    resolve_rate: `${((resolved / toRun.length) * 100).toFixed(1)}%`,
    total_tokens: results.reduce((sum, r) => sum + r.tokens_used, 0),
    total_duration_ms: totalDuration,
    avg_duration_ms: Math.round(totalDuration / toRun.length),
    timestamp: new Date().toISOString(),
  };

  fs.writeFileSync(resultsPath, JSON.stringify(summary, null, 2));

  console.log(`\n${'='.repeat(60)}`);
  console.log(`📊 SWE-bench Results (${subset})`);
  console.log(`${'='.repeat(60)}`);
  console.log(`  Resolved:   ${resolved}/${toRun.length} (${summary.resolve_rate})`);
  console.log(`  Failed:     ${failed}`);
  console.log(`  Errors:     ${errors}`);
  console.log(`  Total time: ${(totalDuration / 60000).toFixed(1)} min`);
  console.log(`  Avg time:   ${summary.avg_duration_ms}ms per instance`);
  console.log(`  Total tok:  ${summary.total_tokens.toLocaleString()}`);
  console.log(`\n  Predictions: ${predictionsPath}`);
  console.log(`  Results:     ${resultsPath}`);
  console.log(`${'='.repeat(60)}\n`);
}

// ── Dataset Loading ──────────────────────────────────────────────────────────

async function loadDataset(overridePath?: string): Promise<SWEInstance[]> {
  if (overridePath && fs.existsSync(overridePath)) {
    return JSON.parse(fs.readFileSync(overridePath, 'utf-8'));
  }

  // Try to load from HuggingFace datasets cache
  const cacheDir = path.join(process.env.HOME || '~', '.cache', 'huggingface', 'datasets');
  const datasetName = DATASETS[subset] || DATASETS.verified;

  // Try local dataset file first
  const localPath = path.join(__dirname, 'dataset.json');
  if (fs.existsSync(localPath)) {
    return JSON.parse(fs.readFileSync(localPath, 'utf-8'));
  }

  // Try to download from HuggingFace
  console.log(`📥 Downloading ${datasetName} from HuggingFace...`);
  try {
    const response = await fetch(
      `https://huggingface.co/datasets/${datasetName}/resolve/main/data/test.jsonl`
    );
    if (response.ok) {
      const text = await response.text();
      const instances = text.split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
      // Save locally for future runs
      fs.writeFileSync(localPath, JSON.stringify(instances, null, 2));
      console.log(`  ✅ Downloaded ${instances.length} instances`);
      return instances;
    }
  } catch (e: any) {
    console.log(`  ⚠️ Download failed: ${e.message}`);
  }

  // Fallback: look for any existing dataset
  const fallbackPaths = [
    // GAIA dataset removed
    path.join(__dirname, 'dataset.jsonl'),
  ];
  for (const p of fallbackPaths) {
    if (fs.existsSync(p)) {
      console.log(`  Using fallback dataset: ${p}`);
      return fs.readFileSync(p, 'utf-8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
    }
  }

  console.error('❌ No dataset found. Provide --dataset <path> or place dataset.json in benchmarks/swebench/');
  process.exit(1);
}

// ── Repo Setup ───────────────────────────────────────────────────────────────

async function setupRepo(instance: SWEInstance, repoDir: string): Promise<void> {
  const { execSync } = await import('child_process');

  // Clean up any existing directory
  execSync(`rm -rf ${repoDir}`, { stdio: 'ignore' });

  // Clone the repo
  const repoUrl = `https://github.com/${instance.repo}.git`;
  execSync(`git clone --depth 1 ${repoUrl} ${repoDir}`, {
    stdio: 'ignore',
    timeout: 60000,
  });

  // Checkout the base commit
  if (instance.base_commit) {
    execSync(`cd ${repoDir} && git fetch --depth 1 origin ${instance.base_commit} && git checkout ${instance.base_commit}`, {
      stdio: 'ignore',
      timeout: 30000,
    });
  }
}

async function cleanupRepo(repoDir: string): Promise<void> {
  try {
    const { execSync } = await import('child_process');
    execSync(`rm -rf ${repoDir}`, { stdio: 'ignore' });
  } catch { /* ignore cleanup errors */ }
}

// ── Run ──────────────────────────────────────────────────────────────────────

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
