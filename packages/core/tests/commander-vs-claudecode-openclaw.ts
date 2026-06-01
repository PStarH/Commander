#!/usr/bin/env npx tsx
/**
 * Commander vs Claude Code vs OpenClaw — General-Purpose Agent Comparison
 *
 * Tests designed to compare three general-purpose AI agents:
 * 1. Commander — multi-agent TypeScript framework (mimo-v2.5-pro)
 * 2. Claude Code — single-agent CLI (mimo-v2.5-pro via Anthropic proxy)
 * 3. OpenClaw — personal assistant with agent capabilities
 *
 * Focus: General-purpose capabilities (research, analysis, planning, coding)
 *
 * Usage:
 *   npx tsx packages/core/tests/commander-vs-claudecode-openclaw.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

// ── Config ───────────────────────────────────────────────────────────────────
const OUTPUT_DIR = path.join(process.cwd(), '.compare-three-output');
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

// ── Task Definitions ─────────────────────────────────────────────────────────
interface ComparisonTask {
  name: string;
  category: string;
  outputFile: string;
  prompt: string;
  minExpectedBytes: number;
}

const TASKS: ComparisonTask[] = [
  {
    name: 'market-research',
    category: 'research',
    outputFile: '/tmp/compare-three-market.md',
    minExpectedBytes: 2000,
    prompt: `Research the AI agent framework market in 2026:
1. Identify the top 5 frameworks (LangGraph, CrewAI, AutoGen, etc.)
2. Compare their architectures, strengths, and weaknesses
3. Analyze market trends and growth projections
4. Identify gaps and opportunities for Commander
5. Provide strategic recommendations

Write a comprehensive market research report to /tmp/compare-three-market.md with:
- Executive summary
- Competitive landscape
- Market sizing and trends
- SWOT analysis for Commander
- Strategic recommendations`,
  },
  {
    name: 'technical-analysis',
    category: 'analysis',
    outputFile: '/tmp/compare-three-tech.md',
    minExpectedBytes: 2000,
    prompt: `Analyze the Commander codebase architecture:
1. Map the module dependency graph
2. Identify architectural patterns (orchestrator, agent runtime, tools)
3. Evaluate code quality metrics (coupling, cohesion, complexity)
4. Compare with industry best practices
5. Suggest architectural improvements

Write a technical analysis report to /tmp/compare-three-tech.md with:
- Architecture overview
- Module dependency diagram (ASCII)
- Code quality assessment
- Improvement recommendations
- Risk assessment`,
  },
  {
    name: 'product-planning',
    category: 'planning',
    outputFile: '/tmp/compare-three-product.md',
    minExpectedBytes: 2000,
    prompt: `Create a product roadmap for Commander v1.0:
1. Define the target user personas
2. Identify must-have features for v1.0
3. Prioritize features using RICE framework
4. Create a 6-month timeline
5. Define success metrics and KPIs

Write a product roadmap to /tmp/compare-three-product.md with:
- Vision and mission
- User personas
- Feature prioritization matrix
- Timeline with milestones
- Success metrics`,
  },
  {
    name: 'security-audit',
    category: 'analysis',
    outputFile: '/tmp/compare-three-security.md',
    minExpectedBytes: 2000,
    prompt: `Perform a security audit on the Commander codebase:
1. packages/core/src/runtime/agentRuntime.ts — eval injection, sandbox escapes
2. packages/core/src/tools/fileSystemTool.ts — path traversal, symlink attacks
3. packages/core/src/ultimate/orchestrator.ts — privilege escalation

For each file:
- Read the full source code
- Identify vulnerabilities with severity (CRITICAL/HIGH/MEDIUM/LOW)
- Provide line numbers and code examples
- Suggest fixes

Write the unified audit report to /tmp/compare-three-security.md`,
  },
  {
    name: 'documentation',
    category: 'writing',
    outputFile: '/tmp/compare-three-docs.md',
    minExpectedBytes: 2000,
    prompt: `Write comprehensive documentation for Commander:
1. Getting started guide
2. Architecture overview
3. API reference for key modules
4. Best practices and patterns
5. Troubleshooting guide

Write the documentation to /tmp/compare-three-docs.md with:
- Clear structure with table of contents
- Code examples for each concept
- Common pitfalls and solutions
- Performance optimization tips`,
  },
];

// ── System Runners ───────────────────────────────────────────────────────────

interface TaskResult {
  system: string;
  task: string;
  success: boolean;
  durationSec: number;
  outputBytes: number;
  tokens: number;
  outputPreview: string;
  error?: string;
}

async function runCommander(task: ComparisonTask): Promise<TaskResult> {
  const start = Date.now();
  try {
    try { fs.unlinkSync(task.outputFile); } catch {}

    const { AgentRuntime } = await import('../src/runtime/agentRuntime');
    const { TELOSOrchestrator } = await import('../src/telos/telosOrchestrator');
    const { UltimateOrchestrator } = await import('../src/ultimate/orchestrator');
    const { MiMoProvider } = await import('../src/runtime/providers/mimoProvider');

    const provider = new MiMoProvider({
      apiKey: 'tp-sfcjofksj8sn63244lzc1hxzzb8mz03hty5afetx0aafsetx',
      baseUrl: 'https://token-plan-sgp.xiaomimimo.com/v1',
      defaultModel: 'mimo-v2.5-pro',
    });

    const runtime = new AgentRuntime({
      budgetHardCapTokens: 800_000,
      maxSteps: 20,
    });
    runtime.registerProvider('mimo', provider);
    runtime.registerProvider('openai', provider);

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
      maxRecursiveDepth: 2,
      maxParallelSubAgents: 3,
    });

    const result = await orchestrator.execute({
      projectId: 'compare-three',
      agentId: `compare-${task.name}`,
      goal: task.prompt,
      contextData: {
        availableTools: ['web_search', 'web_fetch', 'file_write', 'file_read', 'file_list', 'file_edit', 'file_search'],
      },
    });

    const durationMs = Date.now() - start;
    const tokens = result.metrics?.totalTokens ?? 0;
    let outputSize = 0;
    try { outputSize = fs.statSync(task.outputFile).size; } catch {}
    const preview = fs.existsSync(task.outputFile) ? fs.readFileSync(task.outputFile, 'utf-8').slice(0, 200) : '';

    return {
      system: 'commander',
      task: task.name,
      success: outputSize >= task.minExpectedBytes,
      durationSec: durationMs / 1000,
      outputBytes: outputSize,
      tokens,
      outputPreview: preview,
    };
  } catch (e: any) {
    return {
      system: 'commander',
      task: task.name,
      success: false,
      durationSec: (Date.now() - start) / 1000,
      outputBytes: 0,
      tokens: 0,
      outputPreview: '',
      error: e.message?.slice(0, 200),
    };
  }
}

async function runClaudeCode(task: ComparisonTask): Promise<TaskResult> {
  const start = Date.now();
  try {
    try { fs.unlinkSync(task.outputFile); } catch {}

    const prompt = task.prompt + '\n\nIMPORTANT: You MUST write the output to the specified file using the Write tool. Do not just describe what you would do — actually write the file.';

    const result = execSync(
      `claude -p ${JSON.stringify(prompt)} --allowedTools "Bash,Read,Write,Edit,Glob,Grep,WebSearch,WebFetch" --permission-mode bypassPermissions 2>&1`,
      {
        encoding: 'utf-8',
        timeout: 600000,
        cwd: process.cwd(),
        maxBuffer: 10 * 1024 * 1024,
      }
    );

    const durationSec = (Date.now() - start) / 1000;
    const outputBytes = fs.existsSync(task.outputFile) ? fs.statSync(task.outputFile).size : 0;
    const preview = fs.existsSync(task.outputFile) ? fs.readFileSync(task.outputFile, 'utf-8').slice(0, 200) : result.slice(0, 200);

    return {
      system: 'claude-code',
      task: task.name,
      success: outputBytes >= task.minExpectedBytes,
      durationSec,
      outputBytes,
      tokens: 0,
      outputPreview: preview,
    };
  } catch (e: any) {
    return {
      system: 'claude-code',
      task: task.name,
      success: false,
      durationSec: (Date.now() - start) / 1000,
      outputBytes: 0,
      tokens: 0,
      outputPreview: '',
      error: e.message?.slice(0, 200),
    };
  }
}

async function runOpenClaw(task: ComparisonTask): Promise<TaskResult> {
  const start = Date.now();
  try {
    try { fs.unlinkSync(task.outputFile); } catch {}

    const prompt = task.prompt + '\n\nIMPORTANT: You MUST write the output to the specified file. Do not just describe what you would do — actually write the file.';

    const sessionId = `compare-${task.name}-${Date.now()}`;
    const result = execSync(
      `openclaw agent --session-id ${sessionId} -m ${JSON.stringify(prompt)} --local --timeout 300 --json 2>&1`,
      {
        encoding: 'utf-8',
        timeout: 310000,
        cwd: process.cwd(),
        maxBuffer: 10 * 1024 * 1024,
      }
    );

    const durationSec = (Date.now() - start) / 1000;
    const outputBytes = fs.existsSync(task.outputFile) ? fs.statSync(task.outputFile).size : 0;
    const preview = fs.existsSync(task.outputFile) ? fs.readFileSync(task.outputFile, 'utf-8').slice(0, 200) : result.slice(0, 200);

    return {
      system: 'openclaw',
      task: task.name,
      success: outputBytes >= task.minExpectedBytes,
      durationSec,
      outputBytes,
      tokens: 0,
      outputPreview: preview,
    };
  } catch (e: any) {
    return {
      system: 'openclaw',
      task: task.name,
      success: false,
      durationSec: (Date.now() - start) / 1000,
      outputBytes: 0,
      tokens: 0,
      outputPreview: '',
      error: e.message?.slice(0, 200),
    };
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║  Commander vs Claude Code vs OpenClaw — General Agent Test ║');
  console.log('╠══════════════════════════════════════════════════════════════╣');
  console.log('║  Model:     mimo-v2.5-pro (Commander & Claude Code)        ║');
  console.log('║  Tasks:     5 per system (research, analysis, planning)     ║');
  console.log('║  Focus:     General-purpose agent capabilities              ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  const allResults: TaskResult[] = [];

  for (const task of TASKS) {
    console.log(`\n${'═'.repeat(60)}`);
    console.log(`TASK: ${task.name} [${task.category}]`);
    console.log(`${'═'.repeat(60)}`);

    // Run all three systems
    console.log('  ├─ Running Commander...');
    const commanderResult = await runCommander(task);
    const cmdStatus = commanderResult.success ? '✅' : '❌';
    console.log(`  │  ${cmdStatus} ${commanderResult.durationSec.toFixed(1)}s | ${commanderResult.outputBytes} bytes`);
    allResults.push(commanderResult);

    console.log('  ├─ Running Claude Code...');
    const claudeResult = await runClaudeCode(task);
    const claudeStatus = claudeResult.success ? '✅' : '❌';
    console.log(`  │  ${claudeStatus} ${claudeResult.durationSec.toFixed(1)}s | ${claudeResult.outputBytes} bytes`);
    allResults.push(claudeResult);

    console.log('  ├─ Running OpenClaw...');
    const openclawResult = await runOpenClaw(task);
    const openclawStatus = openclawResult.success ? '✅' : '❌';
    console.log(`  │  ${openclawStatus} ${openclawResult.durationSec.toFixed(1)}s | ${openclawResult.outputBytes} bytes`);
    allResults.push(openclawResult);
  }

  // ── Summary ──────────────────────────────────────────────────────────────
  const commanderResults = allResults.filter(r => r.system === 'commander');
  const claudeResults = allResults.filter(r => r.system === 'claude-code');
  const openclawResults = allResults.filter(r => r.system === 'openclaw');

  const commanderSuccess = commanderResults.filter(r => r.success).length;
  const claudeSuccess = claudeResults.filter(r => r.success).length;
  const openclawSuccess = openclawResults.filter(r => r.success).length;

  const commanderOutput = commanderResults.reduce((s, r) => s + r.outputBytes, 0);
  const claudeOutput = claudeResults.reduce((s, r) => s + r.outputBytes, 0);
  const openclawOutput = openclawResults.reduce((s, r) => s + r.outputBytes, 0);

  const commanderTime = commanderResults.reduce((s, r) => s + r.durationSec, 0);
  const claudeTime = claudeResults.reduce((s, r) => s + r.durationSec, 0);
  const openclawTime = openclawResults.reduce((s, r) => s + r.durationSec, 0);

  console.log(`\n${'═'.repeat(60)}`);
  console.log('CAPABILITY COMPARISON RESULTS');
  console.log(`${'═'.repeat(60)}\n`);

  console.log('                        Commander    Claude Code  OpenClaw');
  console.log('                        ─────────    ───────────  ────────');
  console.log(`  Success Rate:         ${commanderSuccess}/${TASKS.length}            ${claudeSuccess}/${TASKS.length}           ${openclawSuccess}/${TASKS.length}`);
  console.log(`  Total Time:           ${commanderTime.toFixed(0)}s           ${claudeTime.toFixed(0)}s          ${openclawTime.toFixed(0)}s`);
  console.log(`  Avg Time/Task:        ${(commanderTime / TASKS.length).toFixed(0)}s           ${(claudeTime / TASKS.length).toFixed(0)}s          ${(openclawTime / TASKS.length).toFixed(0)}s`);
  console.log(`  Output Generated:     ${commanderOutput} bytes   ${claudeOutput} bytes  ${openclawOutput} bytes`);

  console.log('\nPer-task comparison:\n');
  for (const task of TASKS) {
    const cmd = allResults.find(r => r.system === 'commander' && r.task === task.name)!;
    const claude = allResults.find(r => r.system === 'claude-code' && r.task === task.name)!;
    const openclaw = allResults.find(r => r.system === 'openclaw' && r.task === task.name)!;

    const winner = cmd.success && !claude.success && !openclaw.success ? 'Commander'
      : !cmd.success && claude.success && !openclaw.success ? 'Claude Code'
      : !cmd.success && !claude.success && openclaw.success ? 'OpenClaw'
      : cmd.success && claude.success && openclaw.success ? 'All pass'
      : 'Partial';

    console.log(`  ${task.name} [${task.category}]:`);
    console.log(`    Winner: ${winner}`);
    console.log(`    Commander:    ${cmd.success ? '✅' : '❌'} ${cmd.durationSec.toFixed(1)}s | ${cmd.outputBytes} bytes${cmd.error ? ' | ' + cmd.error : ''}`);
    console.log(`    Claude Code:  ${claude.success ? '✅' : '❌'} ${claude.durationSec.toFixed(1)}s | ${claude.outputBytes} bytes${claude.error ? ' | ' + claude.error : ''}`);
    console.log(`    OpenClaw:     ${openclaw.success ? '✅' : '❌'} ${openclaw.durationSec.toFixed(1)}s | ${openclaw.outputBytes} bytes${openclaw.error ? ' | ' + openclaw.error : ''}`);
    console.log('');
  }

  // Save results
  const summary = {
    timestamp: new Date().toISOString(),
    model: 'mimo-v2.5-pro',
    tasksPerSystem: TASKS.length,
    focus: 'general-purpose agent capabilities',
    commander: { successRate: `${commanderSuccess}/${TASKS.length}`, totalTimeSec: commanderTime.toFixed(0), totalOutputBytes: commanderOutput },
    claudeCode: { successRate: `${claudeSuccess}/${TASKS.length}`, totalTimeSec: claudeTime.toFixed(0), totalOutputBytes: claudeOutput },
    openclaw: { successRate: `${openclawSuccess}/${TASKS.length}`, totalTimeSec: openclawTime.toFixed(0), totalOutputBytes: openclawOutput },
    perTask: allResults,
  };
  fs.writeFileSync(path.join(OUTPUT_DIR, 'comparison-summary.json'), JSON.stringify(summary, null, 2));
  console.log(`\nFull results: ${OUTPUT_DIR}`);
}

main().catch(console.error);
