#!/usr/bin/env npx tsx
/**
 * Commander Enterprise Demo
 *
 * Showcases Commander's multi-agent orchestration on a real business task:
 * Research and analyze the AI agent framework landscape.
 *
 * This demo proves Commander can:
 * 1. Decompose a complex task into sub-agents
 * 2. Each agent does real web research via browser_search
 * 3. Quality gates catch hallucinations
 * 4. Synthesize multiple sources into a coherent report
 */
import * as fs from 'fs';

const AR = require('../packages/core/src/runtime/agentRuntime');
const OP = require('../packages/core/src/runtime/providers/openaiProvider');
const MR = require('../packages/core/src/runtime/modelRouter');
const TO = require('../packages/core/src/telos/telosOrchestrator');
const UO = require('../packages/core/src/ultimate/orchestrator');
const { createAllTools } = require('../packages/core/src/tools/index');

async function main() {
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  COMMANDER · ENTERPRISE DEMO');
  console.log('  Multi-Agent Research & Analysis Pipeline');
  console.log('═══════════════════════════════════════════════════════════\n');

  const runtime = new AR.AgentRuntime({budgetHardCapTokens:500000});
  for (const [n,t] of createAllTools()) runtime.registerTool(n,t);
  runtime.registerProvider('openai', new OP.OpenAIProvider({
    apiKey: process.env.OPENAI_API_KEY, baseUrl: process.env.OPENAI_BASE_URL, defaultModel: process.env.OPENAI_MODEL||'gpt-4o',
  }));
  const router = MR.getModelRouter();
  const modelId = process.env.OPENAI_MODEL||'gpt-4o';
  for (const tier of ['eco','standard','power','consensus']) router.registerModel({
    id: modelId+'@'+tier, provider:'openai', tier, costPer1KInput:0.0008, costPer1KOutput:0.004,
    capabilities:['code','reasoning','analysis','creative','math'], contextWindow:128000, priority:-1,
  });
  const orch = new UO.UltimateOrchestrator(new TO.TELOSOrchestrator(runtime), runtime);

  const task = `Research and compare the top AI agent frameworks in 2026: LangGraph, CrewAI, AutoGen, and Commander.

For each framework, find:
1. Latest version and GitHub stars
2. Key architectural approach (graph-based, role-based, etc.)
3. Strengths and weaknesses
4. Typical use cases and production adoption
5. Benchmark performance on GAIA or similar

Then provide a comparison table and actionable recommendations for a team choosing a framework.

Use browser_search to find current information. Be thorough and specific.`;

  console.log('  Task: AI Agent Framework Landscape Analysis\n');
  console.log('  Pipeline: deliberation → decomposition → parallel research → synthesis → quality check\n');

  console.log('━━━ Phase 1: Deliberation ━━━');
  const t0 = Date.now();
  const result = await orch.execute({
    projectId: 'enterprise-demo',
    agentId: 'commander',
    goal: task,
    contextData: {
      availableTools: ['browser_search', 'browser_fetch', 'python_execute', 'shell_execute', 'file_write'],
      governanceProfile: { riskLevel: 'LOW' },
    },
  });
  const totalTime = ((Date.now() - t0) / 1000).toFixed(1);

  console.log('\n━━━ Results ━━━');
  console.log(`  Status: ${result.status}`);
  console.log(`  Sub-agents spawned: ${result.metrics.subAgentsSpawned}`);
  console.log(`  Total tokens: ${result.metrics.totalTokens.toLocaleString()}`);
  console.log(`  Total cost: $${result.metrics.totalCostUsd.toFixed(4)}`);
  console.log(`  Total time: ${totalTime}s`);
  console.log(`  Quality score: ${(result.metrics.qualityScore * 100).toFixed(0)}%`);
  console.log(`  Topology used: ${result.metrics.topologyUsed}`);

  console.log('\n━━━ Generated Report ━━━\n');
  console.log(result.synthesis);

  // Save report
  const report = `# Commander Enterprise Demo\n\n` +
    `## Metadata\n` +
    `- Generated: ${new Date().toISOString()}\n` +
    `- Model: ${modelId}\n` +
    `- Pipeline: ${result.metrics.topologyUsed}\n` +
    `- Sub-agents: ${result.metrics.subAgentsSpawned}\n` +
    `- Tokens: ${result.metrics.totalTokens.toLocaleString()}\n` +
    `- Cost: $${result.metrics.totalCostUsd.toFixed(4)}\n` +
    `- Duration: ${totalTime}s\n` +
    `- Quality score: ${(result.metrics.qualityScore * 100).toFixed(0)}%\n\n` +
    result.synthesis;

  fs.writeFileSync('enterprise-demo-report.md', report);
  console.log(`\n  Report saved to: enterprise-demo-report.md`);
  console.log('═══════════════════════════════════════════════════════════\n');
}
main().catch(err => { console.error('FATAL:', err); process.exit(1); });
