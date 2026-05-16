/**
 * Smart Routing Benchmark — Proves cost savings with minimal quality loss.
 *
 * Runs 25 diverse tasks through the ModelRouter in two modes:
 * 1. Power-only: always picks the cheapest power-tier model
 * 2. Smart routing: lets the router choose based on task type, complexity, capabilities
 *
 * Metrics:
 * - Token cost per task (estimated)
 * - Capability coverage (does selected model have required caps?)
 * - Total cost savings percentage
 */

import { ModelRouter } from '../src/runtime/modelRouter';
import type { AgentExecutionContext, ModelConfig } from '../src/runtime/types';

// ============================================================================
// Benchmark Tasks — 25 tasks spanning all types and complexities
// ============================================================================

interface BenchmarkTask {
  id: string;
  name: string;
  goal: string;
  expectedType: string; // expected task type detection
  requiredCapabilities: string[]; // what the model NEEDS to do well
  tokenBudget: number;
  toolCount: number;
  riskLevel?: string;
  difficulty: 'trivial' | 'easy' | 'medium' | 'hard' | 'expert';
}

const TASKS: BenchmarkTask[] = [
  // Trivial — should route to eco
  { id: 'T01', name: 'Simple greeting', goal: 'Hello, how are you?', expectedType: 'general', requiredCapabilities: [], tokenBudget: 1000, toolCount: 0, difficulty: 'trivial' },
  { id: 'T02', name: 'Unit conversion', goal: 'Convert 100 miles to kilometers', expectedType: 'general', requiredCapabilities: ['analysis'], tokenBudget: 2000, toolCount: 0, difficulty: 'trivial' },
  { id: 'T03', name: 'Simple lookup', goal: 'What is the capital of France?', expectedType: 'search', requiredCapabilities: [], tokenBudget: 1500, toolCount: 1, difficulty: 'trivial' },

  // Easy — should route to eco/standard
  { id: 'T04', name: 'Summarize text', goal: 'Summarize the following article about climate change in 3 bullet points', expectedType: 'analysis', requiredCapabilities: ['analysis'], tokenBudget: 4000, toolCount: 0, difficulty: 'easy' },
  { id: 'T05', name: 'File read', goal: 'Read the contents of package.json and list all dependencies', expectedType: 'code', requiredCapabilities: ['code'], tokenBudget: 3000, toolCount: 2, difficulty: 'easy' },
  { id: 'T06', name: 'Web search', goal: 'Search for the latest TypeScript 5.9 features and summarize them', expectedType: 'search', requiredCapabilities: ['analysis'], tokenBudget: 5000, toolCount: 3, difficulty: 'easy' },
  { id: 'T07', name: 'Simple calculation', goal: 'Calculate the compound interest on $10000 at 5% for 10 years', expectedType: 'general', requiredCapabilities: ['analysis'], tokenBudget: 2000, toolCount: 0, difficulty: 'easy' },
  { id: 'T08', name: 'Format data', goal: 'Convert this CSV data to JSON format', expectedType: 'structured', requiredCapabilities: ['code', 'analysis'], tokenBudget: 3000, toolCount: 1, difficulty: 'easy' },

  // Medium — should route to standard
  { id: 'T09', name: 'Write function', goal: 'Write a Python function to implement binary search with error handling', expectedType: 'code', requiredCapabilities: ['code', 'reasoning'], tokenBudget: 8000, toolCount: 3, difficulty: 'medium' },
  { id: 'T10', name: 'Debug code', goal: 'Find and fix the bug in this JavaScript async function that causes a race condition', expectedType: 'code', requiredCapabilities: ['code', 'reasoning'], tokenBudget: 10000, toolCount: 4, difficulty: 'medium' },
  { id: 'T11', name: 'Data analysis', goal: 'Analyze the sales data from Q1-Q4 and identify trends, anomalies, and recommendations', expectedType: 'analysis', requiredCapabilities: ['reasoning', 'analysis'], tokenBudget: 12000, toolCount: 3, difficulty: 'medium' },
  { id: 'T12', name: 'API design', goal: 'Design a REST API for a todo application with CRUD operations, authentication, and pagination', expectedType: 'code', requiredCapabilities: ['code', 'reasoning'], tokenBudget: 10000, toolCount: 2, difficulty: 'medium' },
  { id: 'T13', name: 'Write tests', goal: 'Write comprehensive unit tests for the UserService class covering edge cases', expectedType: 'code', requiredCapabilities: ['code', 'reasoning'], tokenBudget: 12000, toolCount: 4, difficulty: 'medium' },
  { id: 'T14', name: 'Research report', goal: 'Research the state of WebAssembly in 2026 and write a detailed report with sources', expectedType: 'search', requiredCapabilities: ['analysis', 'creative'], tokenBudget: 15000, toolCount: 5, difficulty: 'medium' },
  { id: 'T15', name: 'Refactor code', goal: 'Refactor the authentication module to use the Strategy pattern with proper dependency injection', expectedType: 'code', requiredCapabilities: ['code', 'reasoning'], tokenBudget: 15000, toolCount: 5, difficulty: 'medium' },

  // Hard — should route to standard/power
  { id: 'T16', name: 'System design', goal: 'Design a distributed task queue system with exactly-once delivery, dead letter queues, and horizontal scaling', expectedType: 'analysis', requiredCapabilities: ['reasoning', 'analysis'], tokenBudget: 20000, toolCount: 3, difficulty: 'hard' },
  { id: 'T17', name: 'Complex debugging', goal: 'The production server has a memory leak that only appears under load. Analyze the heap dumps, identify the root cause, and propose a fix with migration strategy', expectedType: 'code', requiredCapabilities: ['code', 'reasoning'], tokenBudget: 25000, toolCount: 6, difficulty: 'hard' },
  { id: 'T18', name: 'Multi-file refactor', goal: 'Migrate the entire codebase from Express.js to Fastify, including middleware, error handling, and route definitions. Ensure zero downtime deployment.', expectedType: 'code', requiredCapabilities: ['code', 'reasoning'], tokenBudget: 30000, toolCount: 8, difficulty: 'hard' },
  { id: 'T19', name: 'Performance optimization', goal: 'Profile the database queries, identify N+1 problems, optimize with proper indexing and query restructuring, and benchmark the improvements', expectedType: 'code', requiredCapabilities: ['code', 'reasoning', 'analysis'], tokenBudget: 25000, toolCount: 6, difficulty: 'hard' },
  { id: 'T20', name: 'Creative writing', goal: 'Write a compelling 2000-word technical blog post about the evolution of AI agents, with code examples and architectural diagrams described in text', expectedType: 'creative', requiredCapabilities: ['creative', 'reasoning'], tokenBudget: 20000, toolCount: 2, difficulty: 'hard' },

  // Expert — should route to power
  { id: 'T21', name: 'Compiler design', goal: 'Implement a simple expression compiler that parses arithmetic expressions, generates bytecode, and executes them with proper error recovery', expectedType: 'code', requiredCapabilities: ['code', 'reasoning', 'math'], tokenBudget: 40000, toolCount: 5, difficulty: 'expert' },
  { id: 'T22', name: 'Distributed consensus', goal: 'Implement a simplified Raft consensus algorithm in TypeScript with leader election, log replication, and safety guarantees. Include comprehensive tests.', expectedType: 'code', requiredCapabilities: ['code', 'reasoning', 'math'], tokenBudget: 50000, toolCount: 6, difficulty: 'expert' },
  { id: 'T23', name: 'Critical deployment', goal: 'Deploy the production database migration with zero downtime. Verify data integrity, rollback plan, and monitor for issues.', expectedType: 'code', requiredCapabilities: ['code', 'reasoning'], tokenBudget: 30000, toolCount: 8, riskLevel: 'CRITICAL', difficulty: 'expert' },
  { id: 'T24', name: 'Security audit', goal: 'Perform a comprehensive security audit of the authentication system, identify OWASP top 10 vulnerabilities, and implement fixes', expectedType: 'code', requiredCapabilities: ['code', 'reasoning', 'analysis'], tokenBudget: 35000, toolCount: 7, riskLevel: 'HIGH', difficulty: 'expert' },
  { id: 'T25', name: 'Cross-domain integration', goal: 'Search for the latest Go performance report, summarize key findings, write a Python benchmark to verify one conclusion, run it, and produce a comparison chart', expectedType: 'code', requiredCapabilities: ['code', 'reasoning', 'analysis'], tokenBudget: 25000, toolCount: 6, difficulty: 'hard' },
];

