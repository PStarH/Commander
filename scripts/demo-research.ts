#!/usr/bin/env npx tsx
/**
 * Commander Research Demo
 *
 * Uses Commander's AgentRuntime directly (bypasses orchestrator synthesis)
 * to research and compare AI agent frameworks using real web search.
 */
import * as fs from 'fs';
const AR = require('../packages/core/src/runtime/agentRuntime');
const OP = require('../packages/core/src/runtime/providers/openaiProvider');
const { createAllTools } = require('../packages/core/src/tools/index');

async function main() {
  const runtime = new AR.AgentRuntime({ budgetHardCapTokens: 500000, maxStepsPerRun: 10 });
  for (const [n, t] of createAllTools()) runtime.registerTool(n, t);
  runtime.registerProvider('openai', new OP.OpenAIProvider({
    apiKey: process.env.OPENAI_API_KEY,
    baseUrl: process.env.OPENAI_BASE_URL,
    defaultModel: process.env.OPENAI_MODEL || 'gpt-4o',
  }));

  const task = `Research the current state of AI agent frameworks in 2026.

Use browser_search at least 3 times to find information about:
1. LangGraph (by LangChain) - latest version, architecture, adoption
2. CrewAI - latest version, architecture, community growth
3. AutoGen (by Microsoft) - latest version, architecture, use cases

After searching, provide a structured comparison with:
- GitHub stars and community size for each
- Key architectural differences
- Strengths and weaknesses
- Best use cases for each

Be specific and use real data from your searches.`;

  console.log('\n══════════════════════════════════════════════════════');
  console.log('  COMMANDER · AI RESEARCH DEMO');
  console.log('══════════════════════════════════════════════════════\n');
  console.log('  Agent researching: AI Agent Frameworks\n');

  const t0 = Date.now();
  const result = await runtime.execute({
    agentId: 'researcher',
    projectId: 'demo',
    goal: task,
    contextData: {},
    availableTools: ['browser_search', 'browser_fetch', 'python_execute'],
    maxSteps: 10,
    tokenBudget: 50000,
  });

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  const tokens = result.totalTokenUsage.totalTokens;
  const cost = (tokens / 1000000) * 0.15;

  // Clean output - remove tool call XML artifacts
  let output = result.summary || '';
  output = output.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '');
  output = output.replace(/<function>[\s\S]*?<\/function>/g, '');
  output = output.replace(/<parameter[\s\S]*?<\/parameter>/g, '');
  output = output.replace(/```json[\s\S]*?```/g, '');
  output = output.trim();

  console.log(`  Duration: ${elapsed}s`);
  console.log(`  Tokens: ${tokens.toLocaleString()}`);
  console.log(`  Est. cost: $${cost.toFixed(4)}`);
  console.log(`  Status: ${result.status}\n`);

  console.log('══════════════════════════════════════════════════════');
  console.log('  RESEARCH OUTPUT');
  console.log('══════════════════════════════════════════════════════\n');
  console.log(output.slice(0, 8000));

  if (output.length > 8000) {
    console.log(`\n  ... (${output.length - 8000} more chars)`);
  }

  // Save full output
  fs.writeFileSync('research-output.md',
    `# Commander Research Demo\n\n` +
    `**Duration**: ${elapsed}s | **Tokens**: ${tokens.toLocaleString()} | **Cost**: $${cost.toFixed(4)}\n\n` +
    output
  );
  console.log(`\n  Full output saved to: research-output.md`);
  console.log('══════════════════════════════════════════════════════\n');
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });
