import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

// Keep the canonical package test inventory; only add structured reporting.
const { scripts } = JSON.parse(
  readFileSync(new URL('../packages/kernel/package.json', import.meta.url), 'utf8'),
);
const [runner, flag, ...files] = scripts.test.split(' ');
if (
  runner !== 'tsx' ||
  flag !== '--test' ||
  files.length === 0 ||
  files.some((file) => !/^src\/[\w./-]+\.ts$/.test(file))
) {
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
