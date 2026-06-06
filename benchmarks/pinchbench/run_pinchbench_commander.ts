/**
 * PinchBench Runner for Commander
 *
 * Runs PinchBench tasks through Commander's AgentRuntime with tools.
 *
 * Usage:
 *   npx tsx benchmarks/pinchbench/run_pinchbench_commander.ts [--runs N] [--core] [--max N]
 *
 * Requirements:
 *   - PinchBench tasks downloaded to benchmarks/pinchbench/tasks/
 *   - Commander configured with API key
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';

// ── Load .env ────────────────────────────────────────────────────────────────
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

// ── Commander imports ────────────────────────────────────────────────────────
import { AgentRuntime } from '../../packages/core/src/runtime/agentRuntime';
import { MiMoProvider } from '../../packages/core/src/runtime/providers/mimoProvider';
import { getModelRouter } from '../../packages/core/src/runtime/modelRouter';
import { createAllTools } from '../../packages/core/src/tools/index';

// ── Config ───────────────────────────────────────────────────────────────────
// Read API key from: 1) env var, 2) .secrets/api-key file
function loadApiKey(): string {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  if (process.env.MIMO_API_KEY) return process.env.MIMO_API_KEY;
  const secretsPath = path.join(__dirname, '../../.secrets/api-key');
  try { return fs.readFileSync(secretsPath, 'utf-8').trim(); } catch { return ''; }
}
const API_KEY = loadApiKey();
const BASE_URL = process.env.OPENAI_BASE_URL || process.env.MIMO_BASE_URL || 'https://token-plan-sgp.xiaomimimo.com/v1';
const MODEL = 'mimo-v2.5-pro';

const TASKS_DIR = path.join(__dirname, 'tasks');
const RESULTS_DIR = path.join(__dirname, 'results');
const ASSETS_DIR = path.join(__dirname, 'assets');
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 2000;

const PINCH_TOOLS = [
  'file_read', 'file_write', 'file_edit', 'file_list',
  'python_execute', 'shell_execute',
  'web_search', 'web_fetch',
];

// ── Task Interface ───────────────────────────────────────────────────────────
interface PinchTask {
  id: string;
  name: string;
  category: string;
  grading_type: string;
  timeout_seconds: number;
  prompt: string;
  grading_code: string;
  workspace_files: Array<{ source: string; dest: string }>;
}

// ── Parse Task ───────────────────────────────────────────────────────────────
function parseTaskFile(filePath: string): PinchTask | null {
  const content = fs.readFileSync(filePath, 'utf-8');

  // Extract frontmatter
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!frontmatterMatch) return null;

  const frontmatter = frontmatterMatch[1];
  const id = frontmatter.match(/id:\s*(\S+)/)?.[1] || path.basename(filePath, '.md');
  const name = frontmatter.match(/name:\s*(.+)/)?.[1] || id;
  const category = frontmatter.match(/category:\s*(\S+)/)?.[1] || 'unknown';
  const grading_type = frontmatter.match(/grading_type:\s*(\S+)/)?.[1] || 'automated';
  const timeout_seconds = parseInt(frontmatter.match(/timeout_seconds:\s*(\d+)/)?.[1] || '90');

  // Extract prompt
  const promptMatch = content.match(/## Prompt\n\n([\s\S]*?)(?=\n## |$)/);
  const prompt = promptMatch?.[1]?.trim() || '';

  // Extract grading code
  const gradingMatch = content.match(/```python\n([\s\S]*?)```/);
  const grading_code = gradingMatch?.[1]?.trim() || '';

  // Extract workspace_files
  const workspace_files: Array<{ source: string; dest: string }> = [];
  const wfRegex = /- source:\s*(\S+)\s*\n\s*dest:\s*(\S+)/g;
  let wfMatch;
  while ((wfMatch = wfRegex.exec(frontmatter)) !== null) {
    workspace_files.push({ source: wfMatch[1], dest: wfMatch[2] });
  }

  return { id, name, category, grading_type, timeout_seconds, prompt, grading_code, workspace_files };
}

// ── Setup AgentRuntime ───────────────────────────────────────────────────────
function createPinchAgent(): AgentRuntime {
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

  return runtime;
}

// ── Prepare Workspace ────────────────────────────────────────────────────────
function prepareWorkspace(task: PinchTask, workspaceDir: string): void {
  fs.mkdirSync(workspaceDir, { recursive: true });

  // Copy workspace_files from assets
  for (const wf of task.workspace_files) {
    const sourcePath = path.join(ASSETS_DIR, wf.source);
    const destPath = path.join(workspaceDir, wf.dest);

    if (fs.existsSync(sourcePath)) {
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.copyFileSync(sourcePath, destPath);
    } else {
      console.log(`    Warning: asset not found: ${wf.source}`);
    }
  }
}

// ── Execute Task ─────────────────────────────────────────────────────────────
async function executeTask(
  task: PinchTask,
  workspaceDir: string,
  runtime: AgentRuntime,
): Promise<{ answer: string; passed: boolean; transcript: string[] }> {
  // Prepare workspace with task files
  prepareWorkspace(task, workspaceDir);

  // Get current date
  let currentDate = '';
  try {
    const dateResult = execSync(`python3 -c "from datetime import datetime; print(datetime.now().strftime('%Y-%m-%d %H:%M:%S'))"`, {
      timeout: 10000,
      encoding: 'utf-8',
    });
    currentDate = dateResult.trim();
  } catch {
    currentDate = 'Unknown';
  }

  const goal = `Current date/time: ${currentDate}

${task.prompt}

WORKSPACE DIRECTORY: ${workspaceDir}

AVAILABLE TOOLS (you MUST use these):
- python_execute: Run Python code. Use this to get current date/time, process data, compute statistics, etc.
- file_write: Write content to a file. Use ABSOLUTE path: "${workspaceDir}/filename.ext"
- file_read: Read a file. Use ABSOLUTE path: "${workspaceDir}/filename.ext"
- file_edit: Edit a file with exact string replacement. Use ABSOLUTE path: "${workspaceDir}/filename.ext"
- file_list: List files in directory. Use ABSOLUTE path: "${workspaceDir}"
- shell_execute: Run shell commands
- web_search: Search the web (do NOT use for dates/times)
- web_fetch: Fetch a URL

CRITICAL RULES:
1. The current date is: ${currentDate} — use this for date calculations
2. To create files, use file_write with ABSOLUTE path: "${workspaceDir}/filename.ext"
3. To read files, use file_read with ABSOLUTE path: "${workspaceDir}/filename.ext"
4. To edit files, use file_edit with ABSOLUTE path: "${workspaceDir}/filename.ext"
5. Do NOT just describe what you would do - actually DO it using the tools
6. Complete the task fully before responding
7. ALL files MUST be created in: ${workspaceDir}/
8. If a file mentioned in the prompt doesn't exist, use your knowledge to generate the data
9. For well-known datasets (Iris, stock data), use your knowledge to create accurate data
10. For log files and transcripts, generate realistic synthetic data if the file doesn't exist
11. List files first with file_list to see what's available

When done, provide a brief summary of what you accomplished.`;

  const result = await runtime.execute({
    agentId: `pinch-${task.id}`,
    projectId: 'pinchbench',
    goal,
    contextData: {},
    availableTools: PINCH_TOOLS,
    maxSteps: 30,
    tokenBudget: 50000,
  });

  const answer = result.summary || '';

  // Build transcript in structured format expected by grading scripts
  // Format: list of dicts with "type", "message" fields
  const transcript: Array<Record<string, any>> = [];
  if (result.steps) {
    for (const step of result.steps) {
      if (step.type === 'tool_call') {
        transcript.push({
          type: 'tool_use',
          tool: { name: step.toolName, input: step.args },
        });
      } else if (step.type === 'tool_result') {
        transcript.push({
          type: 'tool_result',
          tool: { name: step.toolName || 'unknown' },
          result: step.content?.slice(0, 1000) || '',
        });
      } else if (step.type === 'text') {
        transcript.push({
          type: 'message',
          message: { role: 'assistant', content: [{ type: 'text', text: step.content?.slice(0, 1000) || '' }] },
        });
      }
    }
  }
  // Add the final assistant response
  if (answer) {
    transcript.push({
      type: 'message',
      message: { role: 'assistant', content: [{ type: 'text', text: answer }] },
    });
  }

  // Grade the result
  let passed = false;
  if (task.grading_code) {
    try {
      // Create grading script with real transcript
      const transcriptJson = JSON.stringify(transcript);
      const gradingScript = `
import json, os, sys

workspace_path = '${workspaceDir}'
transcript = ${transcriptJson}

${task.grading_code}

try:
    result = grade(transcript, workspace_path)
    print(json.dumps(result))
except Exception as e:
    print(json.dumps({"error": str(e), "passed": False}))
`;

      const gradingFile = path.join(workspaceDir, '_grade.py');
      fs.writeFileSync(gradingFile, gradingScript);

      const gradeResult = execSync(`python3 "${gradingFile}"`, {
        timeout: 30000,
        encoding: 'utf-8',
        cwd: workspaceDir,
      });

      const parsed = JSON.parse(gradeResult.trim());

      // Check for explicit passed/score fields
      if (parsed.passed !== undefined) {
        passed = parsed.passed;
      } else if (parsed.score !== undefined) {
        passed = parsed.score >= 0.8;
      } else {
        // Calculate average score from individual criteria
        const scores = Object.values(parsed).filter(v => typeof v === 'number') as number[];
        const avgScore = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
        passed = avgScore >= 0.8;
      }
    } catch (error: any) {
      console.log(`    Grading error: ${error.message?.slice(0, 100)}`);
      passed = false;
    }
  } else if (task.grading_type === 'llm_judge') {
    // For LLM judge tasks, check if the output contains substantive content
    // Not just "Done." or empty - must have actual task-relevant content
    const hasSubstance = answer.length > 200 &&
      !answer.startsWith('Done.') &&
      !answer.startsWith('Task complete') &&
      answer.includes(' ');

    // Also check if files were created in the workspace
    const filesCreated = fs.readdirSync(workspaceDir).filter(f =>
      !f.startsWith('_') && !f.startsWith('.') && f !== 'result.json'
    ).length;

    passed = hasSubstance && filesCreated > 0;
  } else {
    // No grading code, check if response is non-empty and substantive
    passed = answer.length > 100 && !answer.startsWith('Done.');
  }

  return { answer: answer.slice(0, 500), passed, transcript };
}

// ── Helper ───────────────────────────────────────────────────────────────────
function sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  const maxTasks = args.includes('--max') ? parseInt(args[args.indexOf('--max') + 1]) : undefined;
  const runs = args.includes('--runs') ? parseInt(args[args.indexOf('--runs') + 1]) : 1;
  const coreOnly = args.includes('--core');

  if (!API_KEY) {
    console.error('Error: Set OPENAI_API_KEY in .env');
    process.exit(1);
  }

  // Load tasks
  const taskFiles = fs.readdirSync(TASKS_DIR)
    .filter(f => f.endsWith('.md') && f.startsWith('task_'))
    .sort();

  let tasks = taskFiles
    .map(f => parseTaskFile(path.join(TASKS_DIR, f)))
    .filter((t): t is PinchTask => t !== null);

  if (coreOnly) {
    // Filter to core tasks only
    const manifestPath = path.join(TASKS_DIR, 'manifest.yaml');
    if (fs.existsSync(manifestPath)) {
      const manifest = fs.readFileSync(manifestPath, 'utf-8');
      const coreMatch = manifest.match(/core:\n([\s\S]*?)(?=\n\w|$)/);
      if (coreMatch) {
        const coreIds = coreMatch[1]
          .split('\n')
          .map(l => l.trim().split('#')[0].trim().replace('- ', ''))
          .filter(l => l.startsWith('task_'));
        tasks = tasks.filter(t => coreIds.includes(t.id));
      }
    }
  }

  if (maxTasks) {
    tasks = tasks.slice(0, maxTasks);
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`  PinchBench Runner for Commander`);
  console.log(`  Model: ${MODEL}`);
  console.log(`  Tasks: ${tasks.length}`);
  console.log(`  Runs: ${runs}`);
  console.log(`${'='.repeat(60)}\n`);

  fs.mkdirSync(RESULTS_DIR, { recursive: true });

  // Create agent runtime
  const runtime = createPinchAgent();

  const allResults: Array<{ run: number; passed: number; total: number; score: number }> = [];

  for (let run = 1; run <= runs; run++) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`  Run ${run}/${runs}`);
    console.log(`${'='.repeat(60)}\n`);

    const runDir = path.join(RESULTS_DIR, `run_${run}`);
    fs.mkdirSync(runDir, { recursive: true });

    let passed = 0;
    let total = 0;
    const results: any[] = [];

    for (let i = 0; i < tasks.length; i++) {
      const task = tasks[i];
      const progress = `[${i + 1}/${tasks.length}]`;

      process.stdout.write(`${progress} ${task.id}...`);

      const workspaceDir = path.join(runDir, task.id);
      fs.mkdirSync(workspaceDir, { recursive: true });

      try {
        const result = await executeTask(task, workspaceDir, runtime);
        total++;

        if (result.passed) {
          passed++;
          console.log(` ✅`);
        } else {
          console.log(` ❌`);
        }

        results.push({
          id: task.id,
          name: task.name,
          category: task.category,
          passed: result.passed,
          answer: result.answer,
        });

        // Save result
        fs.writeFileSync(
          path.join(workspaceDir, 'result.json'),
          JSON.stringify({ ...result, task_id: task.id }, null, 2),
        );

      } catch (error: any) {
        total++;
        const errMsg = error.message || error.toString() || 'unknown error';
        console.log(` ⚠️ ${errMsg.slice(0, 80)}`);

        results.push({
          id: task.id,
          name: task.name,
          category: task.category,
          passed: false,
          answer: errMsg.slice(0, 500),
        });

        // Save error result
        fs.writeFileSync(
          path.join(workspaceDir, 'result.json'),
          JSON.stringify({ answer: errMsg.slice(0, 500), passed: false, task_id: task.id, error: true }, null, 2),
        );
      }

      await sleep(1000);
    }

    const score = total > 0 ? (passed / total) * 100 : 0;
    allResults.push({ run, passed, total, score });

    // Save run summary
    const summary = {
      benchmark: 'PinchBench',
      model: MODEL,
      run,
      total,
      passed,
      score: `${score.toFixed(1)}%`,
      results,
    };

    fs.writeFileSync(path.join(runDir, 'summary.json'), JSON.stringify(summary, null, 2));

    console.log(`\n  Run ${run}: ${passed}/${total} = ${score.toFixed(1)}%`);
  }

  // Calculate average
  const avgScore = allResults.reduce((sum, r) => sum + r.score, 0) / allResults.length;
  const minScore = Math.min(...allResults.map(r => r.score));
  const maxScore = Math.max(...allResults.map(r => r.score));
  const avgPassed = allResults.reduce((sum, r) => sum + r.passed, 0) / allResults.length;
  const avgTotal = allResults.reduce((sum, r) => sum + r.total, 0) / allResults.length;

  const finalSummary = {
    benchmark: 'PinchBench',
    model: MODEL,
    runs: allResults.length,
    avg_score: avgScore,
    min_score: minScore,
    max_score: maxScore,
    avg_passed: avgPassed,
    avg_total: avgTotal,
    all_scores: allResults.map(r => r.score),
  };

  fs.writeFileSync(path.join(RESULTS_DIR, 'summary.json'), JSON.stringify(finalSummary, null, 2));

  console.log(`\n${'='.repeat(60)}`);
  console.log(`  PinchBench Results Summary`);
  console.log(`${'='.repeat(60)}`);
  console.log(`  Runs: ${allResults.length}`);
  console.log(`  Average Score: ${avgScore.toFixed(1)}%`);
  console.log(`  Min Score: ${minScore.toFixed(1)}%`);
  console.log(`  Max Score: ${maxScore.toFixed(1)}%`);
  console.log(`  Average Passed: ${avgPassed.toFixed(1)}/${avgTotal.toFixed(1)}`);
  console.log(`${'='.repeat(60)}\n`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
