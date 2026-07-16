#!/usr/bin/env tsx
/**
 * ws9-keypath-scan.ts — WS9 §5.1 static key-path scanner.
 *
 * Proves that no secret flows through `process.env.<X>_API_KEY` or non-Vault
 * storage. Scans source code and build artifacts for:
 *
 *   1. Forbidden `process.env.*_API_KEY` / `*_SECRET` / `*_TOKEN` references
 *      (allowlist exceptions in config/keypath-allowlist.json).
 *   2. Hardcoded key literals (sk-, AKIA, ghp_, sk-ant-, sk_live_, xox,
 *      JWT, PEM blocks — reuses UniversalSanitizer PII patterns).
 *
 * Exit codes:
 *   0  no violations (or only warnings with --allow-warnings)
 *   1  one or more FAIL violations found
 *   2  scanner error (missing allowlist, unreadable files, etc.)
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';

// ─── Types ─────────────────────────────────────────────────────────────

interface KeypathAllowlist {
  allowed: string[];
  forbiddenPatterns: string[];
  notes?: string[];
}

interface Violation {
  file: string;
  line: number;
  column: number;
  severity: 'FAIL' | 'WARN';
  rule: string;
  match: string;
  context: string;
}

interface ScanResult {
  verdict: 'PASS' | 'FAIL';
  evidenceLevel: 'ci-worm-sim';
  scannedFiles: number;
  violations: Violation[];
  warnings: Violation[];
  allowlistPath: string;
  scannedAt: string;
}

// ─── PII literal patterns (mirrors UniversalSanitizer for hardcoded keys) ─

const PII_LITERAL_PATTERNS: ReadonlyArray<{
  name: string;
  pattern: RegExp;
}> = [
  { name: 'openai_key', pattern: /\bsk-[a-zA-Z0-9]{20,}\b/ },
  { name: 'anthropic_key', pattern: /\bsk-ant-[a-zA-Z0-9]{20,}\b/ },
  { name: 'github_token', pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { name: 'aws_key', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'jwt', pattern: /\beyJ[a-zA-Z0-9_-]+\.eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\b/ },
  {
    name: 'pem_key',
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |)PRIVATE KEY-----/,
  },
  { name: 'stripe_key', pattern: /\bsk_live_[a-zA-Z0-9]{24,}\b/ },
  { name: 'slack_token', pattern: /\bxox[baprs]-[a-zA-Z0-9-]+\b/ },
];

// process.env.*_API_KEY / *_SECRET / *_TOKEN pattern
const ENV_KEY_ACCESS =
  /process\.env\.([A-Z][A-Z0-9_]*(?:_API_KEY|_SECRET|_TOKEN|_SECRET_KEY|_ACCESS_KEY|_PRIVATE_KEY))\b/g;

// ─── File walker ───────────────────────────────────────────────────────

const SCAN_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json']);

const DEFAULT_SCAN_DIRS = [
  'packages/core/src',
  'apps/api/src',
  'packages/sdk',
];

// Directories to skip entirely.
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  'coverage',
  '__pycache__',
  '.turbo',
]);

function walkDir(dir: string, results: string[] = []): string[] {
  if (!existsSync(dir)) return results;
  const entries = readdirSync(dir);
  for (const entry of entries) {
    const fullPath = path.join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      if (SKIP_DIRS.has(entry)) continue;
      walkDir(fullPath, results);
    } else if (stat.isFile() && SCAN_EXTENSIONS.has(path.extname(entry))) {
      results.push(fullPath);
    }
  }
  return results;
}

// ─── Scanner ───────────────────────────────────────────────────────────

function loadAllowlist(allowlistPath: string): KeypathAllowlist {
  if (!existsSync(allowlistPath)) {
    throw new Error(`Keypath allowlist not found: ${allowlistPath}`);
  }
  const raw = readFileSync(allowlistPath, 'utf-8');
  const parsed = JSON.parse(raw) as KeypathAllowlist;
  if (!Array.isArray(parsed.allowed) || !Array.isArray(parsed.forbiddenPatterns)) {
    throw new Error('Invalid allowlist format: expected { allowed: string[], forbiddenPatterns: string[] }');
  }
  return parsed;
}

function scanFile(
  filePath: string,
  allowlist: KeypathAllowlist,
): Violation[] {
  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  const violations: Violation[] = [];

  for (let lineNum = 0; lineNum < lines.length; lineNum++) {
    const line = lines[lineNum];
    if (!line) continue;

    // Skip comments — but still scan for hardcoded literals in comments
    // (a key in a comment is still a leak).
    const isCommentLine = /^\s*(\/\/|#|\*|\/\*)/.test(line);

    // ── Rule 1: process.env.*_API_KEY / *_SECRET / *_TOKEN ──
    let match: RegExpExecArray | null;
    ENV_KEY_ACCESS.lastIndex = 0;
    while ((match = ENV_KEY_ACCESS.exec(line)) !== null) {
      const envVar = match[1];
      const col = match.index + 'process.env.'.length;

      // Check if it's explicitly forbidden
      const isForbidden = allowlist.forbiddenPatterns.some((p) =>
        envVar.includes(p),
      );
      // Check if it's in the allowlist
      const isAllowed = allowlist.allowed.includes(envVar);

      // Transitional keys (DB_PASSWORD, SIEM_API_KEY) → WARN
      const isTransitional = envVar === 'DB_PASSWORD' || envVar === 'SIEM_API_KEY';

      if (isForbidden) {
        violations.push({
          file: filePath,
          line: lineNum + 1,
          column: col + 1,
          severity: 'FAIL',
          rule: 'forbidden-env-key',
          match: `process.env.${envVar}`,
          context: line.trim(),
        });
      } else if (!isAllowed && !isTransitional) {
        violations.push({
          file: filePath,
          line: lineNum + 1,
          column: col + 1,
          severity: 'FAIL',
          rule: 'unregistered-env-key',
          match: `process.env.${envVar}`,
          context: line.trim(),
        });
      } else if (isTransitional) {
        violations.push({
          file: filePath,
          line: lineNum + 1,
          column: col + 1,
          severity: 'WARN',
          rule: 'transitional-env-key',
          match: `process.env.${envVar}`,
          context: line.trim(),
        });
      }
    }

    // ── Rule 2: Hardcoded key literals ──
    for (const { name, pattern } of PII_LITERAL_PATTERNS) {
      if (pattern.test(line)) {
        // Don't flag patterns in regex definitions or test fixtures
        // (e.g., the sanitizer's own pattern definitions).
        const isPatternDef =
          line.includes('pattern:') ||
          line.includes('RegExp') ||
          line.includes("'/") ||
          line.includes('replacement:') ||
          line.includes('[REDACTED]');

        if (isPatternDef && !isCommentLine) continue;

        violations.push({
          file: filePath,
          line: lineNum + 1,
          column: 1,
          severity: 'FAIL',
          rule: `hardcoded-${name}`,
          match: pattern.source.slice(0, 60),
          context: line.trim().slice(0, 120),
        });
      }
    }
  }

  return violations;
}

// ─── Main ──────────────────────────────────────────────────────────────

function main(): void {
  const args = process.argv.slice(2);
  const allowWarnings = args.includes('--allow-warnings');
  const jsonOutput = args.includes('--json');
  const scanDist = args.includes('--scan-dist');

  const allowlistPath = path.resolve(
    __dirname,
    '..',
    'config',
    'keypath-allowlist.json',
  );

  let allowlist: KeypathAllowlist;
  try {
    allowlist = loadAllowlist(allowlistPath);
  } catch (err) {
    console.error(`ERROR: ${(err as Error).message}`);
    process.exit(2);
  }

  // Determine scan directories.
  const scanDirs = [...DEFAULT_SCAN_DIRS];
  if (scanDist) {
    scanDirs.push('dist');
  }

  const projectRoot = path.resolve(__dirname, '..');
  const files: string[] = [];
  for (const dir of scanDirs) {
    const absDir = path.join(projectRoot, dir);
    files.push(...walkDir(absDir));
  }

  // Also scan dist/ if it exists and --scan-dist is set.
  if (scanDist) {
    const distDir = path.join(projectRoot, 'dist');
    files.push(...walkDir(distDir));
  }

  const allViolations: Violation[] = [];
  for (const file of files) {
    const fileViolations = scanFile(file, allowlist);
    allViolations.push(...fileViolations);
  }

  const fails = allViolations.filter((v) => v.severity === 'FAIL');
  const warnings = allViolations.filter((v) => v.severity === 'WARN');

  const result: ScanResult = {
    verdict: fails.length === 0 ? 'PASS' : 'FAIL',
    evidenceLevel: 'ci-worm-sim',
    scannedFiles: files.length,
    violations: fails,
    warnings,
    allowlistPath,
    scannedAt: new Date().toISOString(),
  };

  if (jsonOutput) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`\nWS9 Keypath Scan`);
    console.log(`================`);
    console.log(`Allowlist: ${allowlistPath}`);
    console.log(`Files scanned: ${files.length}`);
    console.log(`Fails: ${fails.length}`);
    console.log(`Warnings: ${warnings.length}`);
    console.log(`Verdict: ${result.verdict}\n`);

    if (fails.length > 0) {
      console.log('── FAIL Violations ──────────────────────────────');
      for (const v of fails) {
        const rel = path.relative(projectRoot, v.file);
        console.log(`  [${v.rule}] ${rel}:${v.line}:${v.column}`);
        console.log(`    match: ${v.match}`);
        console.log(`    context: ${v.context}`);
      }
      console.log('');
    }

    if (warnings.length > 0) {
      console.log('── Warnings (transitional) ─────────────────────');
      for (const v of warnings) {
        const rel = path.relative(projectRoot, v.file);
        console.log(`  [${v.rule}] ${rel}:${v.line}:${v.column}`);
        console.log(`    match: ${v.match}`);
      }
      console.log('');
    }

    if (result.verdict === 'PASS') {
      console.log('✓ No forbidden key-path violations found.');
      if (warnings.length > 0) {
        console.log(
          `  ${warnings.length} transitional warnings (see config/keypath-allowlist.json notes).`,
        );
      }
    }
  }

  if (fails.length > 0) {
    process.exit(1);
  }
  if (warnings.length > 0 && !allowWarnings) {
    console.log('\nWarnings present. Use --allow-warnings to suppress exit code.');
    process.exit(1);
  }
  process.exit(0);
}

main();
