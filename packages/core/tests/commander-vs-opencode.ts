#!/usr/bin/env npx tsx
/**
 * Commander vs OpenCode — Fair Comparison
 *
 * Same model (mimo-v2.5), same tasks, same workspace.
 * Both are coding agents with tool use, file I/O, and web search.
 *
 * Usage:
 *   npx tsx packages/core/tests/commander-vs-opencode.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

// ── Config ───────────────────────────────────────────────────────────────────
const OUTPUT_DIR = path.join(process.cwd(), '.compare-output');

// ── Task Definitions ─────────────────────────────────────────────────────────
interface ComparisonTask {
  name: string;
  category: string;
  prompt: string;
  outputFile: string;
  minExpectedBytes: number;
}

const TASKS: ComparisonTask[] = [
  {
    name: 'research-consensus',
    category: 'research',
    prompt:
      'Research Raft vs Paxos consensus algorithms. Compare fault tolerance, performance, and complexity. Write a detailed comparison table to /tmp/compare-consensus.md',
    outputFile: '/tmp/compare-consensus.md',
    minExpectedBytes: 500,
  },
  {
    name: 'analyze-runtime',
    category: 'analysis',
    prompt:
      'Analyze the packages/core/src/runtime/ directory structure. List the main modules, their responsibilities, and key design patterns used. Write findings to /tmp/compare-runtime-analysis.md',
    outputFile: '/tmp/compare-runtime-analysis.md',
    minExpectedBytes: 500,
  },
  {
    name: 'implement-lru-cache',
    category: 'coding',
    prompt:
      'Write a TypeScript implementation of an LRU cache with get/set operations and O(1) time complexity using a doubly-linked list and Map. Include proper types and unit tests. Write to /tmp/compare-lru-cache.ts',
    outputFile: '/tmp/compare-lru-cache.ts',
    minExpectedBytes: 300,
  },
  {
    name: 'write-blog-cpm',
    category: 'creative',
    prompt:
      'Write a technical blog post about how multi-agent AI systems can use Critical Path Method for task scheduling. Include code examples and ASCII diagrams. Write to /tmp/compare-blog-cpm.md',
    outputFile: '/tmp/compare-blog-cpm.md',
    minExpectedBytes: 500,
  },
  {
    name: 'plan-migration',
    category: 'planning',
    prompt:
      'Create a migration plan for moving a TypeScript monorepo to multi-repo. Include dependency analysis, migration phases, risk mitigation, and rollback strategy. Write to /tmp/compare-migration-plan.md',
    outputFile: '/tmp/compare-migration-plan.md',
    minExpectedBytes: 500,
  },
  {
    name: 'multi-error-handling',
    category: 'multi',
    prompt:
      'Research error handling patterns in distributed systems. Then analyze the error handling in packages/core/src/runtime/ and propose 3 specific improvements with code examples. Write to /tmp/compare-error-handling.md',
    outputFile: '/tmp/compare-error-handling.md',
    minExpectedBytes: 500,
  },
];

// ── Results ──────────────────────────────────────────────────────────────────
interface TaskResult {
  system: 'commander' | 'opencode';
  taskName: string;
  category: string;
  durationMs: number;
  tokensUsed: number;
  success: boolean;
  outputSize: number;
  error?: string;
}

// ── OpenCode Runner ──────────────────────────────────────────────────────────
async function runOpenCode(task: ComparisonTask): Promise<TaskResult> {
  const start = Date.now();

  try {
    // Clean up output file
    try {
      fs.unlinkSync(task.outputFile);
    } catch {}

    // Run opencode in non-interactive mode
    const result = execSync(
      `opencode run -m "mimo/mimo-v2.5" "${task.prompt.replace(/"/g, '\\"')}"`,
      {
        timeout: 300_000, // 5 min max
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024,
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: process.cwd(),
      },
    );

    const durationMs = Date.now() - start;

    // Check output file
    let outputSize = 0;
    try {
      outputSize = fs.statSync(task.outputFile).size;
    } catch {}

    // Parse token usage from output if available
    const tokenMatch = result.match(/(\d+)\s*tokens?/i);
    const tokens = tokenMatch ? parseInt(tokenMatch[1]) : 0;

    return {
      system: 'opencode',
      taskName: task.name,
      category: task.category,
      durationMs,
      tokensUsed: tokens,
      success: outputSize >= task.minExpectedBytes,
      outputSize,
    };
  } catch (err: any) {
    const durationMs = Date.now() - start;

    // Check if output was written despite error
    let outputSize = 0;
    try {
      outputSize = fs.statSync(task.outputFile).size;
    } catch {}

    return {
      system: 'opencode',
      taskName: task.name,
      category: task.category,
      durationMs,
      tokensUsed: 0,
      success: outputSize >= task.minExpectedBytes,
      outputSize,
      error: err?.message?.slice(0, 200) || String(err).slice(0, 200),
    };
  }
}

// ── Commander Runner ─────────────────────────────────────────────────────────
async function runCommander(task: ComparisonTask): Promise<TaskResult> {
  const start = Date.now();

  try {
    // Clean up output file
    try {
      fs.unlinkSync(task.outputFile);
    } catch {}

    const { AgentRuntime } = await import('../src/runtime/agentRuntime');
    const { TELOSOrchestrator } = await import('../src/telos/telosOrchestrator');
    const { UltimateOrchestrator } = await import('../src/ultimate/orchestrator');
    const { MiMoProvider } = await import('../src/runtime/providers/mimoProvider');

    const provider = new MiMoProvider({
      apiKey: 'tp-sgmq4chswvythfusfq43fbjnn9adnhzqzzf7v99b3a9kp9pz',
      baseUrl: 'https://token-plan-sgp.xiaomimimo.com/v1',
      defaultModel: 'mimo-v2.5',
    });

    const runtime = new AgentRuntime({
      budgetHardCapTokens: 500_000,
      maxSteps: 15,
    });
    runtime.registerProvider('mimo', provider);
    runtime.registerProvider('openai', provider);

    const { WebSearchTool, WebFetchTool } = await import('../src/tools/webSearchTool');
    const { FileReadTool, FileWriteTool, FileEditTool, FileListTool, FileSearchTool } =
      await import('../src/tools/fileSystemTool');

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
      goal: task.prompt,
      contextData: {
        availableTools: [
          'web_search',
          'web_fetch',
          'file_write',
          'file_read',
          'file_list',
          'file_edit',
        ],
      },
    });

    const durationMs = Date.now() - start;
    const tokens = result.metrics?.totalTokens ?? 0;

    let outputSize = 0;
    try {
      outputSize = fs.statSync(task.outputFile).size;
    } catch {}

    return {
      system: 'commander',
      taskName: task.name,
      category: task.category,
      durationMs,
      tokensUsed: tokens,
      success: outputSize >= task.minExpectedBytes,
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

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║  Commander vs OpenCode — Head-to-Head Comparison           ║');
  console.log('╠══════════════════════════════════════════════════════════════╣');
  console.log('║  Model:     mimo-v2.5 (same for both)                      ║');
  console.log(`║  Tasks:     ${(TASKS.length + ' per system').padEnd(47)}║`);
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log('');

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const allResults: TaskResult[] = [];

  for (const task of TASKS) {
    console.log(`\n${'═'.repeat(60)}`);
    console.log(`TASK: ${task.name} [${task.category}]`);
    console.log(`${'═'.repeat(60)}`);

    // Clean up
    try {
      fs.unlinkSync(task.outputFile);
    } catch {}

    // Run OpenCode first
    console.log(`  ├─ Running OpenCode...`);
    const ocResult = await runOpenCode(task);
    allResults.push(ocResult);
    const ocOut = ocResult.success ? `${(ocResult.outputSize / 1024).toFixed(1)}KB` : 'FAIL';
    console.log(
      `  │  ${ocResult.success ? '✅' : '❌'} ${(ocResult.durationMs / 1000).toFixed(1)}s | ${ocOut}${ocResult.error ? ` | ${ocResult.error.slice(0, 60)}` : ''}`,
    );

    // Save OpenCode output
    let ocOutput = '';
    try {
      ocOutput = fs.readFileSync(task.outputFile, 'utf-8');
    } catch {}

    // Clean up
    try {
      fs.unlinkSync(task.outputFile);
    } catch {}

    // Pause
    await new Promise((r) => setTimeout(r, 5000));

    // Run Commander
    console.log(`  ├─ Running Commander...`);
    const cmdResult = await runCommander(task);
    allResults.push(cmdResult);
    const cmdOut = cmdResult.success ? `${(cmdResult.outputSize / 1024).toFixed(1)}KB` : 'FAIL';
    console.log(
      `  │  ${cmdResult.success ? '✅' : '❌'} ${(cmdResult.durationMs / 1000).toFixed(1)}s | ${cmdResult.tokensUsed.toLocaleString()} tok | ${cmdOut}${cmdResult.error ? ` | ${cmdResult.error.slice(0, 60)}` : ''}`,
    );

    // Save Commander output
    let cmdOutput = '';
    try {
      cmdOutput = fs.readFileSync(task.outputFile, 'utf-8');
    } catch {}

    // Save per-task comparison
    const comparison = {
      task: task.name,
      category: task.category,
      opencode: {
        success: ocResult.success,
        durationSec: (ocResult.durationMs / 1000).toFixed(1),
        outputBytes: ocResult.outputSize,
        outputPreview: ocOutput.slice(0, 500),
      },
      commander: {
        success: cmdResult.success,
        durationSec: (cmdResult.durationMs / 1000).toFixed(1),
        tokens: cmdResult.tokensUsed,
        outputBytes: cmdResult.outputSize,
        outputPreview: cmdOutput.slice(0, 500),
      },
    };
    fs.writeFileSync(
      path.join(OUTPUT_DIR, `${task.name}.json`),
      JSON.stringify(comparison, null, 2),
    );

    // Pause
    await new Promise((r) => setTimeout(r, 5000));
  }

  // ── Summary ──────────────────────────────────────────────────────────────
  const ocResults = allResults.filter((r) => r.system === 'opencode');
  const cmdResults = allResults.filter((r) => r.system === 'commander');

  const ocSuccess = ocResults.filter((r) => r.success).length;
  const cmdSuccess = cmdResults.filter((r) => r.success).length;
  const cmdTokens = cmdResults.reduce((s, r) => s + r.tokensUsed, 0);
  const ocTime = ocResults.reduce((s, r) => s + r.durationMs, 0);
  const cmdTime = cmdResults.reduce((s, r) => s + r.durationMs, 0);
  const ocOutput = ocResults.reduce((s, r) => s + r.outputSize, 0);
  const cmdOutput = cmdResults.reduce((s, r) => s + r.outputSize, 0);

  const summary = {
    timestamp: new Date().toISOString(),
    model: 'mimo-v2.5',
    tasksPerSystem: TASKS.length,
    opencode: {
      successRate: `${ocSuccess}/${TASKS.length}`,
      totalTimeSec: (ocTime / 1000).toFixed(1),
      avgTimeSec: (ocTime / TASKS.length / 1000).toFixed(1),
      totalOutputBytes: ocOutput,
    },
    commander: {
      successRate: `${cmdSuccess}/${TASKS.length}`,
      totalTokens: cmdTokens,
      totalTimeSec: (cmdTime / 1000).toFixed(1),
      avgTimeSec: (cmdTime / TASKS.length / 1000).toFixed(1),
      totalOutputBytes: cmdOutput,
    },
    perTask: allResults.map((r) => ({
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

  fs.writeFileSync(
    path.join(OUTPUT_DIR, 'comparison-summary.json'),
    JSON.stringify(summary, null, 2),
  );

  console.log(`\n${'═'.repeat(60)}`);
  console.log('COMPARISON RESULTS');
  console.log(`${'═'.repeat(60)}`);
  console.log('');
  console.log('                        OpenCode        Commander');
  console.log('                        ─────────        ─────────');
  console.log(
    `  Success Rate:         ${summary.opencode.successRate.padEnd(16)} ${summary.commander.successRate}`,
  );
  console.log(
    `  Total Time:           ${(summary.opencode.totalTimeSec + 's').padEnd(16)} ${summary.commander.totalTimeSec}s`,
  );
  console.log(
    `  Avg Time/Task:        ${(summary.opencode.avgTimeSec + 's').padEnd(16)} ${summary.commander.avgTimeSec}s`,
  );
  console.log(
    `  Total Tokens:         ${'N/A'.padEnd(16)} ${summary.commander.totalTokens.toLocaleString()}`,
  );
  console.log(
    `  Output Generated:     ${(summary.opencode.totalOutputBytes + ' bytes').padEnd(16)} ${summary.commander.totalOutputBytes} bytes`,
  );
  console.log('');

  console.log('Per-task comparison:');
  for (const task of TASKS) {
    const oc = allResults.find((r) => r.system === 'opencode' && r.taskName === task.name);
    const cmd = allResults.find((r) => r.system === 'commander' && r.taskName === task.name);
    console.log(`\n  ${task.name} [${task.category}]:`);
    console.log(
      `    OpenCode:  ${oc?.success ? '✅' : '❌'} ${(oc?.durationMs ?? 0) / 1000}s | ${oc?.outputSize ?? 0} bytes${oc?.error ? ` | ${oc.error.slice(0, 60)}` : ''}`,
    );
    console.log(
      `    Commander: ${cmd?.success ? '✅' : '❌'} ${(cmd?.durationMs ?? 0) / 1000}s | ${(cmd?.tokensUsed ?? 0).toLocaleString()} tok | ${cmd?.outputSize ?? 0} bytes${cmd?.error ? ` | ${cmd.error.slice(0, 60)}` : ''}`,
    );
  }

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`Full results: ${OUTPUT_DIR}/`);
  console.log(`${'═'.repeat(60)}`);

  // Cleanup
  for (const task of TASKS) {
    try {
      fs.unlinkSync(task.outputFile);
    } catch {}
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
