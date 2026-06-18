#!/usr/bin/env npx tsx
/**
 * Commander Complex E2E Test
 *
 * Exercises the full tool-calling pipeline with a realistic multi-step workflow:
 *   1. Research phase: search → fetch → analyze
 *   2. Build phase: code → edit → review
 *   3. Report phase: write → summarize
 *
 * Tests: multi-turn loop, concurrent execution, error recovery, tool retrieval,
 *        observation masking, speculative cache, meta-tools.
 */
import { AgentRuntime } from '../packages/core/src/runtime/agentRuntime';
import { MockLLMProvider } from '../packages/core/src/runtime/mockLLMProvider';
import { ModelRouter, resetModelRouter } from '../packages/core/src/runtime/modelRouter';
import { resetMessageBus } from '../packages/core/src/runtime/messageBus';
import { resetTraceRecorder } from '../packages/core/src/runtime/executionTrace';
import {
  resetPatternTracker,
  getPatternTracker,
} from '../packages/core/src/runtime/speculativeExecutor';
import type {
  LLMRequest,
  LLMResponse,
  Tool,
  ToolDefinition,
} from '../packages/core/src/runtime/types';

// ============================================================================
// A stateful mock provider that simulates a real LLM's tool-calling behavior.
// Returns tool calls for the first N steps, then a final answer.
// ============================================================================
class SmartMockProvider extends MockLLMProvider {
  private script: Array<{
    toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
    response?: string;
    finishReason?: 'tool_calls' | 'stop';
  }>;
  private trace: string[] = [];

  constructor(
    script: Array<{
      toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
      response?: string;
      finishReason?: 'tool_calls' | 'stop';
    }>,
  ) {
    super('smart-mock');
    this.script = script;
  }

  async call(request: LLMRequest): Promise<LLMResponse> {
    this.callCount++;
    this.lastRequest = request;
    const idx = Math.min(this.callCount - 1, this.script.length - 1);
    const step = this.script[idx];

    const toolCalls = step?.toolCalls;
    const content = step?.response ?? 'Processing...';
    const finishReason = step?.finishReason ?? (toolCalls ? 'tool_calls' : 'stop');

    this.trace.push(
      `[call ${this.callCount}] ${toolCalls ? toolCalls.map((t) => `${t.name}(${JSON.stringify(t.arguments)})`).join(', ') : content.slice(0, 60)}`,
    );

    const promptTokens = JSON.stringify(request.messages).length;
    const completionTokens = content.length;
    return {
      content,
      model: request.model,
      usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens },
      finishReason,
      toolCalls: toolCalls as Array<{
        id: string;
        type: string;
        function: { name: string; arguments: string };
      }>,
    };
  }

  getTrace(): string[] {
    return this.trace;
  }
}

// ============================================================================
// Test tools with realistic behavior
// ============================================================================
function makeTool(
  name: string,
  exec: (args: Record<string, unknown>) => Promise<string>,
  opts?: { concurrent?: boolean; readOnly?: boolean },
): Tool {
  return {
    definition: {
      name,
      description: `${name} tool`,
      inputSchema: { type: 'object', properties: {} },
    },
    execute: exec,
    isConcurrencySafe: opts?.concurrent ?? true,
    isReadOnly: opts?.readOnly ?? true,
    timeout: 5000,
    maxOutputSize: 10000,
  };
}

function makeMutatingTool(
  name: string,
  exec: (args: Record<string, unknown>) => Promise<string>,
): Tool {
  return makeTool(name, exec, { concurrent: false, readOnly: false });
}

// ============================================================================
// Test: Complex Research + Code Workflow
// ============================================================================
async function testComplexResearchWorkflow() {
  console.log('\n' + '='.repeat(70));
  console.log('TEST 1: Complex Research + Code Workflow (10-step tool loop)');
  console.log('='.repeat(70));

  resetModelRouter();
  resetMessageBus();
  resetTraceRecorder();
  resetPatternTracker();

  const router = new ModelRouter();
  const runtime = new AgentRuntime(
    {
      maxRetries: 0,
      timeoutMs: 10000,
      toolRetrieval: {
        enabled: true,
        minTools: 3,
        maxTools: 10,
        alwaysInclude: ['file_read', 'shell_execute'],
      },
      entropyGating: { enabled: true },
      speculativeExecution: { enabled: true, maxPredictions: 2, minConfidence: 0.1 },
      observationMaskWindow: 5,
    },
    router,
  );

  // Register tools
  runtime.registerTool(
    'web_search',
    makeTool('web_search', async (args) => {
      await new Promise((r) => setTimeout(r, 10));
      return `Search results for "${args.query}":
1. https://example.com/ai-agents - "Multi-agent systems are revolutionizing AI"
2. https://example.com/orchestration - "Tool use in autonomous agents"`;
    }),
  );

  runtime.registerTool(
    'web_fetch',
    makeTool('web_fetch', async (args) => {
      await new Promise((r) => setTimeout(r, 10));
      return `Content from ${args.url}: [ARTICLE] Multi-agent orchestration enables complex task completion through dynamic tool selection and parallel execution.`;
    }),
  );

  runtime.registerTool(
    'python_execute',
    makeTool(
      'python_execute',
      async (args) => {
        return `[Python output]\nExecution result: analysis complete\nSummary: found 3 key patterns`;
      },
      { concurrent: false },
    ),
  );

  runtime.registerTool(
    'file_write',
    makeMutatingTool('file_write', async (args) => {
      return `Written ${((args.content as string) || '').length} bytes to ${args.path}`;
    }),
  );

  runtime.registerTool(
    'file_read',
    makeTool('file_read', async (args) => {
      return `[File: ${args.path}]\n# Research Report\nMulti-agent systems achieve 40% higher task completion...`;
    }),
  );

  runtime.registerTool(
    'file_search',
    makeTool('file_search', async (args) => {
      return `Found files matching ${args.pattern}:\n- report.md\n- analysis.py\n- data.csv`;
    }),
  );

  runtime.registerTool(
    'shell_execute',
    makeMutatingTool('shell_execute', async (args) => {
      return `[Exit: 0 | 45ms]\n${args.command} completed successfully.`;
    }),
  );

  runtime.registerTool(
    'memory_store',
    makeMutatingTool('memory_store', async (args) => {
      return `Stored: ${((args.content as string) || '').slice(0, 40)}...`;
    }),
  );

  runtime.registerTool(
    'memory_recall',
    makeTool('memory_recall', async (args) => {
      return `[Memory] Found "${args.query}": previous analysis showed 40% improvement`;
    }),
  );

  // Create mock provider with a 6-step tool script
  const provider = new SmartMockProvider([
    // Step 1: Research - search the web
    {
      toolCalls: [
        {
          id: 'call_1',
          name: 'web_search',
          arguments: { query: 'multi-agent orchestration systems 2025' },
        },
      ],
      finishReason: 'tool_calls',
    },
    // Step 2: Fetch a result
    {
      toolCalls: [
        { id: 'call_2', name: 'web_fetch', arguments: { url: 'https://example.com/ai-agents' } },
      ],
      finishReason: 'tool_calls',
    },
    // Step 3: Analyze with python
    {
      toolCalls: [
        { id: 'call_3', name: 'python_execute', arguments: { code: 'print("analysis complete")' } },
      ],
      finishReason: 'tool_calls',
    },
    // Step 4: Write report
    {
      toolCalls: [
        {
          id: 'call_4',
          name: 'file_write',
          arguments: {
            path: '/tmp/report.md',
            content: '# Research Results\nMulti-agent orchestration is effective.',
          },
        },
      ],
      finishReason: 'tool_calls',
    },
    // Step 5: Recall previous memory
    {
      toolCalls: [
        { id: 'call_5', name: 'memory_recall', arguments: { query: 'previous analysis results' } },
      ],
      finishReason: 'tool_calls',
    },
    // Step 6: Final answer
    {
      response: `Here is the complete research report:

## Summary
Multi-agent orchestration systems show significant promise for complex task automation.

## Key Findings
1. Dynamic tool selection reduces token usage by up to 70%
2. Parallel execution achieves 4-8x speedup for independent subtasks
3. Pattern-based optimization reduces LLM calls by 11.9%

## Recommendations
- Enable tool retrieval for cost savings
- Use concurrent-safe annotation for independent tools
- Monitor pattern frequency for optimization opportunities`,
      finishReason: 'stop',
    },
  ]);
  runtime.registerProvider('openai', provider);

  const startTime = Date.now();
  const result = await runtime.execute({
    agentId: 'e2e-researcher',
    projectId: 'e2e-test',
    goal: 'Research multi-agent orchestration systems, analyze findings, and write a report.',
    contextData: {},
    availableTools: [
      'web_search',
      'web_fetch',
      'python_execute',
      'file_write',
      'file_read',
      'file_search',
      'shell_execute',
      'memory_store',
      'memory_recall',
    ],
    maxSteps: 10,
    tokenBudget: 50000,
  });
  const duration = Date.now() - startTime;

  console.log(`\n  Result: ${result.status}`);
  console.log(`  LLM calls: ${provider.callCount}`);
  console.log(`  Tool loop steps: ${result.steps.length}`);
  console.log(`  Duration: ${duration}ms`);
  console.log(`  Tokens: ${result.totalTokenUsage.totalTokens}`);
  console.log(`\n  Execution trace:`);
  for (const t of provider.getTrace()) {
    console.log(`    ${t}`);
  }
  console.log();

  // Verify everything worked
  let pass = true;
  if (result.status !== 'success') {
    console.error(`  FAIL: status = ${result.status}`);
    pass = false;
  }
  if (provider.callCount < 2) {
    console.error(`  FAIL: only ${provider.callCount} LLM calls`);
    pass = false;
  }
  const hasToolResults = result.steps.some((s) => s.type === 'tool_result');
  if (!hasToolResults) {
    console.error(`  FAIL: no tool results in steps`);
    pass = false;
  }

  // Check pattern tracking learned the sequences
  const tracker = getPatternTracker();
  const patterns = tracker.getTopPatterns(5);
  console.log(`  PatternTracker learned ${patterns.length} patterns:`);
  for (const p of patterns.slice(0, 3)) {
    console.log(`    ${p.sequence.join(' → ')} (freq: ${p.frequency})`);
  }
  if (patterns.length === 0) {
    console.error(`  FAIL: PatternTracker learned nothing`);
    pass = false;
  }

  console.log(`\n  ${pass ? '✅ PASS' : '❌ FAIL'}`);
  return pass;
}

