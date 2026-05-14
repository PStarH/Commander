#!/usr/bin/env npx tsx
/**
 * Commander Parallel Execution Demo
 *
 * Shows Commander dispatching 3 research tasks to parallel workers.
 * Each worker independently searches and reports back.
 * Total time ≈ max(task), not sum(task).
 */
import * as fs from 'fs';
const AR = require('../packages/core/src/runtime/agentRuntime');
const OP = require('../packages/core/src/runtime/providers/openaiProvider');
const { createAllTools } = require('../packages/core/src/tools/index');
const { TaskPool } = require('../packages/core/src/orchestration/taskPool');

async function main() {
  const runtime = new AR.AgentRuntime({ budgetHardCapTokens: 500000, maxStepsPerRun: 15 });
  for (const [n, t] of createAllTools()) runtime.registerTool(n, t);
  runtime.registerProvider('openai', new OP.OpenAIProvider({
    apiKey: process.env.OPENAI_API_KEY,
    baseUrl: process.env.OPENAI_BASE_URL,
    defaultModel: process.env.OPENAI_MODEL || 'gpt-4o',
  }));

  const pool = new TaskPool(runtime, {
    maxWorkers: 3,
    defaultTokenBudget: 30000,
    globalTokenBudget: 200000,
    taskTimeoutMs: 180000,
  });

  const tasks = [
    {
      id: 'research-langgraph',
      goal: 'Use browser_search to research LangGraph framework. What is it, who made it, GitHub stars?',
      agentId: 'researcher-1',
    },
    {
      id: 'research-crewai',
      goal: 'Use browser_search to research CrewAI framework. What is it, who made it, GitHub stars?',
      agentId: 'researcher-2',
    },
    {
      id: 'research-autogen',
      goal: 'Use browser_search to research AutoGen framework. What is it, who made it, GitHub stars?',
      agentId: 'researcher-3',
    },
  ];

  console.log('\n══════════════════════════════════════════════════');
  console.log('  COMMANDER · PARALLEL EXECUTION DEMO');
  console.log('  3 research tasks → 3 parallel workers');
  console.log('══════════════════════════════════════════════════\n');

  const t0 = Date.now();
  const results = await pool.dispatch(tasks);
  const totalTime = ((Date.now() - t0) / 1000).toFixed(1);

  console.log(`  Total time: ${totalTime}s (3 tasks in parallel)\n`);
  console.log('  Results:\n');

  for (const r of results) {
    const icon = r.status === 'success' ? '✅' : '❌';
    const summary = (r.summary || '').replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '').trim();
    console.log(`  ${icon} ${r.taskId}`);
    console.log(`     ${r.durationMs}ms · ${r.tokens} tokens`);
    if (summary) console.log(`     ${summary.slice(0, 500)}`);
    console.log();
  }

  const totalTokens = results.reduce((s, r) => s + r.tokens, 0);
  const maxTime = Math.max(...results.map(r => r.durationMs));
  const sumTime = results.reduce((s, r) => s + r.durationMs, 0);

  console.log('══════════════════════════════════════════════════');
  console.log('  EFFICIENCY REPORT');
  console.log('══════════════════════════════════════════════════');
  console.log(`  Parallel time: ${(maxTime / 1000).toFixed(1)}s (max of 3)`);
  console.log(`  Sequential would be: ${(sumTime / 1000).toFixed(1)}s (sum of 3)`);
  console.log(`  Speedup: ${(sumTime / maxTime).toFixed(1)}x`);
  console.log(`  Total tokens: ${totalTokens.toLocaleString()}`);
  console.log('══════════════════════════════════════════════════\n');
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });
