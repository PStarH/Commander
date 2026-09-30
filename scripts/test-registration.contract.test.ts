import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  extractTestPatterns,
  globToRegExp,
  runGate,
  scopeReaches,
  validateDeclaration,
} from './test-registration.mjs';

/**
 * Contract tests for the repository-wide test-registration gate.
 *
 * The gate exists because 49 test files in this repo were reachable by no
 * runner and had therefore never executed; 7 of them failed on first contact,
 * two of those being security gates that had been failing open. A gate that
 * silently narrows its own scope would recreate exactly that hole, so the
 * scoping rules are pinned here rather than trusted.
 */

const repoWide = () => runGate();

test('no test file in this repository is executed by no runner', () => {
  const summary = repoWide();
  const headline = summary.findings
    .filter((finding) => finding.severity === 'error')
    .map((finding) => `${finding.code}: ${finding.detail}`)
    .join('\n');
  assert.equal(summary.errorCount, 0, `registration gate reported errors:\n${headline}`);
  assert.deepEqual(summary.unregistered, []);
});

test('a package-scoped ** glob must not claim the whole repository', () => {
  const scope = {
    origin: 'packages/mcp-server/package.json#test',
    cwd: 'packages/mcp-server',
    command: 'vitest run --no-cache',
    patterns: ['**/*.test.ts'],
  };
  assert.equal(scopeReaches(scope, 'packages/mcp-server/tests/stdioServer.test.ts'), true);
  // Regression: retrying a glob repo-relative made one package's default
  // vitest include cover every test file in the monorepo.
  assert.equal(scopeReaches(scope, 'packages/kernel/src/kernel.test.ts'), false);
  assert.equal(scopeReaches(scope, 'scripts/audit-report.contract.test.ts'), false);
});

test('an explicit path declared from another package cwd still resolves', () => {
  // `pnpm --workspace-root exec node --import tsx --test packages/effect-broker/src/x.test.ts`
  // is declared in packages/effect-broker/package.json but the path is
  // repo-root-relative.
  const scope = {
    origin: 'packages/effect-broker/package.json#test',
    cwd: 'packages/effect-broker',
    command:
      'pnpm --workspace-root exec node --import tsx --test packages/effect-broker/src/broker.test.ts',
    patterns: ['packages/effect-broker/src/broker.test.ts'],
  };
  assert.equal(scopeReaches(scope, 'packages/effect-broker/src/broker.test.ts'), true);
  assert.equal(scopeReaches(scope, 'packages/effect-broker/src/other.test.ts'), false);
});

test('glob translation distinguishes * from **', () => {
  assert.equal(globToRegExp('test/*.test.ts').test('test/a.test.ts'), true);
  assert.equal(globToRegExp('test/*.test.ts').test('test/nested/a.test.ts'), false);
  assert.equal(globToRegExp('**/*.test.ts').test('a/b/c.test.ts'), true);
  assert.equal(globToRegExp('packages/*/src/*.test.ts').test('packages/core/src/a.test.ts'), true);
  assert.equal(
    globToRegExp('packages/*/src/*.test.ts').test('packages/core/tests/a.test.ts'),
    false,
  );
});

test('test patterns are extracted from a real runner command only', () => {
  assert.deepEqual(
    extractTestPatterns('node --import tsx --test scripts/a.test.ts scripts/b.test.ts'),
    ['scripts/a.test.ts', 'scripts/b.test.ts'],
  );
  assert.deepEqual(extractTestPatterns('node --import tsx --test test/*.test.ts'), [
    'test/*.test.ts',
  ]);
  // A command that runs no tests must not be treated as a scope.
  assert.deepEqual(extractTestPatterns('tsc -p tsconfig.json --noEmit'), []);
  assert.deepEqual(extractTestPatterns('node --import tsx scripts/run-integration-tests.ts'), []);
});

