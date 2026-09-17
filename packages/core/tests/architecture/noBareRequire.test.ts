/**
 * Architecture gate: no bare `require(...)` in an ES-module package's sources.
 *
 * Every package scanned here declares `"type": "module"`, so the CommonJS
 * `require` binding does not exist and a bare `require('x')` raises
 * `ReferenceError: require is not defined`. Because almost every such call sits
 * inside a `try`/`catch` intended to tolerate an *absent* optional dependency,
 * the ReferenceError is silently swallowed and the capability is disabled while
 * the code reports an unrelated reason.
 *
 * Measured impact before this gate (2026-09-16): 35 sites in
 * `packages/core/src` — Postgres backend reported unavailable while `pg` was
 * installed, OIDC/SAML/SIEM auth plugins never registered, capability-token
 * cascade revocation was a no-op, three-layer memory persistence silently wrote
 * nothing while `hasPersistence()` returned `true`, and the `isolated-vm`
 * sandbox tier degraded to the non-sandbox `vm` module.
 *
 * Scope (widened 2026-09-17): `src/` **and** `tests/`. Scanning only `src/` made
 * this gate fail open — it printed "0 violations across 1293 source files" while
 * `packages/core/tests/advanced-integration.test.ts` alone held 18 bare
 * `require` calls that broke 7 `node:test` suites and, via one leaked handle,
 * blocked the entire 196-file run. A gate that cannot see a whole tree reports
 * safety it has not verified.
 *
 * The first test asserts the real tree is clean. The remaining tests prove the
 * scanner can actually fail — a gate that cannot fail is not a gate.
 */
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { discoverEsmTargets, scanAll, scanPackage } from '../../scripts/scan-bare-require.mjs';

test('no bare require() calls in any ESM package source', () => {
  const { violations, fileCount, trees } = scanAll();
  // Anti-vacuity: a scan that read no files would trivially "pass". The bound is
  // deliberately above the `src/`-only count (~1293), so a silent regression to
  // the narrower scope fails here as well as in the dedicated scope test below.
  assert.ok(
    fileCount > 1500,
    `expected the scan to read a large source tree, but it read only ${fileCount} files — ` +
      `the scanner is probably pointed at the wrong root or trees (trees=${JSON.stringify(trees)}).`,
  );
  assert.deepEqual(trees, ['src', 'tests'], 'the scan must cover both trees');
  const report = violations.map((v) => `  ${v.file}:${v.line}  ${v.snippet}`).join('\n');
  assert.equal(
    violations.length,
    0,
    `found ${violations.length} bare require() call(s) in ESM package sources.\n` +
      'These raise `ReferenceError: require is not defined` at runtime.\n' +
      'Use `nodeRequire`/`optionalRequire` from packages/core/src/optionalImport.ts,\n' +
      'or bind `createRequire(import.meta.url)` locally.\n' +
      report,
  );
});