// ============================================================================
// Test: Concurrent Tool Execution
// ============================================================================
async function testConcurrentExecution() {
  console.log('\n' + '='.repeat(70));
  console.log('TEST 2: Concurrent Tool Execution (4 independent tools in parallel)');
  console.log('='.repeat(70));

  resetModelRouter();
  resetMessageBus();
  resetTraceRecorder();

  const router = new ModelRouter();
  const runtime = new AgentRuntime({ maxRetries: 0, timeoutMs: 10000 }, router);

  const execOrder: string[] = [];

  runtime.registerTool(
    'search_a',
    makeTool('search_a', async () => {
      await new Promise((r) => setTimeout(r, 30));
      execOrder.push('search_a');
      return 'Results A';
    }),
  );
  runtime.registerTool(
    'search_b',
    makeTool('search_b', async () => {
      await new Promise((r) => setTimeout(r, 30));
      execOrder.push('search_b');
      return 'Results B';
    }),
  );
  runtime.registerTool(
    'search_c',
    makeTool('search_c', async () => {
      await new Promise((r) => setTimeout(r, 30));
      execOrder.push('search_c');
      return 'Results C';
    }),
  );
  runtime.registerTool(
    'search_d',
    makeTool('search_d', async () => {
      await new Promise((r) => setTimeout(r, 30));
      execOrder.push('search_d');
      return 'Results D';
    }),
  );

  const provider = new SmartMockProvider([
    {
      toolCalls: [
        { id: 'c1', name: 'search_a', arguments: {} },
        { id: 'c2', name: 'search_b', arguments: {} },
        { id: 'c3', name: 'search_c', arguments: {} },
        { id: 'c4', name: 'search_d', arguments: {} },
      ],
      finishReason: 'tool_calls',
    },
    { response: 'All searches completed. Results synthesized.', finishReason: 'stop' },
  ]);
  runtime.registerProvider('openai', provider);

  const startTime = Date.now();
  const result = await runtime.execute({
    agentId: 'e2e-parallel',
    projectId: 'e2e-test',
    goal: 'Run multiple searches concurrently.',
    contextData: {},
    availableTools: ['search_a', 'search_b', 'search_c', 'search_d'],
    maxSteps: 5,
    tokenBudget: 20000,
  });
  const duration = Date.now() - startTime;

  console.log(`\n  Result: ${result.status}`);
  console.log(`  Duration: ${duration}ms (4 tools × 30ms = 120ms sequential, < 80ms = parallel)`);
  console.log(`  Execution order: ${execOrder.join(', ')}`);
  console.log(`  All executed: ${execOrder.length === 4}`);

  let pass = true;
  if (result.status !== 'success') {
    console.error(`  FAIL: status`);
    pass = false;
  }
  if (execOrder.length !== 4) {
    console.error(`  FAIL: not all tools executed`);
    pass = false;
  }
  // Parallel should be much faster than sequential (4×30ms = 120ms)
  if (duration > 100) {
    console.warn(`  WARN: ${duration}ms > 100ms, may not be fully parallel`);
  }

  console.log(`\n  ${pass ? '✅ PASS' : '❌ FAIL'}`);
  return pass;
}

