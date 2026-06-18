import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

// Scan 'tests/' for test files; 'benchmarks/' is at the project root, not inside packages/core.
const roots = ['tests'];
const verify = process.argv.includes('--verify');
const json = process.argv.includes('--json');

function toPosix(p) {
  return p.split(sep).join('/');
}

function collectFiles(dir, predicate, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectFiles(fullPath, predicate, out);
    } else if (entry.isFile() && predicate(fullPath)) {
      out.push(toPosix(relative(process.cwd(), fullPath)));
    }
  }
  return out;
}

function classify(source) {
  if (/from\s+['"]vitest['"]/.test(source)) return 'vitest';
  if (/from\s+['"]node:test['"]/.test(source)) return 'node';
  return 'unknown';
}

function countTests(source) {
  const matches = source.match(/\b(?:it|test)\s*\(/g);
  return matches ? matches.length : 0;
}

function readVitestIncludes() {
  const config = readFileSync('vitest.config.ts', 'utf8');
  // Only scan the `include:` array — not coverage.exclude or other sections
  const includeMatch = config.match(/include:\s*\[([^\]]+)\]/s);
  if (!includeMatch) return new Set();
  return new Set(
    Array.from(includeMatch[1].matchAll(/['"]([^'"]+\.test\.ts)['"]/g))
      .map((match) => match[1])
      .sort(),
  );
}

const testFiles = roots
  .flatMap((root) => collectFiles(root, (file) => file.endsWith('.test.ts')))
  .sort();

const entries = testFiles.map((file) => {
  const source = readFileSync(file, 'utf8');
  return {
    file,
    runner: classify(source),
    tests: countTests(source),
  };
});

const vitestIncludes = readVitestIncludes();
const vitestFiles = entries.filter((e) => e.runner === 'vitest').map((e) => e.file);
const nodeFiles = entries.filter((e) => e.runner === 'node').map((e) => e.file);
const unknownFiles = entries.filter((e) => e.runner === 'unknown').map((e) => e.file);
const missingVitestIncludes = vitestFiles.filter((file) => !vitestIncludes.has(file));
const staleVitestIncludes = Array.from(vitestIncludes).filter(
  (file) => !vitestFiles.includes(file),
);
const benchmarkFiles = entries.filter((e) => e.file.startsWith('benchmarks/')).map((e) => e.file);

const summary = {
  totalFiles: entries.length,
  nodeFiles: nodeFiles.length,
  vitestFiles: vitestFiles.length,
  benchmarkFiles: benchmarkFiles.length,
  unknownFiles: unknownFiles.length,
  approximateTestCases: entries.reduce((sum, entry) => sum + entry.tests, 0),
  missingVitestIncludes,
  staleVitestIncludes,
  entries,
};

if (json) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log('Commander core test inventory');
  console.log(`- total .test.ts files: ${summary.totalFiles}`);
  console.log(`- node:test files: ${summary.nodeFiles}`);
  console.log(`- vitest files: ${summary.vitestFiles}`);
  console.log(`- benchmark test files: ${summary.benchmarkFiles}`);
  console.log(`- approximate test cases: ${summary.approximateTestCases}`);
  if (missingVitestIncludes.length > 0) {
    console.log(`- missing vitest includes: ${missingVitestIncludes.join(', ')}`);
  }
  if (staleVitestIncludes.length > 0) {
    console.log(`- stale vitest includes: ${staleVitestIncludes.join(', ')}`);
  }
  if (unknownFiles.length > 0) {
    console.log(`- unknown runner files: ${unknownFiles.join(', ')}`);
  }
}

if (
  verify &&
  (unknownFiles.length > 0 || missingVitestIncludes.length > 0 || staleVitestIncludes.length > 0)
) {
  process.exit(1);
}
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const roots = ['tests', 'benchmarks'];
const verify = process.argv.includes('--verify');
const json = process.argv.includes('--json');

function toPosix(p) {
  return p.split(sep).join('/');
}

function collectFiles(dir, predicate, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectFiles(fullPath, predicate, out);
    } else if (entry.isFile() && predicate(fullPath)) {
      out.push(toPosix(relative(process.cwd(), fullPath)));
    }
  }
  return out;
}

function classify(source) {
  if (/from\s+['"]vitest['"]/.test(source)) return 'vitest';
  if (/from\s+['"]node:test['"]/.test(source)) return 'node';
  return 'unknown';
}

function countTests(source) {
  const matches = source.match(/\b(?:it|test)\s*\(/g);
  return matches ? matches.length : 0;
}

function readVitestIncludes() {
  const config = readFileSync('vitest.config.ts', 'utf8');
  return new Set(
    Array.from(config.matchAll(/['"]([^'"]+\.test\.ts)['"]/g))
      .map(match => match[1])
      .sort(),
  );
}

const testFiles = roots.flatMap(root =>
  collectFiles(root, file => file.endsWith('.test.ts')),
).sort();

const entries = testFiles.map(file => {
  const source = readFileSync(file, 'utf8');
  return {
    file,
    runner: classify(source),
    tests: countTests(source),
  };
});

const vitestIncludes = readVitestIncludes();
const vitestFiles = entries.filter(e => e.runner === 'vitest').map(e => e.file);
const nodeFiles = entries.filter(e => e.runner === 'node').map(e => e.file);
const unknownFiles = entries.filter(e => e.runner === 'unknown').map(e => e.file);
const missingVitestIncludes = vitestFiles.filter(file => !vitestIncludes.has(file));
const staleVitestIncludes = Array.from(vitestIncludes).filter(file => !vitestFiles.includes(file));
const benchmarkFiles = entries.filter(e => e.file.startsWith('benchmarks/')).map(e => e.file);

const summary = {
  totalFiles: entries.length,
  nodeFiles: nodeFiles.length,
  vitestFiles: vitestFiles.length,
  benchmarkFiles: benchmarkFiles.length,
  unknownFiles: unknownFiles.length,
  approximateTestCases: entries.reduce((sum, entry) => sum + entry.tests, 0),
  missingVitestIncludes,
  staleVitestIncludes,
  entries,
};

if (json) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log('Commander core test inventory');
  console.log(`- total .test.ts files: ${summary.totalFiles}`);
  console.log(`- node:test files: ${summary.nodeFiles}`);
  console.log(`- vitest files: ${summary.vitestFiles}`);
  console.log(`- benchmark test files: ${summary.benchmarkFiles}`);
  console.log(`- approximate test cases: ${summary.approximateTestCases}`);
  if (missingVitestIncludes.length > 0) {
    console.log(`- missing vitest includes: ${missingVitestIncludes.join(', ')}`);
  }
  if (staleVitestIncludes.length > 0) {
    console.log(`- stale vitest includes: ${staleVitestIncludes.join(', ')}`);
  }
  if (unknownFiles.length > 0) {
    console.log(`- unknown runner files: ${unknownFiles.join(', ')}`);
  }
}

if (verify && (unknownFiles.length > 0 || missingVitestIncludes.length > 0 || staleVitestIncludes.length > 0)) {
  process.exit(1);
}
