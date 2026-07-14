#!/usr/bin/env tsx
/**
 * bench-wal-regress.ts — Day 6 WAL p99 regression detector.
 *
 * Compares a baseline JSON produced by `scripts/bench-wal-throughput.ts`
 * (today) against the previous day's baseline (yesterday). Exits with
 * a code that downstream CI can consume:
 *
 *   0  → no regression detected OR first-day run (no yesterday baseline)
 *   1  → p99 regression exceeds the configured threshold (default 15%)
 *   2  → invalid arguments, missing today's file, or schema mismatch
 *
 * Schema contract (must match `bench-wal-throughput.ts` output):
 *
 *   {
 *     "schemaVersion": 1,
 *     "latency": { "p50Us": n, "p99Us": n, "p999Us": n, ... },
 *     "rowsPerSec": n,
 *     ...
 *   }
 *
 * Threshold precedence (highest to lowest):
 *
 *   1. REGRESSION_THRESHOLD_PCT  env var  (set by `.github/workflows/wal-bench.yml`
 *                                         from `${{ github.event.inputs.threshold }}`)
 *   2. --threshold=<pct>          CLI flag (developer override when running locally)
 *   3. 15%                        default
 *
 * This env-overrides-flag order lets a `workflow_dispatch` input from the
 * Actions UI always win over any flag the developer baked into the
 * workflow file.
 *
 * Step-summary: when called with `--summary <path>`, writes a markdown
 * table to `<path>` that the GitHub Actions workflow appends to
 * `$GITHUB_STEP_SUMMARY`. Table columns: rows-per-sec, p50, p99, p999.
 * Even when no yesterday baseline exists, a "first-day" summary is
 * emitted so reviewers can still inspect today's numbers in the PR view.
 *
 * Usage:
 *
 *   npx tsx scripts/bench-wal-regress.ts \
 *     docs/baselines/wal-baseline.<TODAY>.json \
 *     docs/baselines/wal-baseline.<YESTERDAY>.json \
 *     [--threshold=15] [--summary=/tmp/wal-regress.md]
 *
 *   REGRESSION_THRESHOLD_PCT=20 npx tsx scripts/bench-wal-regress.ts ...
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

interface BenchLatency {
  p50Us: number;
  p99Us: number;
  p999Us: number;
  avgUs: number;
  minUs: number;
  maxUs: number;
}

interface BenchBaseline {
  schemaVersion: number;
  timestamp: string;
  iterations: number;
  warmup: number;
  backend: 'wal' | 'memory';
  rowsPerSec: number;
  latency: BenchLatency;
  hint: string;
}

const DEFAULT_THRESHOLD_PCT = 15;

const SUMMARY_COLUMNS = [
  // rows-per-sec: HIGHER is better. The polarity flips from the latency
  // metrics so a future bump to multi-metric gates (e.g. gate on BOTH
  // p99 AND rows-per-sec) can reuse this polarity without re-deriving
  // it. The current spec gates on p99 ONLY — the ⚠️ marker that fires
  // here when rows-per-sec drops >threshold is context-only; it is NOT
  // a CI failure trigger today.
  {
    metric: 'rows-per-sec',
    get: (b: BenchBaseline) => b.rowsPerSec,
    decimals: 1,
    lowerIsBad: false,
  },
  // Latency percentiles: LOWER is better.
  { metric: 'p50 (µs)', get: (b: BenchBaseline) => b.latency.p50Us, decimals: 1, lowerIsBad: true },
  // p99 IS the actual CI gate per spec.
  { metric: 'p99 (µs)', get: (b: BenchBaseline) => b.latency.p99Us, decimals: 1, lowerIsBad: true },
  {
    metric: 'p999 (µs)',
    get: (b: BenchBaseline) => b.latency.p999Us,
    decimals: 1,
    lowerIsBad: true,
  },
] as const;

interface CliArgs {
  todayPath: string;
  yesterdayPath?: string;
  /** Threshold from --threshold flag, OR the default. Env override happens later. */
  flagOrDefaultThreshold: number;
  summaryPath?: string;
}

type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