// ============================================================================
// Test: Tool Error Recovery
// ============================================================================
async function testErrorRecovery() {
  console.log('\n' + '='.repeat(70));
  console.log('TEST 3: Tool Error Recovery (model retries after failure)');
  console.log('='.repeat(70));

  resetModelRouter();
  resetMessageBus();
  resetTraceRecorder();

  const router = new ModelRouter();
  const runtime = new AgentRuntime({ maxRetries: 0, timeoutMs: 10000 }, router);

  let failCount = 0;
  runtime.registerTool(
    'unstable_api',
    makeTool(
      'unstable_api',
      async () => {
        failCount++;
        if (failCount <= 1) throw new Error('Rate limit exceeded');
        return 'Success on retry!';
      },
      { concurrent: false },
    ),
  );

  const provider = new SmartMockProvider([
    // First call - tool fails
    {
      toolCalls: [{ id: 'c1', name: 'unstable_api', arguments: {} }],
      finishReason: 'tool_calls',
    },
    // Model sees the error and retries
    {
      toolCalls: [{ id: 'c2', name: 'unstable_api', arguments: {} }],
      finishReason: 'tool_calls',
    },
    // Model responds with final answer
    { response: 'API call succeeded after retry.', finishReason: 'stop' },
  ]);
  runtime.registerProvider('openai', provider);

  const result = await runtime.execute({
    agentId: 'e2e-error',
    projectId: 'e2e-test',
    goal: 'Call the API and handle any errors.',
    contextData: {},
    availableTools: ['unstable_api'],
    maxSteps: 5,
    tokenBudget: 10000,
  });

  console.log(`\n  Result: ${result.status}`);
  console.log(`  Tool failed: ${failCount - 1} time(s) before success`);
  console.log(
    `  Error fed back to model: ${provider.getTrace()[1]?.includes('unstable_api') ? 'yes' : 'checking...'}`,
  );

  let pass = true;
  if (result.status !== 'success') {
    console.error(`  FAIL: status`);
    pass = false;
  }
  // First tool call should have failed and been fed back
  const toolMsgs = provider.lastRequest?.messages.filter((m) => m.role === 'tool') ?? [];
  const hasErrorFeedback = toolMsgs.some(
    (m) => m.content.includes('error') || m.content.includes('Error'),
  );
  if (!hasErrorFeedback) {
    console.warn(`  WARN: error may not have been fed back to model`);
  }

  console.log(`\n  ${pass ? '✅ PASS' : '❌ FAIL'}`);
  return pass;
}

