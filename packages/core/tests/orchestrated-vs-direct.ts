#!/usr/bin/env npx tsx
/**
 * Commander (Orchestrated) vs Direct LLM API — Fair Comparison
 *
 * Same model (mimo-v2.5), same tasks, same tools available.
 * Commander uses the full 8-phase orchestration pipeline.
 * Direct sends the same prompt straight to the LLM with basic tool-calling.
 *
 * Measures: latency, tokens, success rate, output quality, tool usage.
 *
 * Usage:
 *   OPENAI_API_KEY=... OPENAI_BASE_URL=... OPENAI_MODEL=... npx tsx packages/core/tests/orchestrated-vs-direct.ts
 */

import * as fs from 'fs';
import * as path from 'path';

// ── Config ───────────────────────────────────────────────────────────────────
const API_KEY = process.env.OPENAI_API_KEY;
const BASE_URL = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
const MODEL = process.env.OPENAI_MODEL || 'gpt-4o';
const OUTPUT_DIR = process.env.COMPARE_OUTPUT || path.join(process.cwd(), '.compare-output');

if (!API_KEY) {
  console.error('ERROR: OPENAI_API_KEY is required');
  process.exit(1);
}

// ── Task Definitions ─────────────────────────────────────────────────────────
interface ComparisonTask {
  name: string;
  category: string;
  goal: string;
  outputFile: string;
  minExpectedBytes: number;
}

const TASKS: ComparisonTask[] = [
  {
    name: 'research-consensus',
    category: 'research',
    goal: 'Research Raft vs Paxos consensus algorithms. Compare fault tolerance, performance, and complexity. Write a detailed comparison table to /tmp/compare-consensus.md',
    outputFile: '/tmp/compare-consensus.md',
    minExpectedBytes: 500,
  },
  {
    name: 'analyze-runtime',
    category: 'analysis',
    goal: 'Analyze the packages/core/src/runtime/ directory structure. List the main modules, their responsibilities, and key design patterns used. Write findings to /tmp/compare-runtime-analysis.md',
    outputFile: '/tmp/compare-runtime-analysis.md',
    minExpectedBytes: 500,
  },
  {
    name: 'implement-lru-cache',
    category: 'coding',
    goal: 'Write a TypeScript implementation of an LRU cache with get/set operations and O(1) time complexity using a doubly-linked list and Map. Include proper types and unit tests. Write to /tmp/compare-lru-cache.ts',
    outputFile: '/tmp/compare-lru-cache.ts',
    minExpectedBytes: 300,
  },
  {
    name: 'write-blog-cpm',
    category: 'creative',
    goal: 'Write a technical blog post about how multi-agent AI systems can use Critical Path Method for task scheduling. Include code examples and ASCII diagrams. Write to /tmp/compare-blog-cpm.md',
    outputFile: '/tmp/compare-blog-cpm.md',
    minExpectedBytes: 500,
  },
  {
    name: 'plan-migration',
    category: 'planning',
    goal: 'Create a migration plan for moving a TypeScript monorepo to multi-repo. Include dependency analysis, migration phases, risk mitigation, and rollback strategy. Write to /tmp/compare-migration-plan.md',
    outputFile: '/tmp/compare-migration-plan.md',
    minExpectedBytes: 500,
  },
  {
    name: 'multi-error-handling',
    category: 'multi',
    goal: 'Research error handling patterns in distributed systems. Then analyze the error handling in packages/core/src/runtime/ and propose 3 specific improvements with code examples. Write to /tmp/compare-error-handling.md',
    outputFile: '/tmp/compare-error-handling.md',
    minExpectedBytes: 500,
  },
];

// ── Results ──────────────────────────────────────────────────────────────────
interface TaskResult {
  system: 'commander' | 'direct-llm';
  taskName: string;
  category: string;
  durationMs: number;
  tokensUsed: number;
  success: boolean;
  outputSize: number;
  toolCalls: number;
  error?: string;
}