function parseArgs(argv: string[]): Result<CliArgs, string> {
  const positional: string[] = [];
  let flagOrDefaultThreshold = DEFAULT_THRESHOLD_PCT;
  let summaryPath: string | undefined;

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--threshold=')) {
      const raw = arg.slice('--threshold='.length);
      const parsed = parseFloat(raw);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        return { ok: false, error: `invalid --threshold=${raw} (must be a positive number)` };
      }
      flagOrDefaultThreshold = parsed;
    } else if (arg.startsWith('--summary=')) {
      summaryPath = arg.slice('--summary='.length);
    } else {
      positional.push(arg);
    }
  }

  if (positional.length < 1 || positional.length > 2) {
    return {
      ok: false,
      error:
        `usage: bench-wal-regress <today.json> [<yesterday.json>] ` +
        `[--threshold=<pct>] [--summary=<path>]\n` +
        `  today.json     required. Path to today's baseline JSON.\n` +
        `  yesterday.json optional. If absent, treated as first-day run (exit 0).\n` +
        `  --threshold=<pct>     only consulted if REGRESSION_THRESHOLD_PCT env is unset.\n` +
        `  --summary=<path>      write markdown summary to <path>.\n` +
        `  env REGRESSION_THRESHOLD_PCT  highest-priority threshold override.`,
    };
  }

  return {
    ok: true,
    value: {
      todayPath: positional[0],
      yesterdayPath: positional[1],
      flagOrDefaultThreshold,
      summaryPath,
    },
  };
}

/**
 * Resolve the effective threshold using the documented precedence:
 *   env var (workflow input)  >  flag (or default)  >  default 15.
 */
function resolveThreshold(flagOrDefault: number): number {
  const envRaw = process.env.REGRESSION_THRESHOLD_PCT;
  if (envRaw !== undefined) {
    const envParsed = parseFloat(envRaw);
    if (Number.isFinite(envParsed) && envParsed > 0) {
      return envParsed;
    }
  }
  return flagOrDefault;
}

function loadBaseline(filePath: string): Result<BenchBaseline, string> {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    return { ok: false, error: `cannot read ${filePath}: ${(err as Error)?.message}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, error: `cannot parse JSON in ${filePath}: ${(err as Error)?.message}` };
  }

  const candidate = parsed as Partial<BenchBaseline> & {
    env?: { runAt?: string };
    schemaVersion?: number;
  };
  // Schema v2 wraps the original payload in an evidence envelope; the raw
  // metrics still live at top level, so we accept both v1 and v2.
  if (candidate.schemaVersion !== 1 && candidate.schemaVersion !== 2) {
    return {
      ok: false,
      error: `unsupported schemaVersion=${candidate.schemaVersion} in ${filePath} (expected 1 or 2)`,
    };
  }
  // Prefer the canonical timestamp from the env envelope when present.
  if (candidate.env?.runAt && candidate.timestamp) {
    candidate.timestamp = candidate.env.runAt;
  }
  if (
    typeof candidate.rowsPerSec !== 'number' ||
    typeof candidate.latency?.p50Us !== 'number' ||
    typeof candidate.latency?.p99Us !== 'number' ||
    typeof candidate.latency?.p999Us !== 'number'
  ) {
    return {
      ok: false,
      error: `missing required metrics (rowsPerSec, latency.p50Us, p99Us, p999Us) in ${filePath}`,
    };
  }

  return { ok: true, value: candidate as BenchBaseline };
}

function pctChange(prev: number, next: number): number {
  if (prev === 0) return 0;
  return ((next - prev) / prev) * 100;
}

function fmtNumber(value: number, decimals: number): string {
  return value.toFixed(decimals);
}

function fmtPct(pct: number, decimals = 2): string {
  const sign = pct > 0 ? '+' : '';
  return `${sign}${pct.toFixed(decimals)}%`;
}

/**
 * Build the markdown step-summary. Always renders today's row; renders
 * yesterday's row only when present. Column "Δ vs Yesterday" is computed
 * per the metric's `lowerIsBad` polarity so a reader sees "+12.3%" on
 * latency as a regression and "+12.3%" on rows-per-sec as an improvement.
 */
function buildSummary(
  today: BenchBaseline,
  yesterday: BenchBaseline | null,
  thresholdPct: number,
): string {
  const lines: string[] = [];
  lines.push(`## WAL Bench Regression — ${today.timestamp.slice(0, 10)}`);
  lines.push('');
  if (!yesterday) {
    lines.push('> ℹ️ First-day run: no yesterday baseline available. Regression gate skipped.');
    lines.push('');
  }
  lines.push(
    `> Latency gate threshold: **${thresholdPct}%** p99 regression. ` +
      `Rows-per-sec and other percentiles are reported for context only.`,
  );
  lines.push('');
  lines.push('| Metric | Today | Yesterday | Δ vs Yesterday |');
  lines.push('|---|---|---|---|');
  for (const col of SUMMARY_COLUMNS) {
    const todayCell = fmtNumber(col.get(today), col.decimals);
    if (!yesterday) {
      lines.push(`| ${col.metric} | ${todayCell} | n/a | n/a |`);
      continue;
    }
    const yesterdayCell = fmtNumber(col.get(yesterday), col.decimals);
    const deltaPct = pctChange(col.get(yesterday), col.get(today));
    const flag =
      col.lowerIsBad && deltaPct > thresholdPct
        ? ' ⚠️ regression'
        : !col.lowerIsBad && deltaPct < -thresholdPct
          ? ' ⚠️ regression'
          : '';
    lines.push(`| ${col.metric} | ${todayCell} | ${yesterdayCell} | ${fmtPct(deltaPct)}${flag} |`);
  }
  lines.push('');
  lines.push(`**Today** (${today.timestamp}) vs **Yesterday** (${yesterday?.timestamp ?? 'n/a'})`);
  lines.push('');
  lines.push('Lower latency is better; higher rows-per-sec is better.');
  return lines.join('\n');
}

function writeSummary(
  reportPath: string,
  today: BenchBaseline,
  yesterday: BenchBaseline | null,
  thresholdPct: number,
): void {
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, buildSummary(today, yesterday, thresholdPct), 'utf-8');
}

