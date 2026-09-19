/**
 * Contract tests for test registration and runner reachability (LM-01 / LM-02).
 *
 * These are `node:test` tests so they are discovered by
 * `scripts/run-node-tests.mjs` without any registration step — the property
 * they are testing.
 *
 * What is locked here:
 *   1. The inventory gate can actually fail (it used to be incapable of it).
 *   2. Commented-out entries in `vitest.config.ts` are NOT counted as enabled.
 *   3. `coverage.include` cannot leak into the `test.include` set.
 *   4. The shipped config has no duplicate and no ghost include entries.
 *   5. Every declared-not-run entry is well formed and non-contradictory.
 *   6. The node runner refuses to run a vitest file instead of reporting 0 cases.
 *   7. The node runner resolves tsx locally rather than through `npx`.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import {
  CORE_ROOT,
  DECLARED_NOT_RUN,
  classifyRunner,
  declaresAnyTest,
  discoverTestFiles,
  isNodeRunnerFile,
  readVitestInclude,
  validateDeclaration,
} from '../../scripts/test-manifest.mjs';

const INVENTORY = join(CORE_ROOT, 'scripts', 'test-inventory.mjs');
const NODE_RUNNER = join(CORE_ROOT, 'scripts', 'run-node-tests.mjs');

function runNode(script, args = [], env = {}) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: CORE_ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

describe('test-inventory --verify can fail', () => {
  const orphan = join(CORE_ROOT, 'tests', '.ws1-contract-orphan.test.ts');

  after(() => {
    rmSync(orphan, { force: true });
  });

  it('exits non-zero and names an unregistered test file', () => {
    // A vitest-importing file that is in no registration list: the exact shape
    // that used to be executed by neither runner with CI still green.
    writeFileSync(
      orphan,
      [
        "import { describe, it, expect } from 'vitest';",
        "describe('orphan', () => {",
        "  it('runs', () => { expect(1).toBe(1); });",
        '});',
        '',
      ].join('\n'),
    );

    const result = runNode(INVENTORY, ['--verify']);

    assert.notEqual(result.status, 0, 'the gate must fail when a test file is unregistered');
    assert.match(
      `${result.stdout}${result.stderr}`,
      /UNREGISTERED_TEST/,
      'the failure must name the UNREGISTERED_TEST finding',
    );
    assert.match(
      `${result.stdout}${result.stderr}`,
      /\.ws1-contract-orphan\.test\.ts/,
      'the failure must name the offending file',
    );
  });

  it('exits zero again once the orphan is gone', () => {
    rmSync(orphan, { force: true });
    const result = runNode(INVENTORY, ['--verify']);
    assert.equal(result.status, 0, `expected a clean gate, got:\n${result.stdout}${result.stderr}`);
  });

  it('exits zero in report-only mode even when the gate is red', () => {
    writeFileSync(orphan, "import { describe } from 'vitest';\ndescribe('x', () => {});\n");
    const result = runNode(INVENTORY, []);
    rmSync(orphan, { force: true });
    assert.equal(result.status, 0, 'plain inventory output must never fail the caller');
  });
});

describe('readVitestInclude parses the config statically', () => {
  it('returns an ok status with a non-empty list', () => {
    const result = readVitestInclude(CORE_ROOT);
    assert.equal(result.status, 'ok', `expected a parseable config, got ${JSON.stringify(result)}`);
    assert.ok(
      result.include.length > 300,
      `expected a large include list, got ${result.include.length}`,
    );
  });

  it('does not count commented-out entries as enabled', () => {
    const { include } = readVitestInclude(CORE_ROOT);
    const enabled = new Set(include);

    // These files exist on disk and appear only inside `//` comments in
    // vitest.config.ts. A regex-based reader reported them as enabled, which is
    // what hid them from the "missing include" report.
    //
    // `tests/runtime/llmCaller.test.ts` used to be in this list. It was then
    // legitimately registered, which broke the fixture rather than the parser:
    // a "this path is commented out" assertion cannot use a path that may later
    // become real. It is now the positive control below.
    for (const commentedOut of [
      'tests/ultimate/checkpoint.roundTrip.test.ts',
      'tests/ultimate/coordinationPolicy.test.ts',
      'tests/plugins/observability/otelExporter.test.ts',
      'tests/benchmark/performanceBenchmark.test.ts',
    ]) {
      assert.ok(
        existsSync(join(CORE_ROOT, commentedOut)),
        `fixture assumption broken: ${commentedOut} should exist on disk`,
      );
      assert.ok(
        !enabled.has(commentedOut),
        `${commentedOut} is commented out but was parsed as enabled`,
      );
    }
  });

  it('reports a genuinely enabled entry as enabled (fixture control)', () => {
    // The negative case above is only meaningful next to a positive one: if the
    // parser simply returned nothing, "not enabled" would pass vacuously.
    const { include } = readVitestInclude(CORE_ROOT);
    assert.ok(
      include.includes('tests/runtime/llmCaller.test.ts'),
      'a registered file must be reported as enabled',
    );
  });

  it('does not pick up coverage.include', () => {
    const { include } = readVitestInclude(CORE_ROOT);
    assert.ok(
      !include.includes('src/**/*.ts'),
      'coverage.include leaked into the test.include set',
    );
  });
});

describe('the shipped registration lists are internally consistent', () => {
  it('has no duplicate test.include entries', () => {
    const { include } = readVitestInclude(CORE_ROOT);
    const seen = new Set();
    const duplicates = [];
    for (const entry of include) {
      if (seen.has(entry)) duplicates.push(entry);
      seen.add(entry);
    }
    assert.deepEqual(duplicates, [], `duplicate include entries: ${duplicates.join(', ')}`);
  });

  it('has no ghost test.include entries', () => {
    const { include } = readVitestInclude(CORE_ROOT);
    const ghosts = include.filter((entry) => !existsSync(join(CORE_ROOT, entry)));
    assert.deepEqual(ghosts, [], `include entries missing on disk: ${ghosts.join(', ')}`);
  });

  it('declares every not-run file with a valid category and reason', () => {
    const problems = DECLARED_NOT_RUN.flatMap((entry) => validateDeclaration(entry, CORE_ROOT));
    assert.deepEqual(problems, [], problems.join('\n'));
  });

  it('does not declare a file as not-run while also enabling it', () => {
    const { include } = readVitestInclude(CORE_ROOT);
    const enabled = new Set(include);
    const contradictions = DECLARED_NOT_RUN.filter((entry) => enabled.has(entry.file));
    assert.deepEqual(
      contradictions.map((c) => c.file),
      [],
      'a file cannot be both enabled and declared not-run',
    );
  });

  it('leaves no test file executed by no runner', () => {
    const { include } = readVitestInclude(CORE_ROOT);
    const enabled = new Set(include);
    const declared = new Set(DECLARED_NOT_RUN.map((entry) => entry.file));

    const orphans = discoverTestFiles(CORE_ROOT).filter((file) => {
      const source = readFileSync(join(CORE_ROOT, file), 'utf8');
      if (classifyRunner(source) !== 'vitest') return false;
      return !enabled.has(file) && !declared.has(file);
    });

    assert.deepEqual(orphans, [], `unreachable vitest files: ${orphans.join(', ')}`);
  });

  it('rejects a declaration with a missing or too-short reason', () => {
    const problems = validateDeclaration(
      { file: 'tests/storage/sqliteDriver.test.ts', category: 'known-red-tracked', reason: 'x' },
      CORE_ROOT,
    );
    assert.ok(problems.length > 0, 'a one-character reason must be rejected');
    assert.ok(
      problems.some((p) => /shorter than/.test(p)),
      `expected a length complaint, got ${JSON.stringify(problems)}`,
    );
  });

  it('rejects a declaration with an unknown category', () => {
    const problems = validateDeclaration(
      {
        file: 'tests/storage/sqliteDriver.test.ts',
        category: 'made-up-category',
        reason: 'This reason is long enough to satisfy the minimum length rule.',
      },
      CORE_ROOT,
    );
    assert.ok(
      problems.some((p) => /unknown category/.test(p)),
      `expected an unknown-category complaint, got ${JSON.stringify(problems)}`,
    );
  });

  it('rejects a declaration for a file that does not exist', () => {
    const problems = validateDeclaration(
      {
        file: 'tests/does-not-exist.test.ts',
        category: 'known-red-tracked',
        reason: 'This reason is long enough to satisfy the minimum length rule.',
      },
      CORE_ROOT,
    );
    assert.ok(
      problems.some((p) => /does not exist/.test(p)),
      `expected a missing-file complaint, got ${JSON.stringify(problems)}`,
    );
  });
});