// ============================================================================
// Benchmark Runner
// ============================================================================

interface TaskResult {
  task: BenchmarkTask;
  powerModel: string;
  smartModel: string;
  powerCost: number;
  smartCost: number;
  powerHasCaps: boolean;
  smartHasCaps: boolean;
  powerTier: string;
  smartTier: string;
  smartReasoning: string[];
}

function runBenchmark(): TaskResult[] {
  const router = new ModelRouter();
  const results: TaskResult[] = [];

  for (const task of TASKS) {
    // Build execution context
    const ctx: AgentExecutionContext = {
      agentId: 'benchmark-agent',
      projectId: 'benchmark',
      goal: task.goal,
      contextData: task.riskLevel ? { governanceProfile: { riskLevel: task.riskLevel } } : {},
      availableTools: Array.from({ length: task.toolCount }, (_, i) => `tool_${i}`),
      maxSteps: 20,
      tokenBudget: task.tokenBudget,
    };

    // Mode 1: Power-only — always pick cheapest power model
    const powerModels = router.listModels('power').sort((a, b) => a.costPer1KOutput - b.costPer1KOutput);
    const powerModel = powerModels[0];
    const estimatedInputTokens = Math.ceil(task.goal.length / 4) + 2048;
    const estimatedOutputTokens = Math.min(task.tokenBudget, (powerModel?.contextWindow ?? 200000) - estimatedInputTokens);
    const powerCost = powerModel
      ? (estimatedInputTokens / 1000) * powerModel.costPer1KInput + (estimatedOutputTokens / 1000) * powerModel.costPer1KOutput
      : 0;

    // Mode 2: Smart routing
    const decision = router.route(ctx);
    const smartModel = router.getModel(decision.modelId);
    const smartCost = decision.estimatedCost;

    // Check capability coverage
    const powerHasCaps = powerModel
      ? task.requiredCapabilities.every(c => powerModel.capabilities.includes(c))
      : false;
    const smartHasCaps = smartModel
      ? task.requiredCapabilities.every(c => smartModel.capabilities.includes(c))
      : false;

    results.push({
      task,
      powerModel: powerModel?.id ?? 'none',
      smartModel: decision.modelId,
      powerCost: Math.round(powerCost * 1000000) / 1000000,
      smartCost: Math.round(smartCost * 1000000) / 1000000,
      powerHasCaps,
      smartHasCaps,
      powerTier: powerModel?.tier ?? 'none',
      smartTier: decision.tier,
      smartReasoning: decision.reasoning,
    });
  }

  return results;
}

// ============================================================================
// Report Generation
// ============================================================================

function generateReport(results: TaskResult[]): string {
  const totalPowerCost = results.reduce((s, r) => s + r.powerCost, 0);
  const totalSmartCost = results.reduce((s, r) => s + r.smartCost, 0);
  const savings = totalPowerCost - totalSmartCost;
  const savingsPct = (savings / totalPowerCost) * 100;

  const powerCapHits = results.filter(r => r.powerHasCaps).length;
  const smartCapHits = results.filter(r => r.smartHasCaps).length;
  const totalRequired = results.filter(r => r.task.requiredCapabilities.length > 0).length;

  const lines: string[] = [
    '# Smart Routing Benchmark Report',
    '',
    `Generated: ${new Date().toISOString()}`,
    `Tasks: ${results.length}`,
    '',
    '## Cost Summary',
    '',
    `| Metric | Power-Only | Smart Routing | Delta |`,
    `|--------|-----------|---------------|-------|`,
    `| Total estimated cost | $${totalPowerCost.toFixed(6)} | $${totalSmartCost.toFixed(6)} | -$${savings.toFixed(6)} (${savingsPct.toFixed(1)}%) |`,
    `| Avg cost per task | $${(totalPowerCost / results.length).toFixed(6)} | $${(totalSmartCost / results.length).toFixed(6)} | |`,
    '',
    '## Quality Summary',
    '',
    `| Metric | Power-Only | Smart Routing |`,
    `|--------|-----------|---------------|`,
    `| Capability coverage | ${powerCapHits}/${totalRequired} (${(powerCapHits/Math.max(totalRequired,1)*100).toFixed(0)}%) | ${smartCapHits}/${totalRequired} (${(smartCapHits/Math.max(totalRequired,1)*100).toFixed(0)}%) |`,
    '',
    '## Tier Distribution (Smart Routing)',
    '',
  ];

  // Tier distribution
  const tierCounts = new Map<string, number>();
  for (const r of results) {
    tierCounts.set(r.smartTier, (tierCounts.get(r.smartTier) ?? 0) + 1);
  }
  lines.push('| Tier | Count | Tasks |');
  lines.push('|------|-------|-------|');
  for (const [tier, count] of [...tierCounts.entries()].sort()) {
    const tasks = results.filter(r => r.smartTier === tier).map(r => r.task.id).join(', ');
    lines.push(`| ${tier} | ${count} | ${tasks} |`);
  }

  lines.push('');
  lines.push('## Per-Task Detail');
  lines.push('');
  lines.push('| ID | Task | Difficulty | Power Model | Smart Model | Power Cost | Smart Cost | Savings | Caps OK |');
  lines.push('|-----|------|-----------|-------------|-------------|-----------|------------|---------|---------|');

  for (const r of results) {
    const taskSavings = r.powerCost > 0 ? ((r.powerCost - r.smartCost) / r.powerCost * 100).toFixed(0) : '0';
    const capsOk = r.task.requiredCapabilities.length === 0 ? '-' : (r.smartHasCaps ? 'YES' : 'NO');
    lines.push(`| ${r.task.id} | ${r.task.name} | ${r.task.difficulty} | ${r.powerModel} | ${r.smartModel} | $${r.powerCost.toFixed(6)} | $${r.smartCost.toFixed(6)} | ${taskSavings}% | ${capsOk} |`);
  }

  // Highlight any quality regressions
  const regressions = results.filter(r => r.powerHasCaps && !r.smartHasCaps);
  if (regressions.length > 0) {
    lines.push('');
    lines.push('## Quality Regressions');
    lines.push('');
    lines.push('Tasks where smart routing selected a model WITHOUT required capabilities:');
    for (const r of regressions) {
      lines.push(`- **${r.task.id}** (${r.task.name}): needs [${r.task.requiredCapabilities.join(', ')}], got ${r.smartModel} [${r.smartReasoning.join('; ')}]`);
    }
  } else {
    lines.push('');
    lines.push('## Quality Regressions');
    lines.push('');
    lines.push('**None.** Smart routing maintained capability coverage for all tasks.');
  }

  return lines.join('\n');
}

// ============================================================================
// Main
// ============================================================================

const results = runBenchmark();
const report = generateReport(results);

// Write report
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const reportPath = join(import.meta.dirname ?? process.cwd(), 'ROUTING_BENCHMARK.md');
writeFileSync(reportPath, report, 'utf-8');

// Print summary to stdout
const totalPowerCost = results.reduce((s, r) => s + r.powerCost, 0);
const totalSmartCost = results.reduce((s, r) => s + r.smartCost, 0);
const savings = totalPowerCost - totalSmartCost;
const savingsPct = (savings / totalPowerCost) * 100;

console.log('=== Smart Routing Benchmark Results ===');
console.log(`Tasks: ${results.length}`);
console.log(`Power-only total cost: $${totalPowerCost.toFixed(6)}`);
console.log(`Smart routing total cost: $${totalSmartCost.toFixed(6)}`);
console.log(`Savings: $${savings.toFixed(6)} (${savingsPct.toFixed(1)}%)`);
console.log('');

const tierCounts = new Map<string, number>();
for (const r of results) {
  tierCounts.set(r.smartTier, (tierCounts.get(r.smartTier) ?? 0) + 1);
}
console.log('Smart routing tier distribution:');
for (const [tier, count] of [...tierCounts.entries()].sort()) {
  console.log(`  ${tier}: ${count} tasks`);
}

const regressions = results.filter(r => r.powerHasCaps && !r.smartHasCaps);
console.log(`\nQuality regressions: ${regressions.length}`);
if (regressions.length > 0) {
  for (const r of regressions) {
    console.log(`  ${r.task.id}: ${r.task.name}`);
  }
}

console.log(`\nFull report: ${reportPath}`);
