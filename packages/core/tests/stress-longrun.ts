#!/usr/bin/env npx tsx
/**
 * Long-Running Stress Test — Real LLM calls, real orchestration, real I/O.
 *
 * Runs a series of increasingly complex general-purpose tasks through
 * the full Commander pipeline for 30-60+ minutes continuously.
 * Monitors token usage, memory growth, checkpointing, and recovery.
 *
 * Usage:
 *   OPENAI_API_KEY=... OPENAI_BASE_URL=... OPENAI_MODEL=... npx tsx packages/core/tests/stress-longrun.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ── Imports ──────────────────────────────────────────────────────────────────
import { AgentRuntime } from '../src/runtime/agentRuntime';
import { TELOSOrchestrator } from '../src/telos/telosOrchestrator';
import { UltimateOrchestrator } from '../src/ultimate/orchestrator';
import { MiMoProvider } from '../src/runtime/providers/mimoProvider';
import { TokenGovernor } from '../src/runtime/tokenGovernor';
import { StateCheckpointer } from '../src/runtime/stateCheckpointer';
import { getGlobalThreeLayerMemory } from '../src/threeLayerMemory';
import { getGlobalLogger } from '../src/logging';

// ── Config ───────────────────────────────────────────────────────────────────
const API_KEY = process.env.OPENAI_API_KEY;
const BASE_URL = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
const MODEL = process.env.OPENAI_MODEL || 'gpt-4o';
const DURATION_MINUTES = parseInt(process.env.STRESS_DURATION || '30', 10);
const TASK_DELAY_MS = parseInt(process.env.STRESS_TASK_DELAY || '8000', 10);
const OUTPUT_DIR = process.env.STRESS_OUTPUT || path.join(process.cwd(), '.stress-test-output');

if (!API_KEY) {
  console.error('ERROR: OPENAI_API_KEY is required');
  process.exit(1);
}

// ── Task Definitions ─────────────────────────────────────────────────────────
// Each task is progressively more complex. The suite loops through them.
interface StressTask {
  name: string;
  goal: string;
  category: string;
  expectedMinDurationMs: number;
}

const TASKS: StressTask[] = [
  // Batch 1: Research tasks (require web search, multi-step)
  {
    name: 'research-ai-frameworks',
    goal: 'Research the top 5 AI agent frameworks in 2025 (LangGraph, CrewAI, AutoGen, Commander, Swarm). For each, find: architecture style, language, key differentiator, GitHub stars. Write a comparison table to comparison-ai-frameworks.md',
    category: 'research',
    expectedMinDurationMs: 30000,
  },
  {
    name: 'research-typescript-trends',
    goal: 'Research the latest TypeScript 5.x features and upcoming proposals. Summarize the 5 most impactful changes with code examples. Write to typescript-trends-2025.md',
    category: 'research',
    expectedMinDurationMs: 25000,
  },
  {
    name: 'research-distributed-systems',
    goal: 'Research consensus algorithms: Raft, Paxos, PBFT. Compare them on: fault tolerance, performance, complexity, use cases. Create a detailed comparison document at consensus-algorithms.md',
    category: 'research',
    expectedMinDurationMs: 30000,
  },

  // Batch 2: Analysis tasks (require reasoning, multiple passes)
  {
    name: 'analyze-codebase-architecture',
    goal: 'Analyze the packages/core/src directory structure. Identify: 1) The main subsystems and their responsibilities, 2) Key design patterns used, 3) Coupling between subsystems, 4) Potential architectural improvements. Write findings to architecture-analysis.md',
    category: 'analysis',
    expectedMinDurationMs: 40000,
  },
  {
    name: 'analyze-security-posture',
    goal: 'Review the security aspects of this codebase. Check for: 1) Input validation patterns, 2) Secret handling, 3) Dependency vulnerabilities (check package.json), 4) Injection risks in tool execution. Write a security audit to security-audit.md',
    category: 'analysis',
    expectedMinDurationMs: 35000,
  },

  // Batch 3: Creative tasks (require synthesis, multiple iterations)
  {
    name: 'write-technical-blog',
    goal: 'Write a technical blog post titled "How Commander Uses Critical Path Method to Schedule AI Agents". Include: 1) Introduction to CPM, 2) How it applies to multi-agent systems, 3) Commander\'s implementation, 4) Performance benefits, 5) Code examples. Write to blog-cpm-agents.md',
    category: 'creative',
    expectedMinDurationMs: 45000,
  },
  {
    name: 'write-architecture-decision-record',
    goal: 'Write an Architecture Decision Record (ADR) for choosing TypeScript as the primary language for Commander. Include: context, decision, consequences (positive/negative), alternatives considered. Write to adr-001-typescript.md',
    category: 'creative',
    expectedMinDurationMs: 30000,
  },

  // Batch 4: Planning tasks (require decomposition, multi-step)
  {
    name: 'plan-migration-strategy',
    goal: 'Create a migration plan for moving Commander from a monorepo to a multi-repo structure. Include: 1) Repository boundaries, 2) Dependency graph, 3) Migration phases, 4) Risk mitigation, 5) Rollback strategy. Write to migration-plan.md',
    category: 'planning',
    expectedMinDurationMs: 40000,
  },
  {
    name: 'plan-testing-strategy',
    goal: 'Design a comprehensive testing strategy for Commander. Cover: 1) Unit test priorities, 2) Integration test scenarios, 3) E2E test flows, 4) Performance benchmarks, 5) Chaos testing approach. Write to testing-strategy.md',
    category: 'planning',
    expectedMinDurationMs: 35000,
  },

  // Batch 5: Multi-concern tasks (require multiple capabilities)
  {
    name: 'multi-research-then-implement',
    goal: 'Research error handling best practices in multi-agent systems, then analyze the current error handling in packages/core/src/runtime/, identify 3 specific improvements, and write a detailed proposal with code examples to error-handling-improvements.md',
    category: 'multi',
    expectedMinDurationMs: 60000,
  },
  {
    name: 'multi-audit-and-report',
    goal: 'Audit the test coverage of packages/core/src/ultimate/ directory. For each file: list public functions, whether they have tests, and suggest missing test cases. Write a test coverage report to test-coverage-report.md',
    category: 'multi',
    expectedMinDurationMs: 50000,
  },

  // Batch 6: Deep research tasks (longest, most complex)
  {
    name: 'deep-competitive-analysis',
    goal: 'Conduct a deep competitive analysis of AI agent orchestration frameworks. Research: LangGraph (Python), CrewAI (Python), AutoGen (Python), Semantic Kernel (C#/Python). For each: architecture, strengths, weaknesses, ecosystem, pricing model. Compare with Commander on 10 dimensions. Write a comprehensive report to competitive-analysis.md',
    category: 'deep-research',
    expectedMinDurationMs: 90000,
  },
  {
    name: 'deep-technical-design',
    goal: 'Design a plugin system for Commander that supports: 1) Hot-reload of plugins, 2) Sandboxed execution, 3) Dependency resolution, 4) Version management, 5) Marketplace distribution. Write a detailed technical design document with architecture diagrams (ASCII art), API specifications, and implementation phases. Write to plugin-system-design.md',
    category: 'deep-research',
    expectedMinDurationMs: 80000,
  },
];

// ── Metrics Collector ────────────────────────────────────────────────────────
class MetricsCollector {
  private startTime = Date.now();
  private taskResults: Array<{
    name: string;
    durationMs: number;
    tokensUsed: number;
    success: boolean;
    error?: string;
    phase?: string;
  }> = [];
  private checkpoints: number = 0;
  private memorySnapshots: Array<{ time: number; heapMB: number; rssMB: number }> = [];
  private outputFile = path.join(OUTPUT_DIR, 'metrics.jsonl');

  constructor() {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    // Clear previous metrics
    fs.writeFileSync(this.outputFile, '');
  }

  recordTask(result: { name: string; durationMs: number; tokensUsed: number; success: boolean; error?: string; phase?: string }) {
    this.taskResults.push(result);
    this.appendLine({ type: 'task', ...result, timestamp: new Date().toISOString() });
  }

  recordCheckpoint() {
    this.checkpoints++;
    this.appendLine({ type: 'checkpoint', count: this.checkpoints, timestamp: new Date().toISOString() });
  }

  snapshotMemory() {
    const mem = process.memoryUsage();
    const snap = {
      time: Date.now() - this.startTime,
      heapMB: Math.round(mem.heapUsed / 1024 / 1024),
      rssMB: Math.round(mem.rss / 1024 / 1024),
    };
    this.memorySnapshots.push(snap);
    this.appendLine({ type: 'memory', ...snap });
    return snap;
  }

  getSummary() {
    const totalMs = Date.now() - this.startTime;
    const successCount = this.taskResults.filter(r => r.success).length;
    const failCount = this.taskResults.filter(r => !r.success).length;
    const totalTokens = this.taskResults.reduce((sum, r) => sum + r.tokensUsed, 0);
    const maxHeap = Math.max(...this.memorySnapshots.map(s => s.heapMB), 0);

    return {
      totalDurationMs: totalMs,
      totalDurationMin: (totalMs / 60000).toFixed(1),
      tasksCompleted: this.taskResults.length,
      tasksSucceeded: successCount,
      tasksFailed: failCount,
      totalTokensUsed: totalTokens,
      checkpointsWritten: this.checkpoints,
      maxHeapMB: maxHeap,
      memorySnapshots: this.memorySnapshots.length,
      taskBreakdown: this.taskResults.map(r => ({
        name: r.name,
        durationSec: (r.durationMs / 1000).toFixed(1),
        success: r.success,
        tokens: r.tokensUsed,
      })),
    };
  }

  private appendLine(data: unknown) {
    fs.appendFileSync(this.outputFile, JSON.stringify(data) + '\n');
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║  Commander Long-Running Stress Test                        ║');
  console.log('╠══════════════════════════════════════════════════════════════╣');
  console.log(`║  Model:     ${MODEL.padEnd(47)}║`);
  console.log(`║  Duration:  ${(DURATION_MINUTES + ' minutes').padEnd(47)}║`);
  console.log(`║  Tasks:     ${(TASKS.length + ' per cycle').padEnd(47)}║`);
  console.log(`║  Output:    ${OUTPUT_DIR.slice(0, 47).padEnd(47)}║`);
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log('');

  const metrics = new MetricsCollector();

  // Create provider
  const provider = new MiMoProvider({
    apiKey: API_KEY!,
    baseUrl: BASE_URL,
    defaultModel: MODEL,
  });

  // Create runtime
  const runtime = new AgentRuntime({
    budgetHardCapTokens: 2_000_000, // 2M tokens for stress test
    maxSteps: 20,
  });
  runtime.registerProvider('mimo', provider);
  runtime.registerProvider('openai', provider);

  // Register tools
  const { WebSearchTool, WebFetchTool } = await import('../src/tools/webSearchTool');
  const { FileReadTool, FileWriteTool, FileEditTool, FileListTool, FileSearchTool } = await import('../src/tools/fileSystemTool');
  const { GitTool } = await import('../src/tools/gitTool');

  runtime.registerTool('web_search', new WebSearchTool());
  runtime.registerTool('web_fetch', new WebFetchTool());
  runtime.registerTool('file_write', new FileWriteTool());
  runtime.registerTool('file_read', new FileReadTool());
  runtime.registerTool('file_list', new FileListTool());
  runtime.registerTool('file_edit', new FileEditTool());
  runtime.registerTool('file_search', new FileSearchTool());
  runtime.registerTool('git', new GitTool());

  // Create orchestrators
  const telos = new TELOSOrchestrator(runtime);
  const orchestrator = new UltimateOrchestrator(telos, runtime, {
    enableDeliberation: false, // MiMo struggles with JSON deliberation output
    enableReflection: true,
    maxRecursiveDepth: 1,
    maxParallelSubAgents: 1, // Sequential to avoid rate limiting
  });

  // Checkpointer for crash recovery
  const checkpointer = new StateCheckpointer(path.join(OUTPUT_DIR, 'checkpoints'));

  const deadline = Date.now() + DURATION_MINUTES * 60 * 1000;
  let cycle = 0;
  let totalTokensUsed = 0;

  console.log(`Starting stress test at ${new Date().toISOString()}`);
  console.log(`Deadline: ${new Date(deadline).toISOString()}`);
  console.log('');

  while (Date.now() < deadline) {
    cycle++;
    console.log(`\n${'═'.repeat(60)}`);
    console.log(`CYCLE ${cycle} | ${new Date().toISOString()} | Tokens: ${totalTokensUsed.toLocaleString()}`);
    console.log(`${'═'.repeat(60)}`);

    for (const task of TASKS) {
      if (Date.now() >= deadline) {
        console.log('\n⏰ Deadline reached, stopping.');
        break;
      }

      const taskStart = Date.now();
      const memBefore = process.memoryUsage().heapUsed;

      console.log(`\n┌─ Task: ${task.name} [${task.category}]`);
      console.log(`│  Goal: ${task.goal.slice(0, 80)}...`);

      try {
        const result = await orchestrator.execute({
          projectId: `stress-${cycle}`,
          agentId: `stress-agent-${task.name}`,
          goal: task.goal,
          contextData: {
            availableTools: ['web_search', 'web_fetch', 'file_write', 'file_read', 'file_list', 'file_edit', 'git'],
          },
          onProgress: (phase, detail) => {
            process.stdout.write(`│  [${phase}] ${detail.slice(0, 60)}\n`);
          },
        });

        const durationMs = Date.now() - taskStart;
        const tokens = result.metrics?.totalTokens ?? 0;
        totalTokensUsed += tokens;

        // Checkpoint after each task
        checkpointer.checkpoint({
          runId: `stress-${cycle}-${task.name}`,
          agentId: 'stress-runner',
          timestamp: new Date().toISOString(),
          phase: 'completed',
          stepNumber: 1,
          attemptNumber: 1,
          messages: [],
          tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: tokens, cachedTokens: 0 },
          stepDurations: [durationMs],
          context: {
            agentId: 'stress-runner',
            projectId: `stress-${cycle}`,
            goal: task.goal,
            availableTools: [],
            maxSteps: 20,
            tokenBudget: 2_000_000,
          },
          totalDurationMs: durationMs,
        });
        metrics.recordCheckpoint();

        metrics.recordTask({
          name: task.name,
          durationMs,
          tokensUsed: tokens,
          success: true,
          phase: result.reasoning?.[result.reasoning.length - 1] ?? 'completed',
        });

        const memAfter = process.memoryUsage().heapUsed;
        const memDeltaMB = ((memAfter - memBefore) / 1024 / 1024).toFixed(1);
        const snap = metrics.snapshotMemory();

        console.log(`│  ✅ Done in ${(durationMs / 1000).toFixed(1)}s | ${tokens.toLocaleString()} tokens | mem: ${snap.heapMB}MB (+${memDeltaMB}MB)`);
        console.log(`└─`);

        // Check if output file was created
        const outputMatch = task.goal.match(/Write\s+(?:to\s+)?(\S+\.\w+)/i);
        if (outputMatch) {
          const outputPath = path.join(process.cwd(), outputMatch[1]);
          if (fs.existsSync(outputPath)) {
            const size = fs.statSync(outputPath).size;
            console.log(`   📄 Output: ${outputMatch[1]} (${size} bytes)`);
          }
        }

      } catch (err) {
        const durationMs = Date.now() - taskStart;
        const errorMsg = err instanceof Error ? err.message : String(err);

        metrics.recordTask({
          name: task.name,
          durationMs,
          tokensUsed: 0,
          success: false,
          error: errorMsg,
        });

        console.log(`│  ❌ FAILED after ${(durationMs / 1000).toFixed(1)}s: ${errorMsg.slice(0, 100)}`);
        console.log(`└─`);
      }

      // Pause between tasks to avoid rate limiting and let memory stabilize
      await new Promise(r => setTimeout(r, TASK_DELAY_MS));
    }

    // Print cycle summary
    const summary = metrics.getSummary();
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`Cycle ${cycle} Summary:`);
    console.log(`  Tasks: ${summary.tasksSucceeded}✅ ${summary.tasksFailed}❌ | Tokens: ${summary.totalTokensUsed.toLocaleString()} | Heap: ${summary.maxHeapMB}MB`);
    console.log(`${'─'.repeat(60)}`);
  }

  // Final summary
  const finalSummary = metrics.getSummary();
  const summaryPath = path.join(OUTPUT_DIR, 'summary.json');
  fs.writeFileSync(summaryPath, JSON.stringify(finalSummary, null, 2));

  console.log(`\n${'═'.repeat(60)}`);
  console.log('STRESS TEST COMPLETE');
  console.log(`${'═'.repeat(60)}`);
  console.log(`Duration:     ${finalSummary.totalDurationMin} minutes`);
  console.log(`Tasks:        ${finalSummary.tasksCompleted} total (${finalSummary.tasksSucceeded}✅ ${finalSummary.tasksFailed}❌)`);
  console.log(`Tokens:       ${finalSummary.totalTokensUsed.toLocaleString()}`);
  console.log(`Checkpoints:  ${finalSummary.checkpointsWritten}`);
  console.log(`Peak Memory:  ${finalSummary.maxHeapMB}MB heap`);
  console.log(`Memory Snaps: ${finalSummary.memorySnapshots}`);
  console.log(`Full metrics: ${OUTPUT_DIR}/metrics.jsonl`);
  console.log(`Summary:      ${summaryPath}`);
  console.log(`${'═'.repeat(60)}`);

  // Cleanup generated files
  const cleanupPatterns = [/comparison-ai-frameworks\.md/, /typescript-trends.*\.md/, /consensus-algorithms\.md/, /architecture-analysis\.md/, /security-audit\.md/, /blog-cpm-agents\.md/, /adr-001.*\.md/, /migration-plan\.md/, /testing-strategy\.md/, /error-handling.*\.md/, /test-coverage.*\.md/, /competitive-analysis\.md/, /plugin-system.*\.md/];
  for (const file of fs.readdirSync(process.cwd())) {
    if (cleanupPatterns.some(p => p.test(file))) {
      try { fs.unlinkSync(path.join(process.cwd(), file)); } catch {}
    }
  }
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
