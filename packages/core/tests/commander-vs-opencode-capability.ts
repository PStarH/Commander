#!/usr/bin/env npx tsx
/**
 * Commander vs OpenCode — Capability Comparison
 *
 * Tests designed to showcase Commander's unique capabilities:
 * 1. Multi-agent parallel execution
 * 2. Topology selection (parallel vs sequential vs hierarchical)
 * 3. Tool orchestration (coordinating multiple tools)
 * 4. Synthesis (combining multiple agent results)
 *
 * OpenCode is single-agent; Commander can decompose and parallelize.
 * These tests exploit that difference.
 *
 * Usage:
 *   npx tsx packages/core/tests/commander-vs-opencode-capability.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

// ── Config ───────────────────────────────────────────────────────────────────
const OUTPUT_DIR = path.join(process.cwd(), '.compare-capability-output');

// ── Task Definitions ─────────────────────────────────────────────────────────
interface ComparisonTask {
  name: string;
  category: string;
  prompt: string;
  outputFile: string;
  minExpectedBytes: number;
  // Why Commander should win: explain the capability advantage
  commanderAdvantage: string;
}

const TASKS: ComparisonTask[] = [
  {
    name: 'parallel-code-review',
    category: 'parallel',
    prompt: `Review these 3 files simultaneously and produce a unified security audit:
1. packages/core/src/runtime/agentRuntime.ts — focus on input validation and injection risks
2. packages/core/src/tools/fileSystemTool.ts — focus on path traversal and symlink attacks
3. packages/core/src/ultimate/orchestrator.ts — focus on privilege escalation and sandbox escapes

For each file, identify vulnerabilities with severity ratings (CRITICAL/HIGH/MEDIUM/LOW).
Then produce a unified report with:
- Executive summary
- Top 5 most critical findings
- Recommended fixes with code examples
- Risk matrix

Write the unified audit to /tmp/compare-security-unified.md`,
    outputFile: '/tmp/compare-security-unified.md',
    minExpectedBytes: 1000,
    commanderAdvantage:
      'Commander can analyze 3 files in parallel with 3 sub-agents, then synthesize. OpenCode must do them sequentially.',
  },
  {
    name: 'multi-angle-research',
    category: 'parallel',
    prompt: `Research "TypeScript monorepo build optimization" from 3 angles simultaneously:
1. PERFORMANCE: Caching strategies (turborepo, nx, lerna), incremental builds, parallel compilation
2. DX: Developer experience improvements (hot reload, type checking, IDE support)
3. CI/CD: Pipeline optimization (matrix builds, artifact caching, test sharding)

For each angle, provide:
- Current best practices (2025-2026)
- Specific tools and configurations
- Trade-offs and limitations
- Code examples

Then synthesize all 3 angles into a unified optimization roadmap with prioritized recommendations.
Write to /tmp/compare-build-optimization.md`,
    outputFile: '/tmp/compare-build-optimization.md',
    minExpectedBytes: 1000,
    commanderAdvantage:
      'Commander can research 3 angles in parallel, then synthesize. OpenCode must research sequentially.',
  },
  {
    name: 'comparative-analysis',
    category: 'parallel',
    prompt: `Compare 3 state management approaches for a React+TypeScript app:
1. Redux Toolkit — pros/cons, boilerplate, performance, DevTools
2. Zustand — pros/cons, simplicity, TypeScript support, middleware
3. Jotai — pros/cons, atomic model, derived atoms, performance

For each approach:
- Code examples for a todo app (add, toggle, filter)
- Bundle size impact
- TypeScript type safety
- Testing approach

Then produce a decision matrix with scoring (1-10) across 8 dimensions:
bundle size, type safety, learning curve, DevTools, performance, testing, community, maintenance

Write the comparison to /tmp/compare-state-management.md`,
    outputFile: '/tmp/compare-state-management.md',
    minExpectedBytes: 1000,
    commanderAdvantage:
      'Commander can analyze 3 approaches in parallel, then synthesize a decision matrix.',
  },
  {
    name: 'multi-step-workflow',
    category: 'sequential',
    prompt: `Execute a 4-phase code improvement workflow:
1. ANALYZE: Find all TODO/FIXME comments in packages/core/src/runtime/ and categorize them
2. PRIORITIZE: Rank them by impact (performance, security, maintainability) and effort
3. IMPLEMENT: Fix the top 3 highest-priority items with actual code changes
4. VERIFY: Run type checking to ensure the changes compile

For each phase, document what you did and the results.
Write the complete workflow report to /tmp/compare-workflow-report.md`,
    outputFile: '/tmp/compare-workflow-report.md',
    minExpectedBytes: 1000,
    commanderAdvantage:
      'Commander can use sequential topology for dependent phases, with parallel sub-agents within each phase.',
  },
  {
    name: 'tool-orchestration',
    category: 'tool-heavy',
    prompt: `Perform a comprehensive codebase health check using multiple tools:
1. Use file_search to find all TypeScript files in packages/core/src/
2. Use file_read to analyze the 5 largest files
3. Use file_list to map the directory structure
4. Identify: circular dependencies, oversized files, missing types, unused exports
5. Generate a health report with:
   - File size distribution
   - Complexity hotspots
   - Type coverage gaps
   - Recommended refactoring targets

Write the health report to /tmp/compare-health-report.md`,
    outputFile: '/tmp/compare-health-report.md',
    minExpectedBytes: 1000,
    commanderAdvantage:
      'Commander can coordinate multiple tools in parallel and synthesize results. OpenCode is limited to sequential tool use.',
  },
  {
    name: 'synthesis-quality',
    category: 'synthesis',
    prompt: `Research and synthesize a comprehensive guide on "AI Agent Memory Systems":
1. Research SHORT-TERM memory: context windows, conversation history, token management
2. Research LONG-TERM memory: vector stores, knowledge graphs, episodic memory
3. Research WORKING memory: scratchpads, intermediate results, task state

For each memory type:
- Current implementations (LangChain, LlamaIndex, AutoGen)
- Architectural patterns
- Performance characteristics
- Code examples

Then synthesize all 3 into a unified architecture recommendation for building a production AI agent memory system.
Write to /tmp/compare-memory-guide.md`,
    outputFile: '/tmp/compare-memory-guide.md',
    minExpectedBytes: 1000,
    commanderAdvantage:
      'Commander can research 3 memory types in parallel, then synthesize into a unified architecture.',
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
    try {
      fs.unlinkSync(task.outputFile);
    } catch {}

    const result = execSync(
      `opencode run -m "mimo/mimo-v2.5" "${task.prompt.replace(/"/g, '\\"')}"`,
      {
        timeout: 600_000,
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024,
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: process.cwd(),
      },
    );

    const durationMs = Date.now() - start;

    let outputSize = 0;
    try {
      outputSize = fs.statSync(task.outputFile).size;
    } catch {}

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
      budgetHardCapTokens: 800_000,
      maxSteps: 20,
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
      maxRecursiveDepth: 2,
      maxParallelSubAgents: 3, // Enable parallel execution
    });

    const result = await orchestrator.execute({
      projectId: 'compare-capability',
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
          'file_search',
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
  console.log('║  Commander vs OpenCode — Capability Comparison             ║');
  console.log('╠══════════════════════════════════════════════════════════════╣');
  console.log('║  Model:     mimo-v2.5 (same for both)                      ║');
  console.log(`║  Tasks:     ${(TASKS.length + ' per system (capability-focused)').padEnd(47)}║`);
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log('');
  console.log('Capability advantages being tested:');
  for (const task of TASKS) {
    console.log(`  • ${task.name}: ${task.commanderAdvantage}`);
  }
  console.log('');

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const allResults: TaskResult[] = [];

  for (const task of TASKS) {
    console.log(`\n${'═'.repeat(60)}`);
    console.log(`TASK: ${task.name} [${task.category}]`);
    console.log(`  Commander advantage: ${task.commanderAdvantage}`);
    console.log(`${'═'.repeat(60)}`);

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

    let ocOutput = '';
    try {
      ocOutput = fs.readFileSync(task.outputFile, 'utf-8');
    } catch {}

    try {
      fs.unlinkSync(task.outputFile);
    } catch {}

    // Pause
    await new Promise((r) => setTimeout(r, 5000));

    // Run Commander
    console.log(`  ├─ Running Commander (maxParallelSubAgents=3)...`);
    const cmdResult = await runCommander(task);
    allResults.push(cmdResult);
    const cmdOut = cmdResult.success ? `${(cmdResult.outputSize / 1024).toFixed(1)}KB` : 'FAIL';
    console.log(
      `  │  ${cmdResult.success ? '✅' : '❌'} ${(cmdResult.durationMs / 1000).toFixed(1)}s | ${cmdResult.tokensUsed.toLocaleString()} tok | ${cmdOut}${cmdResult.error ? ` | ${cmdResult.error.slice(0, 60)}` : ''}`,
    );

    let cmdOutput = '';
    try {
      cmdOutput = fs.readFileSync(task.outputFile, 'utf-8');
    } catch {}

    // Save per-task comparison
    const comparison = {
      task: task.name,
      category: task.category,
      commanderAdvantage: task.commanderAdvantage,
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
    focus: 'capability (parallel execution, synthesis, tool orchestration)',
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
      parallelSubAgents: 3,
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
  console.log('CAPABILITY COMPARISON RESULTS');
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
    const winner =
      cmd?.success && !oc?.success
        ? 'Commander'
        : oc?.success && !cmd?.success
          ? 'OpenCode'
          : cmd?.success && oc?.success
            ? cmd.durationMs < oc.durationMs
              ? 'Commander (faster)'
              : 'OpenCode (faster)'
            : 'Both failed';
    console.log(`\n  ${task.name} [${task.category}]:`);
    console.log(`    Winner: ${winner}`);
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
