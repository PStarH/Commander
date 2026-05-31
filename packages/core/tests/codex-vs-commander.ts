#!/usr/bin/env npx tsx
/**
 * Head-to-head comparison: Commander vs Codex CLI
 *
 * Runs the same tasks through both systems using the same MiMo model.
 * Measures: latency, tokens, success rate, output quality.
 *
 * Usage:
 *   OPENAI_API_KEY=... OPENAI_BASE_URL=... OPENAI_MODEL=... npx tsx packages/core/tests/codex-vs-commander.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync, spawn } from 'child_process';

// ── Imports ──────────────────────────────────────────────────────────────────
import { AgentRuntime } from '../src/runtime/agentRuntime';
import { TELOSOrchestrator } from '../src/telos/telosOrchestrator';
import { UltimateOrchestrator } from '../src/ultimate/orchestrator';
import { MiMoProvider } from '../src/runtime/providers/mimoProvider';

// ── Config ───────────────────────────────────────────────────────────────────
const API_KEY = process.env.OPENAI_API_KEY;
const BASE_URL = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
const MODEL = process.env.OPENAI_MODEL || 'gpt-4o';
const OUTPUT_DIR = process.env.COMPARE_OUTPUT || path.join(process.cwd(), '.compare-output');

if (!API_KEY) {
  console.error('ERROR: OPENAI_API_KEY is required');
  process.exit(1);
}

// ── Shared Task Definitions ──────────────────────────────────────────────────
// 6 tasks spanning different categories, kept concise for fair comparison
interface ComparisonTask {
  name: string;
  category: string;
  prompt: string;
  // Codex-specific: tell it to write output to a file
  codexPrompt: string;
  // Commander-specific: goal format
  commanderGoal: string;
}

const TASKS: ComparisonTask[] = [
  {
    name: 'research-task',
    category: 'research',
    prompt: 'Research Raft vs Paxos consensus algorithms. Compare fault tolerance, performance, and complexity. Write a comparison table.',
    codexPrompt: 'Research Raft vs Paxos consensus algorithms. Compare fault tolerance, performance, and complexity. Write a comparison table to /tmp/compare-consensus.md',
    commanderGoal: 'Research Raft vs Paxos consensus algorithms. Compare fault tolerance, performance, and complexity. Write a comparison table to /tmp/compare-consensus.md',
  },
  {
    name: 'analysis-task',
    category: 'analysis',
    prompt: 'Analyze the packages/core/src/runtime/ directory. List the main modules, their responsibilities, and key design patterns used.',
    codexPrompt: 'Analyze the packages/core/src/runtime/ directory. List the main modules, their responsibilities, and key design patterns used. Write findings to /tmp/compare-runtime-analysis.md',
    commanderGoal: 'Analyze the packages/core/src/runtime/ directory. List the main modules, their responsibilities, and key design patterns used. Write findings to /tmp/compare-runtime-analysis.md',
  },
  {
    name: 'coding-task',
    category: 'coding',
    prompt: 'Write a TypeScript function that implements a LRU cache with get/set operations, O(1) time complexity, using a doubly-linked list and Map.',
    codexPrompt: 'Write a TypeScript function that implements a LRU cache with get/set operations, O(1) time complexity, using a doubly-linked list and Map. Write the implementation to /tmp/compare-lru-cache.ts with proper types and tests.',
    commanderGoal: 'Write a TypeScript function that implements a LRU cache with get/set operations, O(1) time complexity, using a doubly-linked list and Map. Write the implementation to /tmp/compare-lru-cache.ts with proper types and tests.',
  },
  {
    name: 'creative-task',
    category: 'creative',
    prompt: 'Write a technical blog post about how multi-agent AI systems can use Critical Path Method for task scheduling. Include code examples.',
    codexPrompt: 'Write a technical blog post about how multi-agent AI systems can use Critical Path Method for task scheduling. Include code examples. Write to /tmp/compare-blog-cpm.md',
    commanderGoal: 'Write a technical blog post about how multi-agent AI systems can use Critical Path Method for task scheduling. Include code examples. Write to /tmp/compare-blog-cpm.md',
  },
  {
    name: 'planning-task',
    category: 'planning',
    prompt: 'Create a migration plan for moving a TypeScript monorepo to a multi-repo structure. Include dependency analysis, phases, and rollback strategy.',
    codexPrompt: 'Create a migration plan for moving a TypeScript monorepo to a multi-repo structure. Include dependency analysis, phases, and rollback strategy. Write to /tmp/compare-migration-plan.md',
    commanderGoal: 'Create a migration plan for moving a TypeScript monorepo to a multi-repo structure. Include dependency analysis, phases, and rollback strategy. Write to /tmp/compare-migration-plan.md',
  },
  {
    name: 'multi-step-task',
    category: 'multi',
    prompt: 'Research error handling patterns in distributed systems, then identify 3 improvements for the error handling in packages/core/src/runtime/ and write a proposal with code examples.',
    codexPrompt: 'Research error handling patterns in distributed systems, then identify 3 improvements for the error handling in packages/core/src/runtime/ and write a proposal with code examples. Write to /tmp/compare-error-handling.md',
    commanderGoal: 'Research error handling patterns in distributed systems, then identify 3 improvements for the error handling in packages/core/src/runtime/ and write a proposal with code examples. Write to /tmp/compare-error-handling.md',
  },
];

// ── Results ──────────────────────────────────────────────────────────────────
interface TaskResult {
  system: 'commander' | 'codex';
  taskName: string;
  category: string;
  durationMs: number;
  tokensUsed: number;
  success: boolean;
  outputSize: number; // bytes of output file
  error?: string;
}

// ── Commander Runner ─────────────────────────────────────────────────────────
async function runCommanderTask(task: ComparisonTask): Promise<TaskResult> {
  const start = Date.now();

  try {
    const provider = new MiMoProvider({
      apiKey: API_KEY!,
      baseUrl: BASE_URL,
      defaultModel: MODEL,
    });

    const runtime = new AgentRuntime({
      budgetHardCapTokens: 500_000,
      maxSteps: 15,
    });
    runtime.registerProvider('mimo', provider);
    runtime.registerProvider('openai', provider);

    // Register tools
    const { WebSearchTool, WebFetchTool } = await import('../src/tools/webSearchTool');
    const { FileReadTool, FileWriteTool, FileEditTool, FileListTool, FileSearchTool } = await import('../src/tools/fileSystemTool');

    runtime.registerTool('web_search', new WebSearchTool());
    runtime.registerTool('web_fetch', new WebFetchTool());
    runtime.registerTool('file_write', new FileWriteTool());
    runtime.registerTool('file_read', new FileReadTool());
    runtime.registerTool('file_list', new FileListTool());
    runtime.registerTool('file_edit', new FileEditTool());
    runtime.registerTool('file_search', new FileSearchTool());

    const telos = new TELOSOrchestrator(runtime);
    const orchestrator = new UltimateOrchestrator(telos, runtime, {
      enableDeliberation: false,
      enableReflection: false,
      maxRecursiveDepth: 1,
      maxParallelSubAgents: 1,
    });

    const result = await orchestrator.execute({
      projectId: 'compare-commander',
      agentId: `compare-${task.name}`,
      goal: task.commanderGoal,
      contextData: {
        availableTools: ['web_search', 'web_fetch', 'file_write', 'file_read', 'file_list', 'file_edit'],
      },
    });

    const durationMs = Date.now() - start;
    const tokens = result.metrics?.totalTokens ?? 0;

    // Check output file
    const outputPath = `/tmp/compare-${task.name.replace(/-/g, '-')}.md`;
    let outputSize = 0;
    // Try to find the output file from the goal
    const fileMatch = task.commanderGoal.match(/Write\s+(?:to\s+)?(\/\S+\.\w+)/i);
    if (fileMatch) {
      try { outputSize = fs.statSync(fileMatch[1]).size; } catch {}
    }

    return {
      system: 'commander',
      taskName: task.name,
      category: task.category,
      durationMs,
      tokensUsed: tokens,
      success: true,
      outputSize,
    };
  } catch (err) {
    return {
      system: 'commander',
      taskName: task.name,
      category: task.category,
      durationMs: Date.now() - start,
      tokensUsed: 0,
      success: false,
      outputSize: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ── Codex CLI Runner ─────────────────────────────────────────────────────────
async function runCodexTask(task: ComparisonTask): Promise<TaskResult> {
  const start = Date.now();

  return new Promise((resolve) => {
    try {
      // Run codex exec with the same model
      const result = execSync(
        `codex exec --quiet -m "${MODEL}" "${task.codexPrompt.replace(/"/g, '\\"')}"`,
        {
          env: {
            ...process.env,
            OPENAI_API_KEY: API_KEY,
            OPENAI_BASE_URL: BASE_URL,
            OPENAI_MODEL: MODEL,
          },
          timeout: 300_000, // 5 min max per task
          encoding: 'utf-8',
          maxBuffer: 10 * 1024 * 1024, // 10MB buffer
          stdio: ['pipe', 'pipe', 'pipe'],
        }
      );

      const durationMs = Date.now() - start;

      // Check output file
      const fileMatch = task.codexPrompt.match(/Write\s+(?:to\s+)?(\/\S+\.\w+)/i);
      let outputSize = 0;
      if (fileMatch) {
        try { outputSize = fs.statSync(fileMatch[1]).size; } catch {}
      }

      // Parse token usage from codex output if available
      const tokenMatch = result.match(/(\d+)\s*tokens?/i);
      const tokens = tokenMatch ? parseInt(tokenMatch[1]) : 0;

      resolve({
        system: 'codex',
        taskName: task.name,
        category: task.category,
        durationMs,
        tokensUsed: tokens,
        success: true,
        outputSize,
      });
    } catch (err: any) {
      const durationMs = Date.now() - start;
      resolve({
        system: 'codex',
        taskName: task.name,
        category: task.category,
        durationMs,
        tokensUsed: 0,
        success: false,
        outputSize: 0,
        error: err?.message?.slice(0, 200) || String(err).slice(0, 200),
      });
    }
  });
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║  Commander vs Codex CLI — Head-to-Head Comparison          ║');
  console.log('╠══════════════════════════════════════════════════════════════╣');
  console.log(`║  Model:     ${MODEL.padEnd(47)}║`);
  console.log(`║  Tasks:     ${(TASKS.length + ' per system').padEnd(47)}║`);
  console.log(`║  Output:    ${OUTPUT_DIR.slice(0, 47).padEnd(47)}║`);
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log('');

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const allResults: TaskResult[] = [];

  // Run tasks in pairs: one Commander, one Codex, to avoid rate limiting
  for (const task of TASKS) {
    console.log(`\n${'═'.repeat(60)}`);
    console.log(`TASK: ${task.name} [${task.category}]`);
    console.log(`${'═'.repeat(60)}`);

    // Clean up output files before each task
    const fileMatch = task.codexPrompt.match(/Write\s+(?:to\s+)?(\/\S+\.\w+)/i);
    if (fileMatch) {
      try { fs.unlinkSync(fileMatch[1]); } catch {}
    }

    // Run Commander
    console.log(`\n  ├─ Running Commander...`);
    const cmdResult = await runCommanderTask(task);
    allResults.push(cmdResult);
    console.log(`  │  ${cmdResult.success ? '✅' : '❌'} ${cmdResult.durationMs / 1000}s | ${cmdResult.tokensUsed.toLocaleString()} tokens | ${cmdResult.outputSize} bytes`);

    // Pause between tests
    await new Promise(r => setTimeout(r, 5000));

    // Clean up output files
    if (fileMatch) {
      try { fs.unlinkSync(fileMatch[1]); } catch {}
    }

    // Run Codex CLI
    console.log(`  ├─ Running Codex CLI...`);
    const codexResult = await runCodexTask(task);
    allResults.push(codexResult);
    console.log(`  │  ${codexResult.success ? '✅' : '❌'} ${codexResult.durationMs / 1000}s | ${codexResult.tokensUsed.toLocaleString()} tokens | ${codexResult.outputSize} bytes${codexResult.error ? ` | ERR: ${codexResult.error.slice(0, 60)}` : ''}`);

    // Pause between tasks
    await new Promise(r => setTimeout(r, 5000));
  }

  // ── Summary ──────────────────────────────────────────────────────────────
  const commanderResults = allResults.filter(r => r.system === 'commander');
  const codexResults = allResults.filter(r => r.system === 'codex');

  const cmdSuccess = commanderResults.filter(r => r.success).length;
  const codexSuccess = codexResults.filter(r => r.success).length;
  const cmdTokens = commanderResults.reduce((s, r) => s + r.tokensUsed, 0);
  const codexTokens = codexResults.reduce((s, r) => s + r.tokensUsed, 0);
  const cmdTime = commanderResults.reduce((s, r) => s + r.durationMs, 0);
  const codexTime = codexResults.reduce((s, r) => s + r.durationMs, 0);
  const cmdOutput = commanderResults.reduce((s, r) => s + r.outputSize, 0);
  const codexOutput = codexResults.reduce((s, r) => s + r.outputSize, 0);

  const summary = {
    model: MODEL,
    tasksPerSystem: TASKS.length,
    commander: {
      successRate: `${cmdSuccess}/${TASKS.length}`,
      totalTokens: cmdTokens,
      totalTimeSec: (cmdTime / 1000).toFixed(1),
      avgTimeSec: (cmdTime / TASKS.length / 1000).toFixed(1),
      totalOutputBytes: cmdOutput,
    },
    codex: {
      successRate: `${codexSuccess}/${TASKS.length}`,
      totalTokens: codexTokens,
      totalTimeSec: (codexTime / 1000).toFixed(1),
      avgTimeSec: (codexTime / TASKS.length / 1000).toFixed(1),
      totalOutputBytes: codexOutput,
    },
    perTask: allResults.map(r => ({
      system: r.system,
      task: r.taskName,
      category: r.category,
      success: r.success,
      durationSec: (r.durationMs / 1000).toFixed(1),
      tokens: r.tokensUsed,
      outputBytes: r.outputSize,
      error: r.error?.slice(0, 100),
    })),
  };

  fs.writeFileSync(path.join(OUTPUT_DIR, 'comparison.json'), JSON.stringify(summary, null, 2));

  console.log(`\n${'═'.repeat(60)}`);
  console.log('COMPARISON RESULTS');
  console.log(`${'═'.repeat(60)}`);
  console.log('');
  console.log('                    Commander        Codex CLI');
  console.log('                    ─────────        ─────────');
  console.log(`  Success Rate:     ${summary.commander.successRate.padEnd(16)} ${summary.codex.successRate}`);
  console.log(`  Total Tokens:     ${String(summary.commander.totalTokens).padEnd(16)} ${summary.codex.totalTokens}`);
  console.log(`  Total Time:       ${(summary.commander.totalTimeSec + 's').padEnd(16)} ${summary.codex.totalTimeSec}s`);
  console.log(`  Avg Time/Task:    ${(summary.commander.avgTimeSec + 's').padEnd(16)} ${summary.codex.avgTimeSec}s`);
  console.log(`  Output Generated: ${(summary.commander.totalOutputBytes + ' bytes').padEnd(16)} ${summary.codex.totalOutputBytes} bytes`);
  console.log('');

  console.log('Per-task comparison:');
  for (const task of TASKS) {
    const cmd = allResults.find(r => r.system === 'commander' && r.taskName === task.name);
    const codex = allResults.find(r => r.system === 'codex' && r.taskName === task.name);
    console.log(`\n  ${task.name} [${task.category}]:`);
    console.log(`    Commander: ${cmd?.success ? '✅' : '❌'} ${(cmd?.durationMs ?? 0) / 1000}s | ${(cmd?.tokensUsed ?? 0).toLocaleString()} tokens | ${cmd?.outputSize ?? 0} bytes`);
    console.log(`    Codex:     ${codex?.success ? '✅' : '❌'} ${(codex?.durationMs ?? 0) / 1000}s | ${(codex?.tokensUsed ?? 0).toLocaleString()} tokens | ${codex?.outputSize ?? 0} bytes${codex?.error ? ` | ERR: ${codex.error.slice(0, 60)}` : ''}`);
  }

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`Full results: ${OUTPUT_DIR}/comparison.json`);
  console.log(`${'═'.repeat(60)}`);

  // Cleanup
  for (const task of TASKS) {
    const fileMatch = task.codexPrompt.match(/Write\s+(?:to\s+)?(\/\S+\.\w+)/i);
    if (fileMatch) {
      try { fs.unlinkSync(fileMatch[1]); } catch {}
    }
  }
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
