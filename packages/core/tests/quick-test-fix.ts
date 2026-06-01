#!/usr/bin/env npx tsx
import * as fs from 'fs';

async function main() {
  const { AgentRuntime } = await import('../src/runtime/agentRuntime');
  const { TELOSOrchestrator } = await import('../src/telos/telosOrchestrator');
  const { UltimateOrchestrator } = await import('../src/ultimate/orchestrator');
  const { MiMoProvider } = await import('../src/runtime/providers/mimoProvider');
  const { WebSearchTool, WebFetchTool } = await import('../src/tools/webSearchTool');
  const { FileReadTool, FileWriteTool, FileEditTool, FileListTool, FileSearchTool } = await import('../src/tools/fileSystemTool');

  const provider = new MiMoProvider({
    apiKey: 'tp-sgmq4chswvythfusfq43fbjnn9adnhzqzzf7v99b3a9kp9pz',
    baseUrl: 'https://token-plan-sgp.xiaomimimo.com/v1',
    defaultModel: 'mimo-v2.5-pro',
  });

  const runtime = new AgentRuntime({
    budgetHardCapTokens: 800_000,
    maxSteps: 20,
  });
  runtime.registerProvider('mimo', provider);
  runtime.registerProvider('openai', provider);

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

  const outputFile = '/tmp/quick-test-review.md';
  try { fs.unlinkSync(outputFile); } catch {}

  console.log('Running security-audit task with improved prompting...');
  const start = Date.now();
  const result = await orchestrator.execute({
    projectId: 'quick-test',
    agentId: 'test-agent',
    goal: `Write the unified security audit to ${outputFile}. Review these 3 files simultaneously and produce a unified security audit: 1. packages/core/src/runtime/agentRuntime.ts — focus on input validation and injection risks 2. packages/core/src/tools/fileSystemTool.ts — focus on path traversal and symlink attacks 3. packages/core/src/ultimate/orchestrator.ts — focus on privilege escalation and sandbox escapes. For each file, identify vulnerabilities with severity ratings. Then produce a unified report with executive summary, top 5 critical findings with line numbers, recommended fixes with code examples, and risk matrix.`,
    contextData: {
      availableTools: ['web_search', 'web_fetch', 'file_write', 'file_read', 'file_list', 'file_edit', 'file_search'],
    },
  });

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  const outputSize = fs.existsSync(outputFile) ? fs.statSync(outputFile).size : 0;

  console.log('\nStatus:', result.status);
  console.log('Synthesis length:', result.synthesis.length, 'chars');
  console.log('Output file:', outputSize, 'bytes');
  console.log('Time:', elapsed + 's');
  console.log('\nReasoning:');
  for (const r of result.reasoning) console.log('  -', r);
}

main().catch(e => { console.error(e.message); process.exit(1); });
