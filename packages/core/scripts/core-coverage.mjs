#!/usr/bin/env node
/**
 * Targeted coverage runner for the algorithmicEffectiveness benchmark modules.
 *
 * Dynamically discovers all registered benchmark modules, gathers their source
 * files plus any unit/benchmark tests, and runs vitest with a 90% coverage
 * threshold. This avoids loading the full src tree into a vitest config file,
 * which would trip over unrelated bundling errors.
 */
import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

const root = resolve(fileURLToPath(import.meta.url), '../..');

const listResult = spawnSync(
  'pnpm',
  [
    'exec',
    'tsx',
    '-e',
    `import { getRegisteredModuleIds, getModule } from './src/benchmarks/algorithmicEffectiveness/registry'; console.log(JSON.stringify(getRegisteredModuleIds().map(id => ({ id, path: getModule(id).path }))));`,
  ],
  { cwd: root, encoding: 'utf8' },
);

if (listResult.error || listResult.status !== 0) {
  console.error('Failed to load benchmark registry:', listResult.stderr || listResult.error);
  process.exit(1);
}

const modules = JSON.parse(listResult.stdout.trim());
const coverageIncludes = [];
const testFiles = [];

for (const { id, path } of modules) {
  if (!path) continue;
  coverageIncludes.push('--coverage.include', `src/${path}`);

  const sourceBase = path.replace(/\.ts$/, '');
  const unitTest = `tests/${sourceBase}.test.ts`;
  if (existsSync(resolve(root, unitTest))) {
    testFiles.push(unitTest);
  }

  const benchmarkTest = `tests/benchmarks/algorithmicEffectiveness/modules/${id}.test.ts`;
  if (existsSync(resolve(root, benchmarkTest))) {
    testFiles.push(benchmarkTest);
  }
}

console.log(
  `Running ${testFiles.length} test files covering ${modules.length} registered benchmark modules`,
);

const args = [
  'exec',
  'vitest',
  'run',
  '--no-cache',
  '--coverage',
  '--coverage.reportsDirectory=coverage-core',
  '--coverage.thresholds.lines=90',
  '--coverage.thresholds.statements=90',
  '--coverage.thresholds.functions=90',
  '--coverage.thresholds.branches=80',
  ...coverageIncludes,
  ...testFiles,
];

const result = spawnSync('pnpm', args, { cwd: root, stdio: 'inherit' });
process.exit(result.status ?? 1);