test('the scanner is falsifiable: it reports a bare require()', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bare-require-gate-'));
  try {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(
      join(dir, 'src', 'bad.ts'),
      [
        'export function probe(): unknown {',
        "  try { return require('pg'); } catch { return null; }",
        '}',
      ].join('\n'),
      'utf8',
    );

    const { violations, fileCount } = scanPackage(dir, { repoRoot: dir });
    assert.equal(fileCount, 1, 'expected the scanner to read one file');
    assert.equal(violations.length, 1, 'expected exactly one violation');
    assert.equal(violations[0].line, 2, 'violation should be reported on line 2');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the scanner exempts a locally bound require', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bare-require-exempt-'));
  try {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(
      join(dir, 'src', 'ok.ts'),
      [
        "import { createRequire } from 'node:module';",
        'const require = createRequire(import.meta.url);',
        'export function probe(): unknown {',
        "  return require('pg');",
        '}',
      ].join('\n'),
      'utf8',
    );

    const { violations, fileCount } = scanPackage(dir, { repoRoot: dir });
    assert.equal(fileCount, 1, 'expected the scanner to read one file');
    assert.deepEqual(violations, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the scanner ignores require() inside comments and string literals', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bare-require-noise-'));
  try {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(
      join(dir, 'src', 'noise.ts'),
      [
        '// const fs = require("fs");',
        '/** Lazy require("better-sqlite3") with try/catch. */',
        'export const generated = `const http = require("http");`;',
        'export const payload = "Plugin: require(\\"admin-tools\\")";',
      ].join('\n'),
      'utf8',
    );

    const { violations, fileCount } = scanPackage(dir, { repoRoot: dir });
    assert.equal(fileCount, 1, 'expected the scanner to read one file');
    assert.deepEqual(violations, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the scanner derives its targets from each package.json "type"', () => {
  // The same `.ts` extension means different things depending on the nearest
  // manifest, so the target list is derived rather than hardcoded. This test
  // recomputes the set independently and compares — if a package's `type`
  // changes, or a new ESM package appears, the gate must notice rather than
  // silently keep scanning a stale list.
  const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
  const expected: string[] = [];
  for (const group of ['packages', 'apps']) {
    for (const name of readdirSync(join(repoRoot, group))) {
      const manifest = join(repoRoot, group, name, 'package.json');
      if (!existsSync(manifest)) continue;
      const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as { type?: string };
      if (parsed.type === 'module') expected.push(`${group}/${name}`);
    }
  }

  assert.deepEqual(discoverEsmTargets({ repoRoot }), expected.sort());
  assert.ok(expected.length >= 13, `expected at least 13 ESM packages, saw ${expected.length}`);
});

test('the scanner excludes the CommonJS packages', () => {
  // `packages/contracts` has no `"type": "module"`, so `require`/`__dirname`
  // are legitimate there and flagging them would be a false positive. The
  // repo-root `scripts/` tree is the same (the root manifest has no `type`).
  const targets = discoverEsmTargets();
  assert.ok(!targets.includes('packages/contracts'), 'contracts is CommonJS and must be excluded');
  assert.ok(
    !targets.some((t) => t.startsWith('scripts')),
    'the repo-root scripts/ tree is CommonJS and must be excluded',
  );
});

test('the scanner reports a per-package file count for every target', () => {
  const { perPackage } = scanAll();
  assert.ok(
    perPackage['packages/core'] > 500,
    `packages/core should contribute a large file count, saw ${perPackage['packages/core']}`,
  );
  assert.equal(
    Object.keys(perPackage).length,
    13,
    'every declared ESM target should be accounted for',
  );
});