describe('classifyRunner / declaresAnyTest', () => {
  it('classifies vitest, node:test, mixed and unknown sources', () => {
    assert.equal(classifyRunner("import { it } from 'vitest';"), 'vitest');
    assert.equal(classifyRunner("import { test } from 'node:test';"), 'node');
    assert.equal(
      classifyRunner("import { it } from 'vitest';\nimport { test } from 'node:test';"),
      'mixed',
    );
    assert.equal(classifyRunner("import { jest } from '@jest/globals';"), 'unknown');
  });

  it('detects test declarations across the framework surface', () => {
    assert.ok(declaresAnyTest("it('x', () => {});"));
    assert.ok(declaresAnyTest("test('x', () => {});"));
    assert.ok(declaresAnyTest("describe('x', () => {});"));
    assert.ok(declaresAnyTest('it.each([])("x", () => {});'));
    assert.ok(!declaresAnyTest('export const nothing = 1;'));
  });

  it('treats only tests/ as node-runner territory', () => {
    const nodeSource = "import { test } from 'node:test';";
    assert.ok(isNodeRunnerFile('tests/a.test.ts', nodeSource));
    assert.ok(!isNodeRunnerFile('src/a.test.ts', nodeSource));
    assert.ok(!isNodeRunnerFile('tests/a.test.ts', "import { it } from 'vitest';"));
  });
});

describe('run-node-tests.mjs', () => {
  it('resolves tsx locally instead of shelling out to npx', () => {
    const source = readFileSync(NODE_RUNNER, 'utf8');
    // Only the executable code matters; the header comment documents the bug.
    const code = source
      .split('\n')
      .filter((line) => {
        const trimmed = line.trim();
        return !(trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*'));
      })
      .join('\n');

    // `npx tsx` resolved to a doubled node_modules path in this workspace and
    // killed every invocation with MODULE_NOT_FOUND before a single test ran.
    assert.ok(!/\bnpx\b/.test(code), 'run-node-tests.mjs must not invoke npx');
    assert.match(code, /process\.execPath/, 'run-node-tests.mjs must spawn process.execPath');
    assert.match(code, /require\.resolve\('tsx'\)/, 'the tsx loader must be resolved locally');
  });

  it('does not let a nested node:test run report success for an empty run', () => {
    const source = readFileSync(NODE_RUNNER, 'utf8');
    // Node exits 0 after "skipping running files" when NODE_TEST_CONTEXT leaks
    // into the child, so the runner must drop it and verify the summary.
    assert.match(source, /delete childEnv\.NODE_TEST_CONTEXT/);
    assert.match(source, /produced no test summary/);
    assert.match(source, /reported 0 passing tests/);
  });

  it('refuses a vitest file instead of reporting zero cases', () => {
    const result = runNode(NODE_RUNNER, ['tests/runtime/sideEffectGate.test.ts']);
    assert.notEqual(result.status, 0, 'a vitest file must not be accepted by the node runner');
    assert.match(`${result.stdout}${result.stderr}`, /belongs to the vitest runner/);
  });

  it('refuses an empty selection rather than reporting success', () => {
    const result = runNode(NODE_RUNNER, ['tests/hub']);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /no node:test files found/);
  });

  it('refuses a path that does not exist', () => {
    const result = runNode(NODE_RUNNER, ['tests/definitely-not-here.test.ts']);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /path does not exist/);
  });

  it('runs a real node:test file and reports its passes', () => {
    const result = runNode(NODE_RUNNER, ['tests/tools/gitTool.test.ts']);
    assert.equal(
      result.status,
      0,
      `expected a passing run, got:\n${result.stdout}${result.stderr}`,
    );
    const pass = /^[#ℹ]\s*pass\s+(\d+)/m.exec(result.stdout);
    assert.ok(pass, `expected a "pass N" summary line, got:\n${result.stdout}`);
    assert.ok(Number(pass[1]) > 0, 'the run must report at least one passing test');
    const fail = /^[#ℹ]\s*fail\s+(\d+)/m.exec(result.stdout);
    assert.equal(fail?.[1], '0', 'the run must report zero failures');
  });
});
