#!/usr/bin/env tsx
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { runWithTenant } from '../../../packages/core/src/runtime/tenantContext.js';
import { loadBenchmark, filterCases, collectStats, printStats } from './loader.js';
import { scoreCase, type ExecutionSnapshot } from './scorer.js';
import { buildReport, printReport, saveReport } from './reporter.js';
import { ExecutionHarness } from './harness/executionHarness.js';
import { runRealWorldBenchmark } from './realworld/runner.js';
import { allRealWorldCases } from './realworld/cases.js';
import type {
  RunnerOptions,
  FailureTypeLabel,
  CapabilityLabel,
  CaseResult,
} from './types.js';

interface ExtendedOptions extends RunnerOptions {
  frameworkName?: string;
  mode?: 'dry-run' | 'simulated' | 'live';
  llmProvider?: 'e2e-record' | 'e2e-replay' | 'scripted';
  /**
   * LLM traffic mode (orthogonal to the tool execution `mode`):
   * - `live`        — real StepFun API, zero cassette wrapping (raw StepFunProvider)
   * - `cassette`    — default; rejected by `mode==='live'` (e2e-replay) or recorded (e2e-record)
   *
   * Set by `--llm-live` and only honored when `mode === 'live'`; otherwise the
   * `mode==='live' && llmMode==='live'` gate in `handleRun` falls through to
   * whatever `llmProvider` (cassette replay / record / scripted) the user picked.
   */
  llmMode?: 'live' | 'cassette';
  cassetteDir?: string;
  offset?: number;
  caseId?: string;
}

function parseArgs(): ExtendedOptions {
  const args = process.argv.slice(2);
  const cmd = args.find((a) =>
    ['validate', 'stats', 'run', 'report', 'realworld'].includes(a),
  );
  if (!cmd) {
    console.error('Usage: chaos-runner <validate|stats|run|report|realworld> [options]');
    process.exit(1);
  }

  const options: ExtendedOptions = {
    command: cmd as ExtendedOptions['command'],
    dryRun: false,
    mode: 'simulated',
  };

  if (args.includes('--live')) {
    options.mode = 'live';
    options.dryRun = false;
  } else if (args.includes('--simulated')) {
    options.mode = 'simulated';
    options.dryRun = false;
  } else if (args.includes('--dry-run')) {
    options.mode = 'dry-run';
    options.dryRun = true;
  }

  const modeIdx = args.indexOf('--mode');
  if (modeIdx !== -1 && args[modeIdx + 1]) {
    const m = args[modeIdx + 1];
    if (m === 'live' || m === 'simulated' || m === 'dry-run') {
      options.mode = m;
      options.dryRun = m === 'dry-run';
    }
  }

  if (args.includes('--e2e-record')) {
    options.llmProvider = 'e2e-record';
    options.mode = options.mode === 'dry-run' ? 'simulated' : options.mode;
    options.dryRun = false;
  } else if (args.includes('--e2e-replay')) {
    options.llmProvider = 'e2e-replay';
    options.mode = options.mode === 'dry-run' ? 'simulated' : options.mode;
    options.dryRun = false;
  } else if (args.includes('--scripted')) {
    options.llmProvider = 'scripted';
    options.mode = options.mode === 'dry-run' ? 'simulated' : options.mode;
    options.dryRun = false;
  } else if (args.includes('--llm-live')) {
    // Real StepFun API, zero cassette wrapping. Honored only when
    // `mode === 'live'` (gated in handleRun). Defensively force
    // dryRun=false so `--llm-live --dry-run` doesn't accidentally
    // degrade to a random-scoring mock.
    options.llmMode = 'live';
    options.dryRun = false;
  }

  const cassetteIdx = args.indexOf('--cassette-dir');
  if (cassetteIdx !== -1 && args[cassetteIdx + 1]) {
    options.cassetteDir = args[cassetteIdx + 1];
  } else {
    options.cassetteDir = '.commander/e2e_cassettes';
  }

  // Dual-form CLI parser added 2026-07-07. The original parseArgs used
  // `args.indexOf('--name')` + `args[idx + 1]`, which silently ignored the
  // EQUAL form (`--name=value` is a single argv element so indexOf returns
  // -1). This caused .github/workflows/chaos-bench.yml's workflow_dispatch
  // `maxCases=N` input to be silently dropped on the chaos-255 day — the
  // default 255-case suite ran instead of the user-configured subset.
  //
  // EQUAL form takes precedence when both are supplied; the SPACE guard
  // `!args[idx + 1].startsWith('-')` prevents `--max -1` from misreading
  // the next flag as the value (a robustness improvement the original
  // parseArgs lacked).
  const getArgValue = (name: string): string | undefined => {
    const eq = args.find((a) => a.startsWith(name + '='));
    if (eq) return eq.slice(name.length + 1);
    const idx = args.indexOf(name);
    if (idx !== -1 && idx + 1 < args.length && !args[idx + 1].startsWith('-')) {
      return args[idx + 1];
    }
    return undefined;
  };

  const maxArg = getArgValue('--max');
  if (maxArg) {
    options.filter = options.filter ?? {};
    options.filter.maxCases = parseInt(maxArg, 10);
  }

  const offsetArg = getArgValue('--offset');
  if (offsetArg) options.offset = parseInt(offsetArg, 10);

  const caseArg = getArgValue('--case');
  if (caseArg) options.caseId = caseArg;

  const ftIdx = args.indexOf('--filter-ft');
  if (ftIdx !== -1 && args[ftIdx + 1]) {
    options.filter = options.filter ?? {};
    options.filter.failureTypes = args[ftIdx + 1].split(
      ',',
    ) as FailureTypeLabel[];
  }

  const capIdx = args.indexOf('--filter-cap');
  if (capIdx !== -1 && args[capIdx + 1]) {
    options.filter = options.filter ?? {};
    options.filter.capabilities = args[capIdx + 1].split(
      ',',
    ) as CapabilityLabel[];
  }

  // --output uses the same dual-form helper as --max / --offset / --case
  // (defined above). Centralizing through getArgValue puts the dual-form
  // pattern in exactly one place, preventing future contributors from
  // reintroducing the chaos-255-day bug pattern while extending a different
  // arg. The helper also adds a `!args[idx + 1].startsWith('-')` guard that
  // the original inline implementation lacked (defensive against `--output
  // --help` accidentally being misread as `outputPath = '--help'`).
  const outputArg = getArgValue('--output');
  if (outputArg) options.outputPath = outputArg;

  const fwIdx = args.indexOf('--framework');
  if (fwIdx !== -1 && args[fwIdx + 1]) {
    options.frameworkName = args[fwIdx + 1];
  }

  return options;
}

