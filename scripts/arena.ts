#!/usr/bin/env npx tsx
/**
 * Commander Arena — 多Agent竞技场
 *
 * 并行调度多名Agent同时执行不同任务，展示Commander的核心优势。
 * OpenClaw/Hermes一个时间只能做一个task，Commander能做N个。
 */
import * as fs from 'fs';
const AR = require('../packages/core/src/runtime/agentRuntime');
const OP = require('../packages/core/src/runtime/providers/openaiProvider');
const { createAllTools } = require('../packages/core/src/tools/index');
const { TaskPool } = require('../packages/core/src/orchestration/taskPool');

const WORKER_NAMES = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon'];

const TASKS = [
  { id: 'research-mcp',       goal: 'Research what MCP (Model Context Protocol) is. Who created it? What problem does it solve?', agentId: 'Alpha' },
  { id: 'research-agno',      goal: 'Research Agno framework. What is it? Who made it? GitHub stars?', agentId: 'Beta' },
  { id: 'research-pydantic',  goal: 'Research Pydantic AI. What is it? Key features? GitHub stars?', agentId: 'Gamma' },
  { id: 'research-langchain', goal: 'Research LangChain framework. Latest version? GitHub stars? What does it do?', agentId: 'Delta' },
  { id: 'research-llamaindex', goal: 'Research LlamaIndex. What is it? Key features? GitHub stars?', agentId: 'Epsilon' },
];

async function main() {
  const runtime = new AR.AgentRuntime({ budgetHardCapTokens: 500000, maxStepsPerRun: 12 });
  for (const [n, t] of createAllTools()) runtime.registerTool(n, t);
  runtime.registerProvider('openai', new OP.OpenAIProvider({
    apiKey: process.env.OPENAI_API_KEY,
    baseUrl: process.env.OPENAI_BASE_URL,
    defaultModel: process.env.OPENAI_MODEL || 'gpt-4o',
  }));

  const pool = new TaskPool(runtime, {
    maxWorkers: 5,
    defaultTokenBudget: 25000,
    globalTokenBudget: 300000,
    taskTimeoutMs: 180000,
  });

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  COMMANDER ARENA — 5-Agent Parallel Battle');
  console.log('═══════════════════════════════════════════════════════════\n');
  console.log('  Deploying 5 research agents...\n');

  for (const t of TASKS) {
    const bg = ['\x1b[41m','\x1b[44m','\x1b[42m','\x1b[43m','\x1b[45m'][TASKS.indexOf(t)];
    console.log(`  ${bg} ${t.agentId} \x1b[0m researching: ${t.goal.slice(0, 60)}...`);
  }

  console.log('\n  ─── All agents launched ───\n');

  const t0 = Date.now();
  const results = await pool.dispatch(TASKS);
  const wallTime = ((Date.now() - t0) / 1000).toFixed(1);

  // Report
  let report = '# Commander Arena Results\n\n';
  report += '## Battle Summary\n\n';
  report += `| Metric | Value |\n|--------|-------|\n`;
  report += `| Agents deployed | ${TASKS.length} |\n`;
  report += `| Wall clock time | ${wallTime}s |\n`;
  report += `| Sequential time | ${(results.reduce((s,r) => s + r.durationMs, 0) / 1000).toFixed(1)}s |\n`;
  report += `| Speedup | ${(results.reduce((s,r) => s + r.durationMs, 0) / (parseFloat(wallTime) * 1000)).toFixed(1)}x |\n`;
  report += `| Total tokens | ${results.reduce((s,r) => s + r.tokens, 0).toLocaleString()} |\n`;
  report += `| Avg tokens/agent | ${(results.reduce((s,r) => s + r.tokens, 0) / results.length).toLocaleString()} |\n\n`;

  report += '## Per-Agent Results\n\n';
  for (const r of results) {
    const workerName = r.taskId ? TASKS.find(t => t.id === r.taskId)?.agentId || 'Agent' : 'Agent';
    report += `### ${workerName}: ${r.taskId}\n\n`;
    report += `- **Status**: ${r.status}\n`;
    report += `- **Duration**: ${(r.durationMs / 1000).toFixed(1)}s\n`;
    report += `- **Tokens**: ${r.tokens.toLocaleString()}\n`;
    const summary = (r.summary || '').replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '').trim();
    if (summary) report += `\n${summary.slice(0, 800)}\n\n`;
  }

  report += '## Commander vs Competitors\n\n';
  report += '| Capability | Commander | OpenClaw | Hermes Agent |\n';
  report += '|-----------|-----------|----------|-------------|\n';
  report += '| Parallel multi-agent | ✅ Yes | ❌ Single task | ❌ Single task |\n';
  report += '| Dynamic topologies | ✅ 8 types | ❌ Fixed | ❌ Fixed |\n';
  report += '| Quality gates | ✅ 5 gates | ❌ None | ❌ None |\n';
  report += '| Self-optimization | ✅ MetaLearner | ❌ None | ❌ None |\n';
  report += `| This benchmark | ${wallTime}s for 5 tasks | ~${(results.reduce((s,r) => s + r.durationMs, 0) / 1000).toFixed(0)}s sequential | ~${(results.reduce((s,r) => s + r.durationMs, 0) / 1000).toFixed(0)}s sequential |\n`;

  fs.writeFileSync('ARENA.md', report);
  console.log(`  ─── All agents completed in ${wallTime}s ───\n`);
  console.log(`  ⚡ ${results.reduce((s,r) => s + r.durationMs, 0) / (parseFloat(wallTime) * 1000).toFixed(1)}x faster than sequential\n`);
  console.log('  Results:');
  for (const r of results) {
    const icon = r.status === 'success' ? '✅' : '❌';
    const workerName = TASKS.find(t => t.id === r.taskId)?.agentId || '';
    console.log(`  ${icon} ${workerName}: ${(r.durationMs/1000).toFixed(1)}s, ${r.tokens}tokens`);
  }
  console.log(`\n  Report saved to: ARENA.md`);
  console.log('═══════════════════════════════════════════════════════════\n');
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });
