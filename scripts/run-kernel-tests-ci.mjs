import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

// Keep the canonical package test inventory; only add structured reporting.
const { scripts } = JSON.parse(
  readFileSync(new URL('../packages/kernel/package.json', import.meta.url), 'utf8'),
);
const parts = scripts.test.split(' ');
const files =
  parts[0] === 'node' && parts[1] === '--import' && parts[2] === 'tsx' && parts[3] === '--test'
    ? parts.slice(4)
    : parts[0] === 'tsx' && parts[1] === '--test'
      ? parts.slice(2)
      : [];
if (files.length === 0 || files.some((file) => !/^src\/[\w./-]+\.ts$/.test(file))) {
  throw new Error('Kernel test command changed; update the CI reporter invocation');
}
const result = spawnSync(
  process.execPath,
  [
    '--import',
    'tsx',
    '--test',
    '--test-reporter=spec',
    '--test-reporter-destination=stdout',
    '--test-reporter=' + new URL('./kernel-test-reporter.mjs', import.meta.url).href,
    '--test-reporter-destination=kernel-test-evidence.jsonl',
    ...files,
  ],
  { cwd: new URL('../packages/kernel/', import.meta.url), stdio: 'inherit' },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