function handleValidate(opts: ExtendedOptions): void {
  const { benchmark, allCases } = loadBenchmark(opts.benchmarkPath);
  const filtered = filterCases(allCases, opts.filter);

  const meta = benchmark.benchmark_metadata;
  const errors: string[] = [];

  for (const c of allCases) {
    const em = c.evaluation_metadata;
    if (!em.grading_rules.assertions.length) {
      errors.push(`[${(c as any).test_id ?? (c as any).case_id}] 0 assertions`);
    }
    if (!em.required_capabilities.length) {
      errors.push(
        `[${(c as any).test_id ?? (c as any).case_id}] 0 capabilities`,
      );
    }
    if (em.grading_rules.pass_threshold <= 0) {
      errors.push(
        `[${(c as any).test_id ?? (c as any).case_id}] missing pass_threshold`,
      );
    }
  }

  console.log(`  Loaded:          ${meta.statistics.total_cases} cases`);
  console.log(`  Filtered:        ${filtered.length} cases`);
  console.log(`  Synthetic:       ${meta.statistics.synthetic_cases}`);
  console.log(`  Mutation:        ${meta.statistics.mutation_cases}`);
  console.log(`  Schema errors:   ${errors.length}`);
  if (errors.length) {
    for (const e of errors.slice(0, 10)) {
      console.log(`    ✗ ${e}`);
    }
    if (errors.length > 10) console.log(`    ... and ${errors.length - 10} more`);
  } else {
    console.log('  Status:          All cases valid');
  }
}

function handleStats(opts: ExtendedOptions): void {
  const { benchmark, allCases } = loadBenchmark(opts.benchmarkPath);
  const filtered = filterCases(allCases, opts.filter);
  const stats = collectStats(benchmark, filtered);
  printStats(stats);

  if (opts.filter) {
    console.log('\n  Active Filters:');
    if (opts.filter.failureTypes)
      console.log(`    failure_type: ${opts.filter.failureTypes.join(', ')}`);
    if (opts.filter.capabilities)
      console.log(`    capability:   ${opts.filter.capabilities.join(', ')}`);
    if (opts.filter.maxCases)
      console.log(`    max_cases:    ${opts.filter.maxCases}`);
  }
}

