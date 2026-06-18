#!/usr/bin/env npx tsx
/**
 * Commander Feature Demo — showcases all research-backed features.
 *
 * Usage: npx tsx demos/feature-demo.ts
 *
 * This demo:
 * 1. Creates AgentRuntime with all new features enabled
 * 2. Exercises the tool-calling loop with concurrent/serial tools
 * 3. Demonstrates tool retrieval (ITR) filtering tools based on task
 * 4. Shows pattern tracking (PASTE) learning tool sequences
 * 5. Runs a multi-task workflow with critical path scheduling
 */
import { AgentRuntime } from '../packages/core/src/runtime/agentRuntime';
import { MockLLMProvider } from '../packages/core/src/runtime/mockLLMProvider';
import {
  getPatternTracker,
  resetPatternTracker,
} from '../packages/core/src/runtime/speculativeExecutor';
import { selectTools } from '../packages/core/src/runtime/toolRetriever';
import { createAllTools } from '../packages/core/src/tools/index';

const SEPARATOR = '\n' + '='.repeat(60) + '\n';

async function main() {
  console.log(`\n  ╔══════════════════════════════════════════════════╗`);
  console.log(`  ║   Commander — Research Feature Demo            ║`);
  console.log(`  ║   ITR · PASTE · AWO · LAMaS · Entropy Gating   ║`);
  console.log(`  ╚══════════════════════════════════════════════════╝\n`);

  // ============================================================
  // 1. Dynamic Tool Retrieval (ITR)
  // ============================================================
  console.log(SEPARATOR);
  console.log('1. DYNAMIC TOOL RETRIEVAL (ITR — arXiv 2602.17046)');
  console.log(SEPARATOR);

  const ALL_TOOLS = [
    'web_search',
    'web_fetch',
    'browser_search',
    'browser_fetch',
    'file_read',
    'file_write',
    'file_edit',
    'file_search',
    'file_list',
    'python_execute',
    'shell_execute',
    'memory_store',
    'memory_recall',
    'memory_list',
    'git',
    'agent',
  ];

  const searchTools = selectTools('search the web for latest AI research papers', ALL_TOOLS);
  console.log(`  Task: "search the web for latest AI research papers"`);
  console.log(`  Selected (${searchTools.length}/${ALL_TOOLS.length}): ${searchTools.join(', ')}`);
  console.log(`  Excluded: ${ALL_TOOLS.filter((t) => !searchTools.includes(t)).join(', ')}`);
  console.log();

  const codeTools = selectTools(
    'write a python script to calculate fibonacci and save to file',
    ALL_TOOLS,
  );
  console.log(`  Task: "write a python script..."`);
  console.log(`  Selected (${codeTools.length}/${ALL_TOOLS.length}): ${codeTools.join(', ')}`);
  console.log(`  Excluded: ${ALL_TOOLS.filter((t) => !codeTools.includes(t)).join(', ')}`);
  console.log();

  const gitTools = selectTools('commit changes and push to remote repository', ALL_TOOLS);
  console.log(`  Task: "commit changes and push to remote repository"`);
  console.log(`  Selected (${gitTools.length}/${ALL_TOOLS.length}): ${gitTools.join(', ')}`);
  console.log(`  Excluded: ${ALL_TOOLS.filter((t) => !gitTools.includes(t)).join(', ')}`);

  // ============================================================
  // 2. Pattern Tracking (PASTE)
  // ============================================================
  console.log(SEPARATOR);
  console.log('2. PATTERN TRACKING (PASTE — arXiv 2603.18897)');
  console.log(SEPARATOR);

  resetPatternTracker();
  const tracker = getPatternTracker();

  // Simulate a research workflow repeating 5 times
  for (let i = 0; i < 5; i++) {
    tracker.recordSequence(['web_search', 'web_fetch', 'file_write']);
  }
  // Simulate a read-edit-write workflow repeating 3 times
  for (let i = 0; i < 3; i++) {
    tracker.recordSequence(['file_read', 'file_edit', 'file_write']);
  }

  console.log('  Top patterns learned:');
  const topPatterns = tracker.getTopPatterns(5);
  for (const p of topPatterns) {
    console.log(
      `    ${p.sequence.join(' → ')}  (freq: ${p.frequency}, confidence: ${(p.confidence * 100).toFixed(0)}%)`,
    );
  }

  // Predict next tool from partial sequence
  const predictions = tracker.predictNext(['web_search']);
  console.log(`\n  After "web_search", predicts next:`);
  for (const p of predictions) {
    console.log(`    → ${p.toolName} (confidence: ${(p.confidence * 100).toFixed(0)}%)`);
  }

  // ============================================================
  // 3. AgentRuntime with tool calling
  // ============================================================
  console.log(SEPARATOR);
  console.log('3. AGENT RUNTIME — TOOL CALLING LOOP');
  console.log(SEPARATOR);

  const runtime = new AgentRuntime({
    maxRetries: 0,
    timeoutMs: 5000,
    toolRetrieval: {
      enabled: true,
      minTools: 3,
      maxTools: 8,
      alwaysInclude: ['file_read', 'shell_execute'],
    },
    entropyGating: { enabled: true },
    speculativeExecution: { enabled: true, maxPredictions: 2, minConfidence: 0.1 },
  });

  // Register mock provider that simulates a research workflow
  const provider = new MockLLMProvider('openai', {
    defaultResponse: 'Task completed. Here is the final analysis with all findings synthesized.',
  });
  runtime.registerProvider('openai', provider);

  // Register tools
  const allTools = createAllTools({ enableMetaTools: true });
  for (const [name, tool] of allTools) {
    runtime.registerTool(name, tool);
  }

  console.log(`  Registered ${allTools.size} tools (including meta-tools)`);
  console.log(`  Config: toolRetrieval=true, entropyGating=true, speculativeExecution=true`);
  console.log();

  // Run a simple execution
  const result = await runtime.execute({
    agentId: 'demo-agent',
    projectId: 'demo',
    goal: 'Search the web for information about multi-agent systems and save the findings.',
    contextData: {},
    availableTools: [
      'web_search',
      'web_fetch',
      'file_write',
      'file_read',
      'shell_execute',
      'python_execute',
      'git',
    ],
    maxSteps: 5,
    tokenBudget: 16000,
  });

  console.log(`  Execution: ${result.status}`);
  console.log(`  LLM calls: ${provider.callCount}`);
  console.log(`  Steps: ${result.steps.length}`);
  console.log(`  Tokens: ${result.totalTokenUsage.totalTokens}`);
  console.log(`  Duration: ${result.totalDurationMs}ms`);

  // Show config options
  console.log(SEPARATOR);
  console.log('4. CONFIGURATION OPTIONS');
  console.log(SEPARATOR);
  console.log(`
  // Enable all new features:
  const runtime = new AgentRuntime({
    toolRetrieval: {
      enabled: true,        // Only send relevant tools to LLM
      minTools: 3,           // Always keep at least 3 tools
      maxTools: 8,           // Never send more than 8
      alwaysInclude: ['file_read', 'shell_execute'],
    },
    entropyGating: {
      enabled: true,         // Skip tool defs when model is confident
    },
    speculativeExecution: {
      enabled: true,         // Pre-execute predicted tools
      maxPredictions: 2,     // Max pre-executions per step
      minConfidence: 0.3,    // Minimum prediction confidence
    },
  });

  // Enable meta-tools (AWO):
  const tools = createAllTools({ enableMetaTools: true });
  // Registers: research_topic, find_and_read, research_and_save
  `);

  console.log('Demo complete!');
}

main().catch(console.error);
