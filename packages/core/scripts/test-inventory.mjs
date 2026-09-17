#!/usr/bin/env node
/**
 * Test inventory + registration gate for `packages/core`.
 *
 * Modes
 * -----
 *   node scripts/test-inventory.mjs            report only, always exit 0
 *   node scripts/test-inventory.mjs --json     report only, JSON on stdout
 *   node scripts/test-inventory.mjs --verify   run the gate, exit 1 on any error
 *
 * The gate exists because a test file can otherwise be executed by *no* runner
 * and still leave CI green. vitest's `test.include` is a filter, so an
 * unregistered vitest file is not even reachable via an explicit CLI argument
 * ("No test files found", exit 1), and `run-node-tests.mjs` skips every file
 * that imports vitest. The intersection of those two facts is a silent hole.
 *
 * Discovery and the declared-not-run registry live in `test-manifest.mjs`, which
 * `run-node-tests.mjs` imports as well, so the two runners cannot drift apart.
 *
 * Verification errors (each is a hard failure under `--verify`):
 *   CONFIG_UNRESOLVED        vitest.config.ts could not be parsed statically
 *   GHOST_INCLUDE            an `include:` entry does not exist on disk
 *   DUPLICATE_INCLUDE        the same `include:` entry appears more than once
 *   UNKNOWN_RUNNER           file imports neither vitest nor node:test
 *   MIXED_RUNNER             file imports both frameworks
 *   UNREGISTERED_TEST        file is reachable by no runner and not declared
 *   DECLARATION_INVALID      a DECLARED_NOT_RUN entry is malformed
 *   DECLARATION_STALE        a DECLARED_NOT_RUN entry names a missing file
 *   DECLARATION_CONTRADICTION a file is declared not-run but is registered
 *   NO_TEST_CALLS            a runner-reachable file declares no test/suite
 *
 * Warnings never fail the gate; they are surfaced so the debt stays visible.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import {
  CORE_ROOT,
  DECLARED_NOT_RUN,
  classifyRunner,
  declaresAnyTest,
  discoverTestFiles,
  isEnvironmentReadFailure,
  isNodeRunnerFile,
  readSource,
  readSourceDetailed,
  readVitestInclude,
  validateDeclaration,
} from './test-manifest.mjs';

const argv = process.argv.slice(2);
const verify = argv.includes('--verify');
const json = argv.includes('--json');

/** @type {{code: string, severity: 'error'|'warning', detail: string}[]} */
const findings = [];
const error = (code, detail) => findings.push({ code, severity: 'error', detail });
const warn = (code, detail) => findings.push({ code, severity: 'warning', detail });

// ── Discover every test file under the scanned roots ────────────────────────
const allFiles = discoverTestFiles(CORE_ROOT);

/** @type {{file: string, runner: string, declaresTests: boolean}[]} */
const entries = [];
for (const file of allFiles) {
  const read = readSourceDetailed(file, CORE_ROOT);
  if (!read.ok) {
    // Fail closed: an unreadable file cannot be proven to be registered, so the
    // inventory is incomplete and the gate must not report success. The reason
    // is surfaced so an environmental block is distinguishable from a missing
    // file — otherwise the same tree yields different verdicts on different runs.
    error(
      'UNREADABLE_TEST',
      isEnvironmentReadFailure(read.code)
        ? `${file}: cannot be read — ${read.code}. This is an environment/ACL block, not a ` +
            `missing file; the inventory cannot be proven complete while it is in effect.`
        : `${file}: cannot be read — ${read.code}. The file is listed by discovery but does ` +
            `not exist on disk (stale entry, broken symlink, or a discovery/read race).`,
    );
    continue;
  }
  const source = read.source;
  const runner = classifyRunner(source);
  entries.push({ file, runner, declaresTests: declaresAnyTest(source) });
  if (runner === 'unknown') {
    error(
      'UNKNOWN_RUNNER',
      `${file} imports neither "vitest" nor "node:test" — no runner will execute it`,
    );
  } else if (runner === 'mixed') {
    error('MIXED_RUNNER', `${file} imports both "vitest" and "node:test"`);
  }
}

const vitestFiles = entries.filter((e) => e.runner === 'vitest').map((e) => e.file);
const nodeFiles = entries.filter((e) => e.runner === 'node').map((e) => e.file);

// ── Parse the enabled vitest include list (AST, comments ignored) ───────────
const includeResult = readVitestInclude(CORE_ROOT);
/** @type {string[]} */
let include = [];
if (includeResult.status !== 'ok') {
  error('CONFIG_UNRESOLVED', `${includeResult.status}: ${includeResult.detail}`);
} else {
  include = includeResult.include;

  const seen = new Set();
  for (const entry of include) {
    if (seen.has(entry)) {
      error('DUPLICATE_INCLUDE', `${entry} is listed more than once in test.include`);
    }
    seen.add(entry);
  }

  for (const entry of include) {
    if (!existsSync(join(CORE_ROOT, entry))) {
      error(
        'GHOST_INCLUDE',
        `${entry} is listed in test.include but does not exist on disk (stale entry)`,
      );
    }
  }
}