async function handleRunLive(
  harness: ExecutionHarness,
  cases: any[],
  framework: string,
  benchmark: any,
  outputPath?: string,
  offset = 0,
): Promise<void> {
  const results: CaseResult[] = [];
  let passed = 0;
  let failed = 0;

  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    const label =
      (c as any).task_name ?? (c as any).case_id ?? `case-${i}`;
    const shortLabel =
      label.length > 60 ? label.slice(0, 57) + '...' : label;

    const result = await harness.executeCase(c);
    results.push(result);
    if (result.passed) passed++;
    else failed++;

    const icon = result.passed ? '✓' : '✗';
    process.stdout.write(
      `  [${String(i + 1 + offset).padStart(3)}/${String(cases.length + offset).padStart(3)}] ${icon} ${shortLabel} → ${result.weighted_score.toFixed(1)}\n`,
    );
    if (!result.passed) {
      for (const a of result.assertions) {
        if (!a.passed) {
          process.stdout.write(
            `      ✗ ${a.id}: expected=${a.expected ?? 'true'} actual=${a.actual}\n`,
          );
        }
      }
    }
  }

  console.log();
  const report = buildReport({
    benchmarkName: benchmark.benchmark_metadata.name,
    benchmarkVersion: benchmark.benchmark_metadata.version,
    framework,
    results,
  });

  printReport(report);
  const out = outputPath ?? resolve(process.cwd(), 'report.json');
  saveReport(report, out);
}

function handleRunDry(
  cases: any[],
  framework: string,
  benchmark: any,
  outputPath?: string,
  mode?: string,
  offset = 0,
): void {
  console.log(`Running ${cases.length} benchmark cases...`);
  console.log('  Mode: DRY RUN (random scoring mock)');
  console.log();

  const results: CaseResult[] = [];
  let passed = 0;
  let failed = 0;

  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    const label =
      (c as any).task_name ?? (c as any).case_id ?? `case-${i}`;
    const shortLabel =
      label.length > 60 ? label.slice(0, 57) + '...' : label;

    const snapshot: ExecutionSnapshot = {
      detection_latency_ms: Math.floor(Math.random() * 5000 + 1000),
      recovery_latency_ms: Math.floor(Math.random() * 30000 + 5000),
      retry_count: Math.floor(Math.random() * 3),
      circuit_transitions: Math.floor(Math.random() * 3),
      rollback_quality: 0.85 + Math.random() * 0.15,
      assertions: {},
    };

    for (const def of c.evaluation_metadata.grading_rules.assertions) {
      if (def.type === 'boolean') {
        snapshot.assertions[def.id] = Math.random() > 0.15;
      } else if (def.type.startsWith('integer')) {
        snapshot.assertions[def.id] = def.expected ?? 0;
      } else if (def.type.startsWith('float')) {
        snapshot.assertions[def.id] =
          ((def.expected as number) ?? 0) * (0.9 + Math.random() * 0.2);
      } else {
        snapshot.assertions[def.id] = def.expected ?? null;
      }
    }

    const result = scoreCase(c, snapshot);
    results.push(result);
    if (result.passed) passed++;
    else failed++;

    const icon = result.passed ? '✓' : '✗';
    process.stdout.write(
      `  [${String(i + 1 + offset).padStart(3)}/${String(cases.length + offset).padStart(3)}] ${icon} ${shortLabel} → ${result.weighted_score.toFixed(1)}\n`,
    );
  }

  console.log();
  const report = buildReport({
    benchmarkName: benchmark.benchmark_metadata.name,
    benchmarkVersion: benchmark.benchmark_metadata.version,
    framework,
    results,
  });

  printReport(report);
  const out = outputPath ?? resolve(process.cwd(), 'report.json');
  saveReport(report, out);
}

