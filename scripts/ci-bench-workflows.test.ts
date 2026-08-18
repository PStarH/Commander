import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { load } from 'js-yaml';

const root = process.cwd();
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>;
};

function workflow(name: string): { source: string; value: Record<string, unknown> } {
  const source = readFileSync(join(root, '.github', 'workflows', name), 'utf8');
  return { source, value: load(source) as Record<string, unknown> };
}

test('registers every scheduled bench command in package scripts', () => {
  assert.equal(
    packageJson.scripts['bench:cost-model-drift'],
    'pnpm exec tsx scripts/bench-cost-model-drift.ts',
  );
  assert.equal(
    packageJson.scripts['bench:memory-poisoning'],
    'pnpm exec tsx scripts/bench-memory-poisoning.ts',
  );
});

test('rebuilds and probes the SQLite binding before SLO and GAIA benches', () => {
  for (const [file, benchStep] of [
    ['slo-bench.yml', 'Run SLO bench'],
    ['gaia-bench.yml', 'Run GAIA bench'],
  ]) {
    const { source } = workflow(file);
    const rebuild = source.indexOf('pnpm rebuild better-sqlite3');
    const probe = source.indexOf("require('better-sqlite3')");
    const bench = source.indexOf(benchStep);

    assert.ok(rebuild >= 0, file + ' must rebuild better-sqlite3');
    assert.ok(probe >= 0, file + ' must probe better-sqlite3');
    assert.ok(rebuild < bench && probe < bench, file + ' must prepare SQLite before the bench');
  }
});

test('baseline PR workflows use explicit write permissions without persisted checkout credentials', () => {
  for (const file of [
    'wal-bench.yml',
    'cost-bench.yml',
    'cost-model-drift-bench.yml',
    'memory-poisoning-bench.yml',
    'tenant-isolation-bench.yml',
    'slo-bench.yml',
    'gaia-bench.yml',
    'chaos-bench.yml',
  ]) {
    const { source, value } = workflow(file);
    assert.deepEqual(value.permissions, { contents: 'write', 'pull-requests': 'write' }, file);
    assert.match(
      source,
      /uses: actions\/checkout@v[46]\n\s+with:\n(?:\s+#[^\n]*\n)*\s+persist-credentials: false/m,
      file,
    );
  }
});
