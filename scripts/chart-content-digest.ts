#!/usr/bin/env tsx
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

const PREFIX = Buffer.from('commander.chart-content/v1\0', 'utf8');
const ANNOTATION = /^  commander\.io\/content-sha256: ([0-9a-f]{64})$/m;
const ZERO_DIGEST = '0'.repeat(64);

function fail(code: string): never {
  throw new Error(code);
}

function normalizedRelativePath(root: string, entry: string): string {
  const relativePath = relative(root, entry);
  if (
    relativePath.length === 0 ||
    relativePath.startsWith(`..${sep}`) ||
    relativePath === '..' ||
    relativePath.includes('\\') ||
    relativePath.split(sep).some((part) => part.length === 0 || part === '.' || part === '..')
  ) {
    fail('CHART_CONTENT_PATH_INVALID');
  }
  return relativePath.split(sep).join('/');
}

function collectFiles(root: string, directory = root): string[] {
  const entries = readdirSync(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = join(directory, entry.name);
    const stats = lstatSync(fullPath);
    if (stats.isSymbolicLink() || (!stats.isDirectory() && !stats.isFile())) {
      fail('CHART_CONTENT_PATH_INVALID');
    }
    if (stats.isDirectory()) files.push(...collectFiles(root, fullPath));
    if (stats.isFile()) files.push(fullPath);
  }
  return files;
}

function chartBytesForDigest(path: string, bytes: Buffer): Buffer {
  if (!path.endsWith('/Chart.yaml') && path !== 'Chart.yaml') return bytes;
  const text = bytes.toString('utf8');
  if (Buffer.from(text, 'utf8').compare(bytes) !== 0 || text.includes('\r')) {
    fail('CHART_CONTENT_ANNOTATION_INVALID');
  }
  const matches = [...text.matchAll(new RegExp(ANNOTATION.source, 'gm'))];
  if (matches.length !== 1 || matches[0]?.[1]?.length !== 64) {
    fail('CHART_CONTENT_ANNOTATION_INVALID');
  }
  const valueCharacterOffset = matches[0].index! + matches[0][0].length - 64;
  const offset = Buffer.byteLength(text.slice(0, valueCharacterOffset), 'utf8');
  const next = Buffer.from(bytes);
  next.fill(0x30, offset, offset + 64);
  return next;
}

function writeU32(value: number): Buffer {
  const result = Buffer.alloc(4);
  result.writeUInt32BE(value);
  return result;
}

function writeU64(value: number): Buffer {
  if (!Number.isSafeInteger(value) || value < 0) fail('CHART_CONTENT_LENGTH_INVALID');
  const result = Buffer.alloc(8);
  result.writeBigUInt64BE(BigInt(value));
  return result;
}

export function computeChartContentDigest(chartDirectory: string): string {
  const root = resolve(chartDirectory);
  const chartStats = lstatSync(root);
  if (!chartStats.isDirectory() || chartStats.isSymbolicLink()) fail('CHART_CONTENT_PATH_INVALID');
  const entries = collectFiles(root)
    .map((file) => ({ file, path: normalizedRelativePath(root, file) }))
    .sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
  if (!entries.some((entry) => entry.path === 'Chart.yaml'))
    fail('CHART_CONTENT_ANNOTATION_INVALID');

  const hash = createHash('sha256').update(PREFIX);
  for (const entry of entries) {
    const pathBytes = Buffer.from(entry.path, 'utf8');
    const content = chartBytesForDigest(entry.path, readFileSync(entry.file));
    hash.update(writeU32(pathBytes.length));
    hash.update(pathBytes);
    hash.update(writeU64(content.length));
    hash.update(content);
  }
  return hash.digest('hex');
}

function chartAnnotation(chartDirectory: string): { path: string; text: string; value: string } {
  const path = join(resolve(chartDirectory), 'Chart.yaml');
  const bytes = readFileSync(path);
  const text = bytes.toString('utf8');
  if (Buffer.from(text, 'utf8').compare(bytes) !== 0 || text.includes('\r')) {
    fail('CHART_CONTENT_ANNOTATION_INVALID');
  }
  const matches = [...text.matchAll(new RegExp(ANNOTATION.source, 'gm'))];
  if (matches.length !== 1) fail('CHART_CONTENT_ANNOTATION_INVALID');
  return { path, text, value: matches[0]![1]! };
}

export function verifyChartContentDigest(chartDirectory: string): string {
  const annotation = chartAnnotation(chartDirectory);
  const computed = computeChartContentDigest(chartDirectory);
  if (annotation.value !== computed) fail('CHART_CONTENT_DIGEST_MISMATCH');
  return computed;
}

export function stampChartContentDigest(chartDirectory: string): string {
  const annotation = chartAnnotation(chartDirectory);
  const digest = computeChartContentDigest(chartDirectory);
  writeFileSync(annotation.path, annotation.text.replace(annotation.value, digest));
  return digest;
}

function main(): void {
  const [command, chartDirectory = 'deploy/helm/commander'] = process.argv.slice(2);
  if (command === 'stamp') {
    process.stdout.write(`${stampChartContentDigest(chartDirectory)}\n`);
    return;
  }
  if (command === 'verify') {
    process.stdout.write(`${verifyChartContentDigest(chartDirectory)}\n`);
    return;
  }
  process.stderr.write(`usage: chart-content-digest.ts <stamp|verify> [chart-directory]\n`);
  process.exitCode = 2;
}

if (process.argv[1]?.endsWith('chart-content-digest.ts')) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'CHART_CONTENT_FAILED'}\n`);
    process.exitCode = 1;
  }
}