async function handleRun(opts: ExtendedOptions): Promise<void> {
  const { benchmark, allCases } = loadBenchmark(opts.benchmarkPath);
  // Apply offset before maxCases so --offset 32 --max 1 runs the 33rd case.
  const maxCases = opts.filter?.maxCases;
  const filterWithoutMax = { ...opts.filter, maxCases: undefined };
  let filtered = filterCases(allCases, filterWithoutMax);
  const offset = opts.offset ?? 0;
  if (offset > 0) {
    filtered = filtered.slice(offset);
  }
  if (maxCases) {
    filtered = filtered.slice(0, maxCases);
  }
  const framework = opts.frameworkName ?? 'Commander';

  if (opts.mode === 'live' || opts.mode === 'simulated') {
    const harnessMode = opts.mode === 'live' ? 'live' : 'simulated';

    // --llm-live gate: only honored when both `--live` AND `--llm-live` are
    // present AND STEPFUN_API_KEY is exported. Fail-fast with a clear exit
    // code so a missing-key CI run never silently degrades to cassette.
    let pureLive = false;
    if (opts.mode === 'live' && opts.llmMode === 'live') {
      if (!process.env.STEPFUN_API_KEY) {
        console.error(
          'STEPFUN_API_KEY is required for --llm-live (mode === "live" && llmMode === "live"). ' +
            'Export it before running, or drop --llm-live to fall back to cassette-mode (--e2e-record / --e2e-replay / --scripted).',
        );
        process.exit(1);
      }
      pureLive = true;
      // Surface the effective StepFun endpoint so a real call is verifiable
      // in stdout even before any case prints its first response line.
      const stepfunBase =
        process.env.STEPFUN_BASE_URL ?? 'https://api.stepfun.com/v1';
      console.log(`  StepFun endpoint: ${stepfunBase}`);
      console.log(
        `  StepFun model:    ${process.env.STEPFUN_MODEL ?? 'step-3.7-flash'}`,
      );
    }

    const llmProvider = opts.llmProvider ?? 'e2e-replay';
    const llmLabel = pureLive ? 'live-pure-stepfun' : llmProvider;
    console.log(
      `Initializing harness (tool mode: ${harnessMode}, llm: ${llmLabel})...`,
    );
    const harness = new ExecutionHarness({
      mode: harnessMode,
      maxToolCalls: 150,
      llmProvider,
      cassetteDir: opts.cassetteDir,
      // pureLive bypass: when set, executeCase registers the raw
      // StepFunProvider directly (no E2EProvider/ScriptedProvider wrapping)
      // and never reads or writes cassettes.
      pureLive,
    });
    await handleRunLive(harness, filtered, framework, benchmark, opts.outputPath, opts.offset);
  } else {
    handleRunDry(filtered, framework, benchmark, opts.outputPath, opts.mode, opts.offset);
  }
}

function handleReport(opts: ExtendedOptions): void {
  const inputPath =
    opts.outputPath ??
    resolve(process.cwd(), 'benchmarks/chaos-runner/report.json');
  if (!existsSync(inputPath)) {
    console.error(`No report found at ${inputPath}. Run 'run' first.`);
    process.exit(1);
  }
  const content = readFileSync(inputPath, 'utf-8');
  const report = JSON.parse(content);
  printReport(report);
}

async function handleRealWorld(opts: ExtendedOptions): Promise<void> {
  console.log('Running real-world combat benchmark...');
  const outputPath = opts.outputPath ?? 'benchmarks/chaos-runner/realworld-report.json';
  await runRealWorldBenchmark(allRealWorldCases, {
    live: opts.mode === 'live',
    caseId: opts.caseId,
    outputPath,
  });
  console.log(`\nReport saved to ${outputPath}`);
}

async function main(): Promise<void> {
  const opts = parseArgs();

  try {
    switch (opts.command) {
      case 'validate':
        handleValidate(opts);
        break;
      case 'stats':
        handleStats(opts);
        break;
      case 'run':
        await handleRun(opts);
        break;
      case 'report':
        handleReport(opts);
        break;
      case 'realworld':
        await handleRealWorld(opts);
        break;
    }
  } catch (err) {
    console.error('Fatal:', err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

// Run the CLI inside a fixed tenant context so the tenant-aware singletons
// (Logger, MetricsCollector, UnifiedCostAuthority, etc.) can resolve their
// `.get()` calls. The chaos-runner is a batch tool — it has no per-request
// tenant — so a single `'benchmark-cli-default'` tenant is the correct
// shape. Without this wrap, the stricter `allowGlobalFallback === true`
// check (added in the 2026-Q3 security tightening) makes every global
// singleton throw `TenantIsolationError` at first access. See
// `packages/core/src/runtime/tenantAwareSingleton.ts:88` for the gating
// rule. Future work: rotate to `runWithTenant(randomUUID(), main)` per
// case if we ever run benchmarks in parallel inside one process.
runWithTenant('benchmark-cli-default', main);