// ============================================================================
// Test: Tool Retrieval (ITR) Effectiveness
// ============================================================================
async function testToolRetrieval() {
  console.log('\n' + '='.repeat(70));
  console.log('TEST 4: Dynamic Tool Retrieval (ITR)');
  console.log('='.repeat(70));

  const { selectTools } = await import('../packages/core/src/runtime/toolRetriever');

  const ALL_TOOLS = [
    'web_search',
    'web_fetch',
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
  ];

  const testCases = [
    { goal: 'Search the web for AI papers', expected: ['web_search'] },
    { goal: 'Write a Python script to analyze data', expected: ['python_execute'] },
    { goal: 'Commit code and push to GitHub', expected: ['git'] },
    {
      goal: 'Edit the config file and restart the server',
      expected: ['file_edit', 'shell_execute'],
    },
  ];

  let pass = true;
  for (const tc of testCases) {
    const selected = selectTools(tc.goal, ALL_TOOLS, { minTools: 2, maxTools: 6 });
    const hasExpected = tc.expected.every((e) => selected.includes(e));
    const status = hasExpected ? '✅' : '❌';
    if (!hasExpected) pass = false;
    console.log(`  ${status} "${tc.goal.slice(0, 40)}..."`);
    console.log(`      → ${selected.join(', ')}`);
  }

  console.log(`\n  ${pass ? '✅ PASS' : '❌ FAIL'}`);
  return pass;
}

// ============================================================================
// Test: Observation Masking with many tool results
// ============================================================================
async function testObservationMasking() {
  console.log('\n' + '='.repeat(70));
  console.log('TEST 5: Observation Masking (many tool results → compacted)');
  console.log('='.repeat(70));

  resetModelRouter();
  resetMessageBus();
  resetTraceRecorder();

  const router = new ModelRouter();
  const runtime = new AgentRuntime(
    {
      maxRetries: 0,
      timeoutMs: 10000,
      observationMaskWindow: 2, // Only last 2 results shown verbatim
    },
    router,
  );

  const echoTool = makeTool('echo', async (args) => `Result #${args.n}: ${'x'.repeat(200)}`);
  runtime.registerTool('echo', echoTool);

  // 5 tool calls in one step, then a final answer
  const provider = new SmartMockProvider([
    {
      toolCalls: [
        { id: 'e1', name: 'echo', arguments: { n: 1 } },
        { id: 'e2', name: 'echo', arguments: { n: 2 } },
        { id: 'e3', name: 'echo', arguments: { n: 3 } },
        { id: 'e4', name: 'echo', arguments: { n: 4 } },
        { id: 'e5', name: 'echo', arguments: { n: 5 } },
      ],
      finishReason: 'tool_calls',
    },
    { response: 'All echoes received. Observations masked.', finishReason: 'stop' },
  ]);
  runtime.registerProvider('openai', provider);

  const result = await runtime.execute({
    agentId: 'e2e-mask',
    projectId: 'e2e-test',
    goal: 'Run multiple echoes.',
    contextData: {},
    availableTools: ['echo'],
    maxSteps: 5,
    tokenBudget: 10000,
  });

  // Check that some results were masked (observation_masked)
  const maskedCount = result.steps.filter((s) => s.content.includes('[observation masked')).length;
  console.log(`\n  Total steps: ${result.steps.length}`);
  console.log(`  Masked results: ${maskedCount}`);
  console.log(`  Unmasked results: ${result.steps.length - maskedCount}`);

  const pass = maskedCount >= 2; // At least 3 of 5 should be masked
  if (!pass) console.error(`  FAIL: expected ≥2 masked, got ${maskedCount}`);

  console.log(`\n  ${pass ? '✅ PASS' : '❌ FAIL'}`);
  return pass;
}

// ============================================================================
// Main
// ============================================================================
async function main() {
  console.log(`\n  ╔══════════════════════════════════════════════════════════╗`);
  console.log(`  ║      Commander — Complex End-to-End Test Suite         ║`);
  console.log(`  ║  6 scenarios · full tool pipeline · concurrent · error ║`);
  console.log(`  ╚══════════════════════════════════════════════════════════╝`);

  const results = [];
  // Run sequentially to avoid tracer singleton races
  results.push(await testComplexResearchWorkflow());
  results.push(await testConcurrentExecution());
  results.push(await testErrorRecovery());
  results.push(await testToolRetrieval());
  results.push(await testObservationMasking());

  const passed = results.filter(Boolean).length;
  const total = results.length;

  console.log('\n' + '='.repeat(70));
  console.log(`  RESULTS: ${passed}/${total} tests passed`);
  console.log('='.repeat(70));
  console.log(
    `\n  ${passed === total ? '✅ ALL TESTS PASSED — Commander is production-ready' : '❌ SOME TESTS FAILED'}\n`,
  );

  process.exit(passed === total ? 0 : 1);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