const includeSet = new Set(include);

// ── Registry of files that are deliberately not executed ────────────────────
const declaredFiles = new Set();
for (const declaration of DECLARED_NOT_RUN) {
  for (const problem of validateDeclaration(declaration, CORE_ROOT)) {
    error('DECLARATION_INVALID', problem);
  }
  if (typeof declaration?.file === 'string') {
    if (declaredFiles.has(declaration.file)) {
      error('DECLARATION_INVALID', `${declaration.file} is declared more than once`);
    }
    declaredFiles.add(declaration.file);
    if (!existsSync(join(CORE_ROOT, declaration.file))) {
      error('DECLARATION_STALE', `${declaration.file} is declared not-run but does not exist`);
    }
    if (includeSet.has(declaration.file)) {
      error(
        'DECLARATION_CONTRADICTION',
        `${declaration.file} is declared not-run but is also enabled in test.include`,
      );
    }
  }
}

// ── Reachability: every file must be registered or declared ─────────────────
const unregistered = [];
for (const entry of entries) {
  if (entry.runner === 'vitest') {
    if (!includeSet.has(entry.file) && !declaredFiles.has(entry.file)) {
      unregistered.push(entry.file);
      error(
        'UNREGISTERED_TEST',
        `${entry.file} is executed by no runner: absent from test.include and from DECLARED_NOT_RUN`,
      );
    }
  } else if (entry.runner === 'node') {
    if (!isNodeRunnerFile(entry.file, readSource(entry.file, CORE_ROOT) ?? '')) {
      // node:test discovery in run-node-tests.mjs only scans tests/.
      error(
        'UNREGISTERED_TEST',
        `${entry.file} is a node:test file outside tests/ — run-node-tests.mjs will not discover it`,
      );
    }
  }
}

// ── A reachable file that declares no tests is a silent no-op ───────────────
for (const entry of entries) {
  if (entry.runner !== 'unknown' && entry.runner !== 'mixed' && !entry.declaresTests) {
    warn(
      'NO_TEST_CALLS',
      `${entry.file} is ${entry.runner}-reachable but declares no test/suite — it will report 0 cases`,
    );
  }
}

const errors = findings.filter((f) => f.severity === 'error');
const warnings = findings.filter((f) => f.severity === 'warning');

const summary = {
  coreRoot: CORE_ROOT,
  totalFiles: entries.length,
  vitestFiles: vitestFiles.length,
  nodeFiles: nodeFiles.length,
  declaredNotRunFiles: declaredFiles.size,
  vitestIncludeEntries: include.length,
  unregisteredFiles: unregistered.length,
  coverageComplete: errors.length === 0,
  errorCount: errors.length,
  warningCount: warnings.length,
  findings,
  entries,
};

if (json) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log('Commander core test inventory');
  console.log(`- root: ${summary.coreRoot}`);
  console.log(`- total .test.ts files: ${summary.totalFiles}`);
  console.log(`- vitest files: ${summary.vitestFiles}`);
  console.log(`- node:test files: ${summary.nodeFiles}`);
  console.log(`- vitest test.include entries: ${summary.vitestIncludeEntries}`);
  console.log(`- declared not-run: ${summary.declaredNotRunFiles}`);
  console.log(`- unregistered (executed by no runner): ${summary.unregisteredFiles}`);
  console.log(`- coverage complete: ${summary.coverageComplete ? 'yes' : 'no'}`);
  for (const finding of findings) {
    const tag = finding.severity === 'error' ? 'ERROR' : 'WARN ';
    console.log(`  [${tag}] ${finding.code}: ${finding.detail}`);
  }
  if (findings.length === 0) {
    console.log('  (no findings)');
  }
}

if (verify && errors.length > 0) {
  if (!json) {
    const codes = new Set(errors.map((e) => e.code));
    const hints = [];
    if (codes.has('UNREADABLE_TEST')) {
      hints.push(
        'UNREADABLE_TEST means the file is already registered but could not be read. If the code ' +
          'is an environment/ACL block (anything other than ENOENT), the inventory cannot be ' +
          'proven complete here — re-run where the file is readable. If it is ENOENT, the ' +
          'discovery entry is stale.',
      );
    }
    if ([...codes].some((c) => c !== 'UNREADABLE_TEST')) {
      hints.push(
        'For the remaining findings: add the file to packages/core/vitest.config.ts ' +
          '`test.include`, move it under tests/ as a node:test file, or declare it in ' +
          'packages/core/scripts/test-manifest.mjs DECLARED_NOT_RUN with a category and reason.',
      );
    }
    console.error(`\ntest-inventory: ${errors.length} verification error(s).`);
    for (const hint of hints) console.error(`  - ${hint}`);
  }
  process.exit(1);
}
