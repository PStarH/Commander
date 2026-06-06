/**
 * Quick test: run only the multifile refactoring task
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';

// Load .env
function loadEnv(): void {
  let dir = process.cwd();
  for (let i = 0; i < 5; i++) {
    const envPath = path.join(dir, '.env');
    if (fs.existsSync(envPath)) {
      for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx === -1) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        const val = trimmed.slice(eqIdx + 1).trim();
        if (key && val && !process.env[key]) process.env[key] = val;
      }
      return;
    }
    dir = path.dirname(dir);
  }
}
loadEnv();

import { AgentRuntime } from '../../packages/core/src/runtime/agentRuntime';
import { MiMoProvider } from '../../packages/core/src/runtime/providers/mimoProvider';
import { getModelRouter } from '../../packages/core/src/runtime/modelRouter';
import { createAllTools } from '../../packages/core/src/tools/index';

const API_KEY = process.env.OPENAI_API_KEY || process.env.MIMO_API_KEY || '';
const BASE_URL = process.env.OPENAI_BASE_URL || process.env.MIMO_BASE_URL || 'https://token-plan-sgp.xiaomimimo.com/v1';
const MODEL = 'mimo-v2.5-pro';

const PINCH_TOOLS = [
  'file_read', 'file_write', 'file_edit', 'file_list',
  'python_execute', 'shell_execute',
  'web_search', 'web_fetch',
];

// Setup runtime
const runtime = new AgentRuntime({ budgetHardCapTokens: 64000 });
const allTools = createAllTools();
for (const [name, tool] of allTools) runtime.registerTool(name, tool);
runtime.registerProvider('mimo', new MiMoProvider({
  apiKey: API_KEY,
  baseUrl: BASE_URL,
  defaultModel: MODEL,
}));
const router = getModelRouter();
for (const tier of ['eco', 'standard', 'power', 'consensus'] as const) {
  router.registerModel({
    id: `${MODEL}@${tier}`, provider: 'mimo', tier,
    costPer1KInput: 0.004, costPer1KOutput: 0.012,
    capabilities: ['code', 'reasoning', 'analysis', 'creative', 'math'],
    contextWindow: 128000, priority: -1,
  });
}

// Parse task
const taskFile = path.join(__dirname, 'tasks/task_multi_file_refactoring.md');
const content = fs.readFileSync(taskFile, 'utf-8');
const promptMatch = content.match(/## Prompt\n\n([\s\S]*?)(?=\n## |$)/);
const prompt = promptMatch?.[1]?.trim() || '';
const gradingMatch = content.match(/```python\n([\s\S]*?)```/);
const grading_code = gradingMatch?.[1]?.trim() || '';

async function main() {
  const workspaceDir = '/tmp/pinch-multifile-test';
  fs.mkdirSync(workspaceDir, { recursive: true });

  // Set COMMANDER_WORKSPACE so file tools use the correct directory
  process.env.COMMANDER_WORKSPACE = workspaceDir;

  // Copy workspace files from assets
  const assetsDir = path.join(__dirname, 'assets/refactor');
  const workspaceFiles = ['utils.py', 'orders.py', 'reports.py', 'api.py'];
  for (const file of workspaceFiles) {
    const srcPath = path.join(assetsDir, file);
    const destPath = path.join(workspaceDir, file);
    if (fs.existsSync(srcPath)) {
      fs.copyFileSync(srcPath, destPath);
      console.log(`Copied: ${file}`);
    } else {
      console.log(`Warning: asset not found: ${srcPath}`);
    }
  }

  console.log('\n=== Multifile Refactoring Task ===');
  console.log('Prompt preview:', prompt.slice(0, 300));
  console.log('Workspace:', workspaceDir);
  console.log('');

  const goal = prompt;

  console.log('Running agent...');
  const startTime = Date.now();

  const result = await runtime.execute({
    agentId: 'pinch-multifile',
    projectId: 'pinchbench',
    goal,
    contextData: {},
    availableTools: PINCH_TOOLS,
    maxSteps: 30,
    tokenBudget: 50000,
  });

  const durationMs = Date.now() - startTime;
  console.log(`\nAgent finished in ${(durationMs / 1000).toFixed(1)}s`);
  console.log('Status:', result.status);
  console.log('Summary length:', (result.summary || '').length);
  console.log('Summary preview:', (result.summary || '').slice(0, 800));

  // List workspace files
  console.log('\n=== Workspace Files ===');
  try {
    const files = fs.readdirSync(workspaceDir);
    for (const f of files) {
      const stat = fs.statSync(path.join(workspaceDir, f));
      console.log(`  ${f} (${stat.size} bytes)`);
      if (f.endsWith('.py') && stat.size < 5000) {
        console.log(fs.readFileSync(path.join(workspaceDir, f), 'utf-8'));
      }
    }
  } catch (e) {
    console.log('Error listing files:', (e as Error).message);
  }

  // Grade
  if (grading_code) {
    console.log('\n=== Grading ===');
    const gradingScript = `
import json, os, sys

workspace_path = '${workspaceDir}'
transcript = []

${grading_code}

result = grade(transcript, workspace_path)
print(json.dumps(result))
`;
    const gradingFile = path.join(workspaceDir, '_grade.py');
    fs.writeFileSync(gradingFile, gradingScript);
    try {
      const gradeResult = execSync(`python3 "${gradingFile}"`, {
        timeout: 30000,
        encoding: 'utf-8',
        cwd: workspaceDir,
      });
      const parsed = JSON.parse(gradeResult.trim());
      console.log('Grade result:', JSON.stringify(parsed, null, 2));

      let passed = false;
      if (parsed.passed !== undefined) passed = parsed.passed;
      else if (parsed.score !== undefined) passed = parsed.score >= 0.8;
      else {
        const scores = Object.values(parsed).filter(v => typeof v === 'number') as number[];
        const avgScore = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
        passed = avgScore >= 0.8;
      }
      console.log('\nPASSED:', passed ? '✅ YES' : '❌ NO');
    } catch (e: any) {
      console.log('Grading error:', e.message?.slice(0, 300));
      console.log('PASSED: ❌ NO');
    }
  }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