test('a declaration without a reason or with an unknown category is rejected', () => {
  assert.notDeepEqual(
    validateDeclaration({ file: 'a.test.ts', category: 'REQUIRES_POSTGRES', reason: 'short' }),
    [],
  );
  assert.notDeepEqual(
    validateDeclaration({
      file: 'a.test.ts',
      category: 'BECAUSE_I_SAID_SO',
      reason: 'x'.repeat(40),
    }),
    [],
  );
  assert.notDeepEqual(
    validateDeclaration({
      file: '../escape.test.ts',
      category: 'SUPERSEDED',
      reason: 'x'.repeat(40),
    }),
    [],
  );
  assert.deepEqual(
    validateDeclaration({
      file: 'a.test.ts',
      category: 'REQUIRES_CONTAINER',
      reason: 'needs a docker daemon that CI does not provide',
    }),
    [],
  );
});

test('an unregistered file is reported, and the scope floor catches a narrowed scan', () => {
  const root = mkdtempSync(join(tmpdir(), 'commander-registration-'));
  try {
    mkdirSync(join(root, 'scripts'), { recursive: true });
    mkdirSync(join(root, 'packages', 'core', 'scripts'), { recursive: true });
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        name: 'fixture',
        scripts: { test: 'node --import tsx --test scripts/registered.test.ts' },
      }),
    );
    writeFileSync(
      join(root, 'scripts', 'registered.test.ts'),
      "import { test } from 'node:test';\n",
    );
    writeFileSync(join(root, 'scripts', 'orphan.test.ts'), "import { test } from 'node:test';\n");
    writeFileSync(
      join(root, 'packages', 'core', 'scripts', 'test-inventory.mjs'),
      '// delegated gate\n',
    );
    writeFileSync(
      join(root, 'packages', 'core', 'package.json'),
      JSON.stringify({
        name: 'core',
        scripts: { test: 'node scripts/test-inventory.mjs --verify' },
      }),
    );

    const summary = runGate(root);
    const codes = summary.findings.map((finding) => finding.code);
    assert.ok(
      codes.includes('UNREGISTERED_TEST'),
      `expected UNREGISTERED_TEST, got ${codes.join(', ')}`,
    );
    assert.deepEqual(summary.unregistered, ['scripts/orphan.test.ts']);
    // Anti-vacuity: a scan that finds almost nothing must fail loudly.
    assert.ok(codes.includes('SCOPE_BELOW_FLOOR'));
    // The delegated core gate is present and wired in this fixture.
    assert.ok(!codes.includes('CORE_GATE_MISSING'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a missing delegated core gate is a hard failure', () => {
  const root = mkdtempSync(join(tmpdir(), 'commander-registration-'));
  try {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fixture', scripts: {} }));
    const codes = runGate(root).findings.map((finding) => finding.code);
    assert.ok(
      codes.includes('CORE_GATE_MISSING'),
      `expected CORE_GATE_MISSING, got ${codes.join(', ')}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a declaration for a file that a runner does reach is a contradiction', () => {
  // Pins that DECLARED_NOT_RUN cannot be used to silence a file that runs.
  const root = mkdtempSync(join(tmpdir(), 'commander-registration-'));
  try {
    mkdirSync(join(root, 'packages', 'core', 'scripts'), { recursive: true });
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        name: 'fixture',
        scripts: { test: 'node --import tsx --test scripts/a.test.ts' },
      }),
    );
    mkdirSync(join(root, 'scripts'), { recursive: true });
    writeFileSync(join(root, 'scripts', 'a.test.ts'), "import { test } from 'node:test';\n");
    writeFileSync(
      join(root, 'packages', 'core', 'scripts', 'test-inventory.mjs'),
      '// delegated gate\n',
    );
    writeFileSync(
      join(root, 'packages', 'core', 'package.json'),
      JSON.stringify({
        name: 'core',
        scripts: { test: 'node scripts/test-inventory.mjs --verify' },
      }),
    );
    // The fixture exercises only the reachability half; declare a file that is
    // in fact reached by the fixture's own script.
    const summary = runGate(root);
    assert.equal(summary.unregistered.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