function main(): number {
  const parsed = parseArgs(process.argv);
  if (!parsed.ok) {
    process.stderr.write(`[bench-wal-regress] ${parsed.error}\n`);
    return 2;
  }
  const args = parsed.value;
  const thresholdPct = resolveThreshold(args.flagOrDefaultThreshold);

  if (!fs.existsSync(args.todayPath)) {
    process.stderr.write(`[bench-wal-regress] FAIL: today baseline missing: ${args.todayPath}\n`);
    return 2;
  }
  const todayResult = loadBaseline(args.todayPath);
  if (!todayResult.ok) {
    process.stderr.write(`[bench-wal-regress] ${todayResult.error}\n`);
    return 2;
  }
  const today = todayResult.value;

  let yesterday: BenchBaseline | null = null;
  if (args.yesterdayPath !== undefined) {
    if (!fs.existsSync(args.yesterdayPath)) {
      process.stdout.write(
        `[bench-wal-regress] SKIP: yesterday baseline missing: ${args.yesterdayPath} ` +
          `(likely first-day run; gate will not fire)\n`,
      );
      process.stdout.write(
        `[bench-wal-regress] today.p99Us=${today.latency.p99Us.toFixed(2)} ` +
          `rowsPerSec=${today.rowsPerSec.toFixed(2)}\n`,
      );
      if (args.summaryPath) {
        writeSummary(args.summaryPath, today, null, thresholdPct);
      }
      return 0;
    }
    const yResult = loadBaseline(args.yesterdayPath);
    if (!yResult.ok) {
      process.stderr.write(`[bench-wal-regress] ${yResult.error}\n`);
      return 2;
    }
    yesterday = yResult.value;
  }

  const p99Delta = pctChange(yesterday.latency.p99Us, today.latency.p99Us);
  const rowsDelta = pctChange(yesterday.rowsPerSec, today.rowsPerSec);
  const regressed = p99Delta > thresholdPct;

  process.stdout.write(
    `[bench-wal-regress] today: p99Us=${today.latency.p99Us.toFixed(2)} ` +
      `rowsPerSec=${today.rowsPerSec.toFixed(2)} (${today.timestamp})\n`,
  );
  process.stdout.write(
    `[bench-wal-regress] yesterday: p99Us=${yesterday.latency.p99Us.toFixed(2)} ` +
      `rowsPerSec=${yesterday.rowsPerSec.toFixed(2)} (${yesterday.timestamp})\n`,
  );
  process.stdout.write(
    `[bench-wal-regress] delta: p99=${fmtPct(p99Delta)} rowsPerSec=${fmtPct(rowsDelta)} ` +
      `(threshold=${thresholdPct}% p99 regression; yesterday=${yesterday.timestamp.slice(0, 10)})\n`,
  );

  if (args.summaryPath) {
    writeSummary(args.summaryPath, today, yesterday, thresholdPct);
  }

  if (regressed) {
    process.stderr.write(
      `[bench-wal-regress] FAIL: p99 regressed ${fmtPct(p99Delta)} (>${thresholdPct}% threshold)\n`,
    );
    return 1;
  }

  process.stdout.write('[bench-wal-regress] PASS: p99 within threshold\n');
  return 0;
}

const exitCode = main();
process.exit(exitCode);
