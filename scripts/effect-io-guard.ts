#!/usr/bin/env node
/**
 * Static scan for external I/O bypass outside registered action-adapters.
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FIXED_ACTION_ADAPTER_MANIFESTS } from '../packages/contracts/src/actionAdapters.js';

const ROOT = process.cwd();

const SCAN_ROOTS = [
  'packages/kernel/src',
  'packages/effect-broker/src',
  'packages/worker-plane/src',
  'packages/adapter-ops/src',
  'packages/action-adapters/src',
  'packages/contracts/src',
  'packages/core/src',
  'packages/sdk/src',
  'packages/mcp-server/src',
  'apps/api/src',
];

const EXCLUDE_PATTERNS = [
  /\.test\.ts$/,
  /\.integration\.test\.ts$/,
  /\/__tests__\//,
  /\/fixtures\//,
];

const IO_PATTERNS = [
  { name: 'fetch', regex: /\bfetch\s*\(/ },
  { name: 'axios', regex: /\baxios\b/ },
  { name: 'undici', regex: /\bundici\b/ },
  { name: 'node:http', regex: /\bnode:http\b|\bfrom\s+['"]http['"]/ },
  { name: 'node:https', regex: /\bnode:https\b|\bfrom\s+['"]https['"]/ },
  { name: 'net', regex: /\bnode:net\b|\bfrom\s+['"]net['"]/ },
  { name: 'WebSocket', regex: /\bWebSocket\b|\bnew\s+WebSocket\s*\(/ },
  { name: 'child_process', regex: /\bchild_process\b|\bexecSync\s*\(|\bspawn\s*\(/ },
];

interface ExceptionEntry {
  id: string;
  path: string;
  expiresAt: string;
  patterns: string[];
}

interface AllowlistEntry {
  path: string;
  patterns: string[];
}

function loadJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf-8')) as T;
}

function isExcluded(relPath: string): boolean {
  return EXCLUDE_PATTERNS.some((p) => p.test(relPath));
}

function walk(dir: string, files: string[] = []): string[] {
  if (!existsSync(dir)) return files;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const rel = relative(ROOT, full).split('\\').join('/');
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist') continue;
      walk(full, files);
    } else if (entry.endsWith('.ts') && !isExcluded(rel)) {
      files.push(full);
    }
  }
  return files;
}

function registeredAdapterPrefixes(): string[] {
  const prefixes = new Set<string>();
  for (const manifest of FIXED_ACTION_ADAPTER_MANIFESTS) {
    if (manifest.adapterId.startsWith('github.')) prefixes.add('packages/action-adapters/src/github');
    if (manifest.adapterId.startsWith('servicenow.')) prefixes.add('packages/action-adapters/src/servicenow');
  }
  return [...prefixes];
}

function sourceMatchesPattern(source: string, pattern: string): boolean {
  const body = analyzableSource(source);
  if (pattern === 'fetch(') return /\bfetch\s*\(/.test(body);
  return body.includes(pattern);
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

function stripTypeOnlyImports(source: string): string {
  return source.split('\n').filter((line) => !/^\s*import\s+type\b/.test(line)).join('\n');
}

function analyzableSource(source: string): string {
  return stripTypeOnlyImports(stripComments(source));
}

function detectedIoTypes(source: string): string[] {
  const body = analyzableSource(source);
  return IO_PATTERNS.filter(({ regex }) => regex.test(body)).map(({ name }) => name);
}

function allowlistCoversAll(source: string, allow: AllowlistEntry): boolean {
  const detected = detectedIoTypes(source);
  if (detected.length === 0) return false;
  return detected.every((ioName) => {
    const io = IO_PATTERNS.find((p) => p.name === ioName);
    if (!io) return false;
    // Pattern must itself name/target this IO type (not merely co-exist in the file).
    return allow.patterns.some((p) => io.regex.test(p) && sourceMatchesPattern(source, p));
  });
}

function exceptionCoversAll(source: string, exception: ExceptionEntry): boolean {
  const detected = detectedIoTypes(source);
  if (detected.length === 0) return false;
  return detected.every((ioName) => {
    const io = IO_PATTERNS.find((p) => p.name === ioName);
    if (!io) return false;
    return exception.patterns.some((p) => io.regex.test(p) && sourceMatchesPattern(source, p));
  });
}

export function scanEffectIo(root = ROOT): string[] {
  const errors: string[] = [];
  const exceptionsConfig = loadJson<{ baselineCount: number; exceptions: ExceptionEntry[] }>(
    join(root, 'config/effect-io-exceptions.json'),
  );
  const allowlistConfig = loadJson<{ paths: AllowlistEntry[] }>(join(root, 'config/effect-io-allowlist.json'));
  const adapterPrefixes = registeredAdapterPrefixes();
  const today = new Date().toISOString().slice(0, 10);
  const exceptionByPath = new Map(exceptionsConfig.exceptions.map((e) => [e.path, e]));
  const allowlistByPath = new Map(allowlistConfig.paths.map((e) => [e.path, e]));

  if (exceptionsConfig.exceptions.length > exceptionsConfig.baselineCount) {
    errors.push(
      `effect-io exception count ${exceptionsConfig.exceptions.length} exceeds baseline ${exceptionsConfig.baselineCount}`,
    );
  }

  for (const ex of exceptionsConfig.exceptions) {
    if (ex.expiresAt < today && existsSync(join(root, ex.path))) {
      errors.push(`Expired effect-io exception '${ex.id}' (${ex.path})`);
    }
  }

  const currentMatches = new Set<string>();

  for (const scanRoot of SCAN_ROOTS) {
    for (const file of walk(join(root, scanRoot))) {
      const rel = relative(root, file).split('\\').join('/');
      const source = readFileSync(file, 'utf-8');
      const ioTypes = detectedIoTypes(source);
      if (ioTypes.length === 0) continue;

      if (adapterPrefixes.some((p) => rel.startsWith(p))) continue;

      const allow = allowlistByPath.get(rel);
      if (allow && allowlistCoversAll(source, allow)) continue;

      const exception = exceptionByPath.get(rel);
      if (exception && exceptionCoversAll(source, exception)) {
        currentMatches.add(rel);
        continue;
      }

      errors.push(`New external I/O bypass: ${rel} (${ioTypes.join(', ')})`);
    }
  }

  return errors;
}

function main(): void {
  const errors = scanEffectIo();
  if (errors.length > 0) {
    console.error('[effect:io-guard] FAILED:');
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  console.log('[effect:io-guard] PASSED — no new external I/O bypasses.');
}

const invokedDirectly =
  import.meta.url === pathToFileURL(process.argv[1] ?? '').href ||
  import.meta.url === `file://${process.argv[1]}`;

if (invokedDirectly) {
  main();
}
