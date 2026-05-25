import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const roots = process.argv.slice(2);
if (roots.length === 0) roots.push('tests');
const files = [];

function collect(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      collect(fullPath);
    } else if (entry.isFile() && entry.name.endsWith('.test.ts')) {
      const source = readFileSync(fullPath, 'utf8');
      if (!/from\s+['"]vitest['"]/.test(source)) {
        files.push(fullPath);
      }
    }
  }
}

for (const root of roots) {
  collect(root);
}

if (files.length === 0) {
  console.error('No node:test files found.');
  process.exit(1);
}

const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const result = spawnSync(npx, ['tsx', '--test', '--test-concurrency=1', ...files], { stdio: 'inherit' });
process.exit(result.status ?? 1);