// ── Direct LLM API Runner ────────────────────────────────────────────────────
// Simulates what a basic agent would do: send prompt, get response, maybe use tools
async function runDirectLLM(task: ComparisonTask): Promise<TaskResult> {
  const start = Date.now();
  let totalTokens = 0;
  let toolCalls = 0;

  try {
    // System prompt with tool descriptions (similar to what Commander sends)
    const systemPrompt = `You are a helpful AI assistant. You have access to the following tools:

1. web_search(query: string, numResults?: number) - Search the web for information
2. web_fetch(url: string, maxChars?: number) - Fetch a webpage's content
3. file_write(path: string, content: string) - Write content to a file
4. file_read(path: string) - Read a file's content
5. file_list(dir: string) - List files in a directory

To use a tool, respond with a JSON block:
\`\`\`tool
{"name": "tool_name", "arguments": {"arg1": "value1"}}
\`\`\`

After getting tool results, continue with your response. When done, write the final output to the specified file using file_write.`;

    const messages: Array<{ role: string; content: string }> = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: task.goal },
    ];

    // Multi-turn loop: LLM -> tool calls -> LLM -> ... (max 10 turns)
    let finalResponse = '';
    for (let turn = 0; turn < 10; turn++) {
      const response = await callLLM(messages);
      totalTokens += response.tokens;

      if (!response.content) break;

      // Check for tool calls
      const toolMatch = response.content.match(/```tool\s*\n([\s\S]*?)```/);
      if (!toolMatch) {
        // No tool call — this is the final response
        finalResponse = response.content;
        break;
      }

      // Parse and execute tool call
      try {
        const toolCall = JSON.parse(toolMatch[1]);
        toolCalls++;
        const toolResult = await executeToolCall(toolCall.name, toolCall.arguments);

        // Add to conversation
        messages.push({ role: 'assistant', content: response.content });
        messages.push({ role: 'user', content: `Tool result:\n${toolResult}` });
      } catch {
        // If tool call parsing fails, treat as final response
        finalResponse = response.content;
        break;
      }
    }

    // Check if output file was written
    let outputSize = 0;
    try { outputSize = fs.statSync(task.outputFile).size; } catch {}

    // If no file was written but we have a response, write it
    if (outputSize === 0 && finalResponse.length > 100) {
      fs.mkdirSync(path.dirname(task.outputFile), { recursive: true });
      fs.writeFileSync(task.outputFile, finalResponse);
      outputSize = finalResponse.length;
    }

    return {
      system: 'direct-llm',
      taskName: task.name,
      category: task.category,
      durationMs: Date.now() - start,
      tokensUsed: totalTokens,
      success: outputSize >= task.minExpectedBytes,
      outputSize,
      toolCalls,
    };
  } catch (err) {
    return {
      system: 'direct-llm',
      taskName: task.name,
      category: task.category,
      durationMs: Date.now() - start,
      tokensUsed: totalTokens,
      success: false,
      outputSize: 0,
      toolCalls,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function callLLM(messages: Array<{ role: string; content: string }>): Promise<{ content: string; tokens: number }> {
  const body = {
    model: MODEL,
    messages,
    max_tokens: 4096,
    temperature: 0.7,
  };

  const resp = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${API_KEY}`,
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`LLM API error ${resp.status}: ${errText.slice(0, 200)}`);
  }

  const data = await resp.json() as any;
  const content = data.choices?.[0]?.message?.content ?? '';
  const tokens = data.usage?.total_tokens ?? 0;

  return { content, tokens };
}

async function executeToolCall(name: string, args: Record<string, unknown>): Promise<string> {
  try {
    switch (name) {
      case 'web_search': {
        const query = String(args.query ?? '');
        const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&cc=us&mkt=en-US&setlang=en`;
        const resp = await fetch(url, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
          signal: AbortSignal.timeout(15000),
        });
        const html = await resp.text();
        // Simple extraction
        const results: string[] = [];
        const blockRegex = /<h2[^>]*><a[^>]*href="([^"]+)"[^>]*>(.*?)<\/a><\/h2>/g;
        let m;
        while ((m = blockRegex.exec(html)) !== null && results.length < 5) {
          results.push(`${m[2].replace(/<[^>]*>/g, '')} - ${m[1]}`);
        }
        return results.length > 0 ? results.join('\n') : 'No results found';
      }
      case 'web_fetch': {
        const url = String(args.url ?? '');
        const resp = await fetch(url, {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Bot)' },
          signal: AbortSignal.timeout(15000),
        });
        const html = await resp.text();
        return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 5000);
      }
      case 'file_write': {
        const filePath = String(args.path ?? '');
        const content = String(args.content ?? '');
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, content);
        return `Written ${content.length} bytes to ${filePath}`;
      }
      case 'file_read': {
        const filePath = String(args.path ?? '');
        return fs.readFileSync(filePath, 'utf-8').slice(0, 5000);
      }
      case 'file_list': {
        const dir = String(args.dir ?? '.');
        return fs.readdirSync(dir).join('\n');
      }
      default:
        return `Unknown tool: ${name}`;
    }
  } catch (err) {
    return `Tool error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// ── Commander Runner ─────────────────────────────────────────────────────────
async function runCommander(task: ComparisonTask): Promise<TaskResult> {
  const start = Date.now();

  try {
    const { AgentRuntime } = await import('../src/runtime/agentRuntime');
    const { TELOSOrchestrator } = await import('../src/telos/telosOrchestrator');
    const { UltimateOrchestrator } = await import('../src/ultimate/orchestrator');
    const { MiMoProvider } = await import('../src/runtime/providers/mimoProvider');

    const provider = new MiMoProvider({
      apiKey: API_KEY!,
      baseUrl: BASE_URL,
      defaultModel: MODEL,
    });

    const runtime = new AgentRuntime({
      budgetHardCapTokens: 500_000,
      maxSteps: 15,
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
      maxRecursiveDepth: 1,
      maxParallelSubAgents: 1,
    });

    const result = await orchestrator.execute({
      projectId: 'compare-commander',
      agentId: `compare-${task.name}`,
      goal: task.goal,
      contextData: {
        availableTools: ['web_search', 'web_fetch', 'file_write', 'file_read', 'file_list', 'file_edit'],
      },
    });

    const durationMs = Date.now() - start;
    const tokens = result.metrics?.totalTokens ?? 0;

    let outputSize = 0;
    try { outputSize = fs.statSync(task.outputFile).size; } catch {}

    return {
      system: 'commander',
      taskName: task.name,
      category: task.category,
      durationMs,
      tokensUsed: tokens,
      success: outputSize >= task.minExpectedBytes,
      outputSize,
      toolCalls: 0, // Commander doesn't expose this easily
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
      toolCalls: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║  Commander (Orchestrated) vs Direct LLM API                ║');
  console.log('╠══════════════════════════════════════════════════════════════╣');
  console.log(`║  Model:     ${MODEL.padEnd(47)}║`);
  console.log(`║  Tasks:     ${(TASKS.length + ' per system').padEnd(47)}║`);
  console.log(`║  Output:    ${OUTPUT_DIR.slice(0, 47).padEnd(47)}║`);
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log('');

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const allResults: TaskResult[] = [];

  for (const task of TASKS) {
    console.log(`\n${'═'.repeat(60)}`);
    console.log(`TASK: ${task.name} [${task.category}]`);
    console.log(`${'═'.repeat(60)}`);

    // Clean up output file
    try { fs.unlinkSync(task.outputFile); } catch {}

    // Run Direct LLM first (simpler, faster baseline)
    console.log(`  ├─ Running Direct LLM...`);
    const directResult = await runDirectLLM(task);
    allResults.push(directResult);
    const directOut = directResult.success ? `${(directResult.outputSize / 1024).toFixed(1)}KB` : 'FAIL';
    console.log(`  │  ${directResult.success ? '✅' : '❌'} ${(directResult.durationMs / 1000).toFixed(1)}s | ${directResult.tokensUsed.toLocaleString()} tok | ${directOut} | ${directResult.toolCalls} tools${directResult.error ? ` | ${directResult.error.slice(0, 60)}` : ''}`);

    // Save direct output for comparison
    let directOutput = '';
    try { directOutput = fs.readFileSync(task.outputFile, 'utf-8'); } catch {}

    // Clean up
    try { fs.unlinkSync(task.outputFile); } catch {}

    // Pause to avoid rate limiting
    await new Promise(r => setTimeout(r, 5000));

    // Run Commander
    console.log(`  ├─ Running Commander...`);
    const cmdResult = await runCommander(task);
    allResults.push(cmdResult);
    const cmdOut = cmdResult.success ? `${(cmdResult.outputSize / 1024).toFixed(1)}KB` : 'FAIL';
    console.log(`  │  ${cmdResult.success ? '✅' : '❌'} ${(cmdResult.durationMs / 1000).toFixed(1)}s | ${cmdResult.tokensUsed.toLocaleString()} tok | ${cmdOut}${cmdResult.error ? ` | ${cmdResult.error.slice(0, 60)}` : ''}`);

    // Save outputs for quality comparison
    let cmdOutput = '';
    try { cmdOutput = fs.readFileSync(task.outputFile, 'utf-8'); } catch {}

    // Write comparison
    const comparison = {
      task: task.name,
      category: task.category,
      direct: {
        success: directResult.success,
        durationSec: (directResult.durationMs / 1000).toFixed(1),
        tokens: directResult.tokensUsed,
        outputBytes: directResult.outputSize,
        toolCalls: directResult.toolCalls,
        outputPreview: directOutput.slice(0, 500),
      },
      commander: {
        success: cmdResult.success,
        durationSec: (cmdResult.durationMs / 1000).toFixed(1),
        tokens: cmdResult.tokensUsed,
        outputBytes: cmdResult.outputSize,
        outputPreview: cmdOutput.slice(0, 500),
      },
    };
    fs.writeFileSync(path.join(OUTPUT_DIR, `${task.name}.json`), JSON.stringify(comparison, null, 2));

    // Pause between tasks
    await new Promise(r => setTimeout(r, 5000));
  }

  // ── Summary ──────────────────────────────────────────────────────────────
  const directResults = allResults.filter(r => r.system === 'direct-llm');
  const cmdResults = allResults.filter(r => r.system === 'commander');

  const directSuccess = directResults.filter(r => r.success).length;
  const cmdSuccess = cmdResults.filter(r => r.success).length;
  const directTokens = directResults.reduce((s, r) => s + r.tokensUsed, 0);
  const cmdTokens = cmdResults.reduce((s, r) => s + r.tokensUsed, 0);
  const directTime = directResults.reduce((s, r) => s + r.durationMs, 0);
  const cmdTime = cmdResults.reduce((s, r) => s + r.durationMs, 0);
  const directOutput = directResults.reduce((s, r) => s + r.outputSize, 0);
  const cmdOutput = cmdResults.reduce((s, r) => s + r.outputSize, 0);
  const directTools = directResults.reduce((s, r) => s + r.toolCalls, 0);

  const summary = {
    model: MODEL,
    timestamp: new Date().toISOString(),
    tasksPerSystem: TASKS.length,
    directLLM: {
      successRate: `${directSuccess}/${TASKS.length}`,
      totalTokens: directTokens,
      totalTimeSec: (directTime / 1000).toFixed(1),
      avgTimeSec: (directTime / TASKS.length / 1000).toFixed(1),
      totalOutputBytes: directOutput,
      totalToolCalls: directTools,
    },
    commander: {
      successRate: `${cmdSuccess}/${TASKS.length}`,
      totalTokens: cmdTokens,
      totalTimeSec: (cmdTime / 1000).toFixed(1),
      avgTimeSec: (cmdTime / TASKS.length / 1000).toFixed(1),
      totalOutputBytes: cmdOutput,
    },
    overhead: {
      tokenMultiplier: cmdTokens > 0 && directTokens > 0 ? (cmdTokens / directTokens).toFixed(2) + 'x' : 'N/A',
      timeMultiplier: cmdTime > 0 && directTime > 0 ? (cmdTime / directTime).toFixed(2) + 'x' : 'N/A',
      outputRatio: cmdOutput > 0 && directOutput > 0 ? (cmdOutput / directOutput).toFixed(2) + 'x' : 'N/A',
    },
    perTask: allResults.map(r => ({
      system: r.system,
      task: r.taskName,
      category: r.category,
      success: r.success,
      durationSec: (r.durationMs / 1000).toFixed(1),
      tokens: r.tokensUsed,
      outputBytes: r.outputSize,
      toolCalls: r.toolCalls,
      error: r.error?.slice(0, 100),
    })),
  };

  fs.writeFileSync(path.join(OUTPUT_DIR, 'comparison-summary.json'), JSON.stringify(summary, null, 2));

  console.log(`\n${'═'.repeat(60)}`);
  console.log('COMPARISON RESULTS');
  console.log(`${'═'.repeat(60)}`);
  console.log('');
  console.log('                        Direct LLM      Commander');
  console.log('                        ───────────      ─────────');
  console.log(`  Success Rate:         ${(summary.directLLM.successRate).padEnd(16)} ${summary.commander.successRate}`);
  console.log(`  Total Tokens:         ${(summary.directLLM.totalTokens.toLocaleString()).padEnd(16)} ${summary.commander.totalTokens.toLocaleString()}`);
  console.log(`  Total Time:           ${(summary.directLLM.totalTimeSec + 's').padEnd(16)} ${summary.commander.totalTimeSec}s`);
  console.log(`  Avg Time/Task:        ${(summary.directLLM.avgTimeSec + 's').padEnd(16)} ${summary.commander.avgTimeSec}s`);
  console.log(`  Output Generated:     ${(summary.directLLM.totalOutputBytes + ' bytes').padEnd(16)} ${summary.commander.totalOutputBytes} bytes`);
  console.log(`  Tool Calls:           ${(String(summary.directLLM.totalToolCalls)).padEnd(16)} N/A`);
  console.log('');
  console.log('  Overhead (Commander vs Direct):');
  console.log(`    Token Multiplier:   ${summary.overhead.tokenMultiplier}`);
  console.log(`    Time Multiplier:    ${summary.overhead.timeMultiplier}`);
  console.log(`    Output Ratio:       ${summary.overhead.outputRatio}`);
  console.log('');

  console.log('Per-task comparison:');
  for (const task of TASKS) {
    const direct = allResults.find(r => r.system === 'direct-llm' && r.taskName === task.name);
    const cmd = allResults.find(r => r.system === 'commander' && r.taskName === task.name);
    console.log(`\n  ${task.name} [${task.category}]:`);
    console.log(`    Direct LLM: ${direct?.success ? '✅' : '❌'} ${(direct?.durationMs ?? 0) / 1000}s | ${(direct?.tokensUsed ?? 0).toLocaleString()} tok | ${direct?.outputSize ?? 0} bytes | ${direct?.toolCalls ?? 0} tools`);
    console.log(`    Commander:  ${cmd?.success ? '✅' : '❌'} ${(cmd?.durationMs ?? 0) / 1000}s | ${(cmd?.tokensUsed ?? 0).toLocaleString()} tok | ${cmd?.outputSize ?? 0} bytes`);
  }

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`Full results: ${OUTPUT_DIR}/`);
  console.log(`${'═'.repeat(60)}`);
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