test('the scanner reports a bare __dirname / __filename', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cjs-global-gate-'));
  try {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(
      join(dir, 'src', 'bad.ts'),
      [
        "import * as path from 'node:path';",
        "export const here = path.join(__dirname, 'x');",
        'export const self = __filename;',
      ].join('\n'),
      'utf8',
    );

    const { violations } = scanPackage(dir, { repoRoot: dir });
    assert.equal(violations.length, 2, `expected 2 violations, got ${JSON.stringify(violations)}`);
    assert.deepEqual(
      violations.map((v) => v.kind),
      ['cjs-global', 'cjs-global'],
    );
    assert.deepEqual(
      violations.map((v) => v.line),
      [2, 3],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the scanner exempts a locally bound __dirname', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cjs-global-exempt-'));
  try {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(
      join(dir, 'src', 'ok.ts'),
      [
        "import { getDirname } from './esmCompat';",
        'const __dirname = getDirname(import.meta.url);',
        'export const here = __dirname;',
      ].join('\n'),
      'utf8',
    );

    assert.deepEqual(scanPackage(dir, { repoRoot: dir }).violations, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the scanner reports a relative specifier routed through a shared helper', () => {
  // Regression for the first attempt at this fix: a single shared
  // `createRequire(import.meta.url)` resolves `./redTeamFramework` against
  // ITS OWN directory, so from src/security/ it became MODULE_NOT_FOUND.
  const dir = mkdtempSync(join(tmpdir(), 'shared-helper-gate-'));
  try {
    mkdirSync(join(dir, 'src', 'security'), { recursive: true });
    writeFileSync(join(dir, 'src', 'optionalImport.ts'), 'export const x = 1;\n', 'utf8');
    writeFileSync(
      join(dir, 'src', 'security', 'bad.ts'),
      "import { optionalRequire } from '../optionalImport';\nexport const x = optionalRequire('./redTeamFramework');\n",
      'utf8',
    );

    const { violations } = scanPackage(dir, { repoRoot: dir });
    assert.equal(violations.length, 1, `expected 1 violation, got ${JSON.stringify(violations)}`);
    assert.equal(violations[0].kind, 'unresolvable-relative');
    assert.equal(violations[0].line, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the scanner does NOT flag a relative specifier that does resolve', () => {
  const dir = mkdtempSync(join(tmpdir(), 'resolvable-relative-'));
  try {
    mkdirSync(join(dir, 'src', 'security'), { recursive: true });
    writeFileSync(join(dir, 'src', 'security', 'sibling.ts'), 'export const x = 1;\n', 'utf8');
    writeFileSync(
      join(dir, 'src', 'security', 'ok.ts'),
      "import { createRequire } from 'node:module';\nconst nodeRequire = createRequire(import.meta.url);\nexport const x = nodeRequire('./sibling');\n",
      'utf8',
    );

    assert.deepEqual(scanPackage(dir, { repoRoot: dir }).violations, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the scanner reports require.resolve on the global', () => {
  const dir = mkdtempSync(join(tmpdir(), 'require-resolve-gate-'));
  try {
    mkdirSync(join(dir, 'src'), { recursive: true });
    // `./x` deliberately does not exist, so BOTH checks fire: the property
    // access on the undefined global, and the unresolvable relative specifier.
    writeFileSync(join(dir, 'src', 'bad.ts'), "export const p = require.resolve('./x');\n", 'utf8');

    const { violations } = scanPackage(dir, { repoRoot: dir });
    assert.deepEqual(
      violations.map((v) => v.kind).sort(),
      ['bare-require-prop', 'unresolvable-relative'],
      `unexpected violations: ${JSON.stringify(violations)}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the scan covers each package tests/ tree, not just src/', () => {
  // Scanning only `src/` made this gate fail open. This test pins the scope so
  // a future "simplification" back to `src/` cannot go unnoticed.
  const dir = mkdtempSync(join(tmpdir(), 'bare-require-tests-tree-'));
  try {
    mkdirSync(join(dir, 'src'), { recursive: true });
    mkdirSync(join(dir, 'tests'), { recursive: true });
    writeFileSync(join(dir, 'src', 'ok.ts'), 'export const x = 1;\n', 'utf8');
    writeFileSync(
      join(dir, 'tests', 'bad.test.ts'),
      ['export function probe(): unknown {', "  return require('pg');", '}'].join('\n'),
      'utf8',
    );

    const { violations, fileCount, trees } = scanPackage(dir, { repoRoot: dir });
    assert.deepEqual(trees, ['src', 'tests'], 'both trees must be scanned');
    assert.equal(fileCount, 2, 'expected both files to be read');
    assert.equal(
      violations.length,
      1,
      `expected the tests/ violation to be reported, got ${JSON.stringify(violations)}`,
    );
    assert.match(violations[0].file, /tests\/bad\.test\.ts$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a suppression marker with a reason silences the site and is recorded', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bare-require-suppress-'));
  try {
    mkdirSync(join(dir, 'tests'), { recursive: true });
    writeFileSync(
      join(dir, 'tests', 'deliberate.test.ts'),
      [
        "import { optionalRequire } from '../src/optionalImport';",
        'export const x =',
        '  // scan-bare-require-allow: the unresolved specifier is the subject under test',
        "  optionalRequire('./redTeamFramework');",
      ].join('\n'),
      'utf8',
    );

    const { violations, suppressions } = scanPackage(dir, { repoRoot: dir });
    assert.deepEqual(
      violations,
      [],
      `expected the site to be suppressed, got ${JSON.stringify(violations)}`,
    );
    assert.equal(suppressions.length, 1, 'a suppression must be recorded, not silently dropped');
    assert.equal(
      suppressions[0].line,
      4,
      'the suppressed line should be the call, not the comment',
    );
    assert.equal(suppressions[0].kind, 'unresolvable-relative');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a suppression marker without a reason is itself a violation', () => {
  // A suppression channel that opens on a bare word is just a way to turn the
  // gate off, so the reason is mandatory and enforced.
  const dir = mkdtempSync(join(tmpdir(), 'bare-require-suppress-noreason-'));
  try {
    mkdirSync(join(dir, 'tests'), { recursive: true });
    writeFileSync(
      join(dir, 'tests', 'sneaky.test.ts'),
      "export const x = require('pg'); // scan-bare-require-allow:\n",
      'utf8',
    );

    const { violations, suppressions } = scanPackage(dir, { repoRoot: dir });
    assert.deepEqual(suppressions, [], 'a reasonless marker must not suppress anything');
    assert.deepEqual(
      violations.map((v) => v.kind).sort(),
      ['bare-require', 'invalid-suppression'],
      `unexpected violations: ${JSON.stringify(violations)}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a suppression marker inside a string literal is not a suppression', () => {
  // Regression: the marker was originally matched against raw line text, so
  // this very file's fixture below registered as a reasonless suppression and
  // failed the gate it was written to test. Only a comment can suppress.
  const dir = mkdtempSync(join(tmpdir(), 'bare-require-suppress-in-string-'));
  try {
    mkdirSync(join(dir, 'tests'), { recursive: true });
    writeFileSync(
      join(dir, 'tests', 'fixture.test.ts'),
      // The marker appears only inside the string payload, never in a comment.
      'export const fixture = "export const x = require(\'pg\'); // scan-bare-require-allow:\\n";\n',
      'utf8',
    );

    const { violations, suppressions } = scanPackage(dir, { repoRoot: dir });
    assert.deepEqual(suppressions, [], 'a marker inside a string must not suppress');
    assert.deepEqual(violations, [], 'and must not be reported as an invalid suppression either');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a suppression marker trailing a real violation suppresses only that line', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bare-require-suppress-trailing-'));
  try {
    mkdirSync(join(dir, 'tests'), { recursive: true });
    writeFileSync(
      join(dir, 'tests', 'trailing.test.ts'),
      [
        "export const a = require('pg'); // scan-bare-require-allow: kept to prove the trailing form works",
        "export const b = require('pg');",
      ].join('\n'),
      'utf8',
    );

    const { violations, suppressions } = scanPackage(dir, { repoRoot: dir });
    assert.equal(suppressions.length, 1, 'the annotated line should be suppressed');
    assert.equal(suppressions[0].line, 1);
    assert.equal(violations.length, 1, 'the un-annotated line must still be reported');
    assert.equal(violations[0].line, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the real tree carries only the documented suppressions', () => {
  // Every suppression is a hole in the gate, so the set is pinned: adding one
  // is a deliberate act that has to be reflected here.
  const { suppressions } = scanAll();
  assert.equal(
    suppressions.length,
    2,
    `expected exactly 2 justified suppressions, saw ${suppressions.length}: ` +
      JSON.stringify(suppressions),
  );
  assert.ok(
    suppressions.every((s) => s.file === 'packages/core/tests/architecture/esmRequire.test.ts'),
    `unexpected suppression site(s): ${JSON.stringify(suppressions.map((s) => s.file))}`,
  );
});
