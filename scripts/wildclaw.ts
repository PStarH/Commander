#!/usr/bin/env npx tsx
/**
 * Commander × WildClawBench Benchmark Runner
 *
 * Runs Commander's multi-agent pipeline against WildClawBench tasks.
 * Results can be submitted as a PR to InternLM/WildClawBench.
 *
 * Usage:
 *   export OPENAI_API_KEY=sk-...
 *   npx tsx scripts/wildclaw.ts [--quick]
 *
 * Prerequisites:
 *   git clone https://github.com/InternLM/WildClawBench.git ~/commander-bench
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { AgentRuntime } from '../packages/core/src/runtime/agentRuntime';
import { OpenAIProvider } from '../packages/core/src/runtime/providers/openaiProvider';
import { getModelRouter } from '../packages/core/src/runtime/modelRouter';
import { createAllTools } from '../packages/core/src/tools/index';
import { TELOSOrchestrator } from '../packages/core/src/telos/telosOrchestrator';
import { UltimateOrchestrator } from '../packages/core/src/ultimate/orchestrator';

const IS_QUICK = process.argv.includes('--quick');
const API_KEY = process.env.OPENAI_API_KEY || '';
const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const BENCH_DIR = process.env.BENCH_DIR || path.join(os.homedir(), 'commander-bench');
const RESULTS_DIR = path.join(BENCH_DIR, 'output', 'commander');
const RESULTS_FILE = path.join(RESULTS_DIR, 'results.json');
const TASKS_DIR = path.join(BENCH_DIR, 'tasks');

interface TaskResult {
  task_id: string; category: string; name: string;
  status: 'success' | 'failed' | 'timeout';
  elapsed_seconds: number; error?: string;
  tokens: number; cost_usd: number;
}

function loadTasks(): Array<{ id: string; name: string; category: string; prompt: string; timeout: number }> {
  const categories = fs.readdirSync(TASKS_DIR).filter(d => d.startsWith('0'));
  const tasks: any[] = [];

  for (const cat of categories) {
    const catDir = path.join(TASKS_DIR, cat);
    if (!fs.statSync(catDir).isDirectory()) continue;
    const files = fs.readdirSync(catDir).filter(f => f.endsWith('.md') && !f.includes('template'));
    const taskLimit = IS_QUICK ? Math.min(1, files.length) : files.length;

    for (const file of files.slice(0, taskLimit)) {
      const content = fs.readFileSync(path.join(catDir, file), 'utf-8');

      // Parse frontmatter
      let id = file.replace('.md', ''), name = file.replace('.md', ''), timeout = 300;
      const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
      if (fmMatch) {
        for (const line of fmMatch[1].split('\n')) {
          const [k, ...v] = line.split(':');
          if (k?.trim() === 'id') id = v.join(':').trim();
          if (k?.trim() === 'name') name = v.join(':').trim();
          if (k?.trim() === 'timeout_seconds') timeout = parseInt(v.join(':').trim()) || 300;
        }
      }

      // Extract prompt
      const promptMatch = content.match(/## Prompt\n([\s\S]*?)(?=\n## |$)/);
      const prompt = promptMatch ? promptMatch[1].trim() : content.slice(0, 500);

      tasks.push({ id, name, category: cat, prompt, timeout });
    }
  }
  return tasks;
}

async function initCommander() {
  const runtime = new AgentRuntime({ budgetHardCapTokens: 2000000 });
  for (const [name, tool] of createAllTools()) runtime.registerTool(name, tool);
  runtime.registerProvider('openai', new OpenAIProvider({
    apiKey: API_KEY, baseUrl: process.env.OPENAI_BASE_URL, defaultModel: MODEL,
  }));
  const router = getModelRouter();
  for (const tier of ['eco', 'standard', 'power', 'consensus'] as const) {
    router.registerModel({
      id: `${MODEL}@${tier}`, provider: 'openai', tier,
      costPer1KInput: 0.0008, costPer1KOutput: 0.004,
      capabilities: ['code', 'reasoning', 'analysis', 'creative', 'math'],
      contextWindow: 128000, priority: -1,
    });
  }
  return new UltimateOrchestrator(new TELOSOrchestrator(runtime), runtime);
}

async function main() {
  if (!API_KEY) { console.error('ERROR: Set OPENAI_API_KEY'); process.exit(1); }
  if (!fs.existsSync(TASKS_DIR)) {
    console.error(`ERROR: WildClawBench tasks not found at ${TASKS_DIR}`);
    console.error('Run: git clone https://github.com/InternLM/WildClawBench.git ~/commander-bench');
    process.exit(1);
  }

  console.log('\n══════════════════════════════════════════════════');
  console.log('  COMMANDER × WILDCLAWBENCH');
  console.log(`  Model: ${MODEL} · Mode: ${IS_QUICK ? 'quick' : 'full'}`);
  console.log('══════════════════════════════════════════════════\n');

  const tasks = loadTasks();
  console.log(`  Tasks: ${tasks.length} (${IS_QUICK ? 'quick' : 'full'} mode)\n`);

  const orch = await initCommander();
  console.log('  Commander ready.\n');

  fs.mkdirSync(RESULTS_DIR, { recursive: true });

  const results: TaskResult[] = [];
  let totalTokens = 0, totalCost = 0, passed = 0, failed = 0;

  for (const task of tasks) {
    const t0 = Date.now();
    process.stdout.write(`  ${task.category} · ${task.name.slice(0, 50).padEnd(52)}`);

      // Set up task workspace with input files
      const taskDirName = task.id;
      const wsCategoryDir = path.join(BENCH_DIR, 'workspace', task.category);
      let taskWsDir = '';
      if (fs.existsSync(wsCategoryDir)) {
        const subDirs = fs.readdirSync(wsCategoryDir).filter(d => taskDirName.includes(d) || d.includes(taskDirName));
        if (subDirs.length > 0) {
          taskWsDir = path.join(wsCategoryDir, subDirs[0]);
        }
      }

      // Create a writable temp workspace with the task files
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-'));
      const resultsDir = path.join(tmpDir, 'results');
      fs.mkdirSync(resultsDir, { recursive: true });

      // Tasks reference /tmp_workspace/ — create symlink so it resolves
      const tmpWsLink = '/tmp_workspace';
      try {
        if (fs.existsSync(tmpWsLink)) fs.unlinkSync(tmpWsLink);
        fs.symlinkSync(tmpDir, tmpWsLink);
      } catch {
        // Fallback: create the dir directly (may not be writable)
        try { fs.mkdirSync(tmpWsLink, { recursive: true }); } catch {}
      }

      // Copy task workspace files into the temp dir
      if (taskWsDir && fs.existsSync(taskWsDir)) {
        fs.cpSync(taskWsDir, tmpDir, { recursive: true, force: true });
      }

      // Also make sure /tmp_workspace/results exists
      const tmpResults = path.join(tmpWsLink, 'results');
      try { fs.mkdirSync(tmpResults, { recursive: true }); } catch {}

      try {
        const result = await orch.execute({
          projectId: 'wildclawbench',
          agentId: 'commander',
          goal: `Working directory: ${tmpDir}\n\nIMPORTANT: All input files are at /tmp_workspace/. Save outputs to /tmp_workspace/results/.\n\n${task.prompt}`,
          contextData: {
            availableTools: ['web_search', 'web_fetch', 'file_read', 'file_write', 'file_edit', 'file_search', 'file_list', 'python_execute', 'shell_execute', 'git'],
            governanceProfile: { riskLevel: 'MEDIUM' },
          },
        });

      const elapsed = (Date.now() - t0) / 1000;
      totalTokens += result.metrics.totalTokens;
      totalCost += result.metrics.totalCostUsd;
      const status = result.status === 'SUCCESS' ? 'success' : 'failed';
      if (status === 'success') passed++; else failed++;

      console.log(`${status === 'success' ? '✅' : '❌'} ${elapsed.toFixed(0)}s $${result.metrics.totalCostUsd.toFixed(4)}`);

      results.push({
        task_id: task.id, category: task.category, name: task.name,
        status, elapsed_seconds: elapsed,
        tokens: result.metrics.totalTokens,
        cost_usd: result.metrics.totalCostUsd,
      });
    } catch (err: any) {
      failed++;
      console.log(`❌ ERROR`);
      results.push({
        task_id: task.id, category: task.category, name: task.name,
        status: 'failed', elapsed_seconds: (Date.now() - t0) / 1000,
        error: err.message?.slice(0, 200), tokens: 0, cost_usd: 0,
      });
    }

    fs.writeFileSync(RESULTS_FILE, JSON.stringify({
      config: { model: MODEL, date: new Date().toISOString(), bench: 'WildClawBench' },
      summary: { total: tasks.length, passed, failed, totalTokens, totalCost, rate: tasks.length > 0 ? (passed / tasks.length * 100).toFixed(1) + '%' : '0%' },
      results,
    }, null, 2));
  }

  const rate = tasks.length > 0 ? (passed / tasks.length * 100).toFixed(1) : '0.0';
  console.log('\n══════════════════════════════════════════════════');
  console.log('  RESULTS');
  console.log('══════════════════════════════════════════════════\n');
  console.log(`  Commander pipeline: ${passed}/${tasks.length} = ${rate}%`);
  console.log(`  Total tokens: ${totalTokens.toLocaleString()}`);
  console.log(`  Total cost: $${totalCost.toFixed(4)}\n`);
  console.log('  WildClawBench leaderboard:');
  console.log(`  MiMo V2.5 Pro (OpenClaw): 43.0% (rank #7/19)`);
  console.log(`  Commander:                ${rate}%\n`);
  console.log(`  Results saved to: ${RESULTS_FILE}`);
  console.log('══════════════════════════════════════════════════\n');
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });
