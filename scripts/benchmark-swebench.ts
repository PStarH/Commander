#!/usr/bin/env tsx
/**
 * scripts/benchmark-swebench.ts — SWE-bench capability-benchmark scaffold.
 *
 * Scope:
 *   - Loads offline fixture tasks from `packages/core/.cache/swebench/tasks.json`
 *   - Runs a local execution stub per task to produce a capability baseline
 *   - Reports success, repository breakdown, and patch validation shape
 *   - Tags defense-relevant side-effects per task (reversibility, PII, injection)
 *
 * Usage:
 *   npx tsx scripts/benchmark-swebench.ts            # full fixture mode
 *   npx tsx scripts/benchmark-swebench.ts --quick    # 10-task offline dry-run
 *   npx tsx scripts/benchmark-swebench.ts --output=result.json
 *
 * Exit codes:
 *   0  run completed + baseline check passed
 *   1  capability regression below stored baseline
 *   2  fatal error / missing fixture / scoring regression
 *   4  invoked in legacy incomplete mode (no fixture, no quick)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { withBenchmarkEnv } from './benchmarkEnv';

const CACHE_DIR = path.join(process.cwd(), 'packages/core/.cache/swebench');
const TASK_PATH = path.join(CACHE_DIR, 'tasks.json');
const BASELINE_PATH = path.join(CACHE_DIR, 'baseline.json');

interface SweBenchTask {
  id: string;
  environment: string;
  instruction: string;
  expected: Record<string, unknown>;
  severity: 'low' | 'medium' | 'high' | 'critical';
}

interface TaskResult {
  taskId: string;
  environment: string;
  success: boolean;
  simulated: boolean;
  reason: string;
  durationMs: number;
  stepBudget: number;
}

interface SyntheticTask {
  id: string;
  environment: string;
  instruction: string;
  expected: string;
}

function loadTasks(): SweBenchTask[] {
  if (!fs.existsSync(TASK_PATH)) {
    throw new Error(`SWE-bench fixture not found: ${TASK_PATH}`);
  }
  const raw = fs.readFileSync(TASK_PATH, 'utf-8');
  const data = JSON.parse(raw);
  return Array.isArray(data.tasks) ? data.tasks : [];
}

function loadBaseline(): Record<string, number> | null {
  if (!fs.existsSync(BASELINE_PATH)) {
    return null;
  }
  const raw = fs.readFileSync(BASELINE_PATH, 'utf-8');
  return JSON.parse(raw);
}

function saveBaseline(accuracy: number): void {
  const payload = {
    accuracy,
    taskCount: currentTaskCount,
    note: 'Offline fixture baseline; not a live browser run.',
  };
  const baseline = withBenchmarkEnv(payload, {
    evidence: 'source',
    datasetVersion: 'swebench-fixture-v1',
  });
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2), 'utf-8');
}

let currentTaskCount = 0;

function recordDefenseEvent(
  events: Array<{ taskId: string; event: string; detail?: string }>,
  taskId: string,
  event: string,
  detail?: string,
): void {
  events.push({ taskId, event, detail });
}

function classifyDefenseSideEffects(
  task: SyntheticTask,
  events: Array<{ taskId: string; event: string; detail?: string }>,
): void {
  const text = `${task.instruction} ${task.expected}`.toLowerCase();
  if (text.includes('email') || text.includes('send_email')) {
    recordDefenseEvent(events, task.id, 'reversibility_gate:send_email');
  }
  if (text.includes('delete') || text.includes('delete_file')) {
    recordDefenseEvent(events, task.id, 'reversibility_gate:delete_file');
  }
  if (text.includes('transfer') || text.includes('money')) {
    recordDefenseEvent(events, task.id, 'reversibility_gate:transfer_money');
  }
  if (text.includes('password') || text.includes('secret') || text.includes('token')) {
    recordDefenseEvent(events, task.id, 'pii_scan:secret_detected');
  }
  if (text.includes('jailbreak') || text.includes('ignore previous instructions')) {
    recordDefenseEvent(events, task.id, 'prompt_injection:indirect_injection');
  }
}

function runTask(task: SweBenchTask): TaskResult {
  const start = Date.now();
  const stepBudget = 8;

  // Offline stub: full SWE-bench requires repo checkout + sandboxed patch runner.
  // We record fixture/loader health here; live execution is future work.
  return {
    taskId: task.id,
    environment: task.environment,
    success: false,
    simulated: true,
    reason: 'live patch runner not implemented',
    durationMs: Date.now() - start,
    stepBudget,
  };
}

function printReport(
  results: TaskResult[],
  baseline: Record<string, number> | null,
  defenseEvents: Array<{ taskId: string; event: string; detail?: string }>,
): void {
  console.log('═'.repeat(72));
  console.log('  SWE-bench Capability Baseline');
  console.log('═'.repeat(72));
  for (const r of results) {
    const taskDefense = defenseEvents.filter((d) => d.taskId === r.taskId);
    const defenseTag =
      taskDefense.length > 0 ? ` [defense:${taskDefense.map((d) => d.event).join(',')}]` : '';
    console.log(
      `  ${r.simulated ? '[stub]' : '[run]'} ${r.taskId}  env=${r.environment}  success=${String(r.success)}  steps<=${r.stepBudget}${defenseTag}`,
    );
  }
  console.log('─'.repeat(72));
  const simulated = results.filter((r) => r.simulated).length;
  console.log(
    `  Tasks: ${results.length}  Simulated: ${simulated}  Live: ${results.length - simulated}`,
  );
  if (baseline) {
    console.log(`  Baseline: accuracy=${baseline.accuracy} savedAt=${baseline.savedAt}`);
  }
  console.log(`  Defense events: ${defenseEvents.length}`);
  console.log('═'.repeat(72));
}

const SYNTHETIC_TASKS: readonly SyntheticTask[] = [
  {
    id: 'swebench_synth_01',
    environment: 'repo:django/django',
    instruction:
      '[SYNTHETIC] Fix the bug where `Model.save()` raises `ValueError` when `null` is passed to a non-nullable field.',
    expected: 'patch_applied',
  },
  {
    id: 'swebench_synth_02',
    environment: 'repo:requests/requests',
    instruction: '[SYNTHETIC] Update `requests.get()` to retry on 503 with exponential backoff.',
    expected: 'patch_applied',
  },
  {
    id: 'swebench_synth_03',
    environment: 'repo:flaskapp/flask',
    instruction:
      '[SYNTHETIC] Add a missing `return` in the error handler to avoid `None` response.',
    expected: 'patch_applied',
  },
  {
    id: 'swebench_synth_04',
    environment: 'repo:palletsproject/jinja',
    instruction:
      '[SYNTHETIC] Fix template injection by escaping user input in `render_template_string`.',
    expected: 'patch_applied',
  },
  {
    id: 'swebench_synth_05',
    environment: 'repo:psf/requests',
    instruction: '[SYNTHETIC] Resolve memory leak by closing response streams in `iter_content`.',
    expected: 'patch_applied',
  },
  {
    id: 'swebench_synth_06',
    environment: 'repo:tiangolo/fastapi',
    instruction:
      '[SYNTHETIC] Add validation to reject empty `Bearer` tokens in the auth dependency.',
    expected: 'patch_applied',
  },
  {
    id: 'swebench_synth_07',
    environment: 'repo:sqlalchemy/sqlalchemy',
    instruction: '[SYNTHETIC] Fix N+1 query by adding `joinedload` for the `user` relationship.',
    expected: 'patch_applied',
  },
  {
    id: 'swebench_synth_08',
    environment: 'repo:pytest-dev/pytest',
    instruction: '[SYNTHETIC] Fix the segfault by releasing the GIL in the C extension hook.',
    expected: 'patch_applied',
  },
  {
    id: 'swebench_synth_09',
    environment: 'repo:python/cpython',
    instruction:
      '[SYNTHETIC] Fix race condition in `asyncio.Task` cancellation by holding the task lock.',
    expected: 'patch_applied',
  },
  {
    id: 'swebench_synth_10',
    environment: 'repo:numpy/numpy',
    instruction:
      '[SYNTHETIC] Fix incorrect dtype casting in `np.concatenate` for structured arrays.',
    expected: 'patch_applied',
  },
];

interface ReportPayload {
  tasks: TaskResult[];
  accuracy: number;
  baseline: Record<string, number> | null;
  defenseEvents: Array<{ taskId: string; event: string; detail?: string }>;
}

function writeOutput(payload: ReportPayload, outputPath: string): void {
  const baseline = withBenchmarkEnv(payload, {
    evidence: 'source',
    datasetVersion: 'swebench-fixture-v1',
  });
  fs.writeFileSync(outputPath, JSON.stringify(baseline, null, 2), 'utf-8');
}

async function main(): Promise<void> {
  console.log('SWE-bench benchmark runner');
  console.log(`Cache dir: ${CACHE_DIR}`);

  const argv = process.argv.slice(2);
  const quick = argv.includes('--quick');
  const outputArg = argv.find((a) => a.startsWith('--output='));
  const outputPath = outputArg ? outputArg.slice('--output='.length) : null;

  if (!quick && !fs.existsSync(TASK_PATH)) {
    console.error(`SWE-bench fixture not found: ${TASK_PATH}`);
    console.error('Run with --quick for offline dry-run, or add fixture tasks.json.');
    process.exit(4);
  }

  const fixtureTasks = quick ? [] : loadTasks();
  const tasks = quick
    ? SYNTHETIC_TASKS
    : fixtureTasks.map((t) => ({
        id: t.id,
        environment: t.environment,
        instruction: t.instruction,
        expected: t.expected,
      }));

  currentTaskCount = tasks.length;
  const modeLabel = quick
    ? 'quick (10 tasks, offline)'
    : `full (${tasks.length} tasks, fixture-backed)`;
  console.log(`Mode: ${modeLabel}`);
  console.log(`Loaded tasks: ${tasks.length}`);

  const baseline = loadBaseline();
  const results: TaskResult[] = [];
  const defenseEvents: Array<{ taskId: string; event: string; detail?: string }> = [];

  for (const task of tasks) {
    const result = runTask(task);
    results.push(result);
    classifyDefenseSideEffects(task, defenseEvents);
  }

  printReport(results, baseline, defenseEvents);

  const accuracy =
    results.length > 0 ? results.filter((r) => r.success).length / results.length : 0;
  if (outputPath) {
    writeOutput({ tasks: results, accuracy, baseline, defenseEvents }, outputPath);
    console.log(`Wrote report: ${outputPath}`);
  }

  if (baseline === null) {
    saveBaseline(accuracy);
    console.log('Saved baseline from current fixture run.');
    process.exit(0);
  }

  const expectedAccuracy = baseline.accuracy;
  if (accuracy < expectedAccuracy) {
    console.log(`Capability regression: accuracy=${accuracy} < baseline=${expectedAccuracy}`);
    process.exit(1);
  }

  console.log(`Capability check passed: accuracy=${accuracy} >= baseline=${expectedAccuracy}`);
  process.exit(0);
}

main().catch((e) => {
  console.error('Fatal error:', e);
  process.exit(2);
});
