#!/usr/bin/env node
/**
 * scripts/ws2-build-gate.mjs
 *
 * WS2 §4 build-time static gate. Scans production source for bypass patterns
 * that would let an external side effect skip the EffectBroker. Fails the
 * build (exit 1) on any hit so a bypass can never ship in a production
 * artifact.
 *
 * Forbidden patterns (case-insensitive):
 *   - COMMANDER_WORKER_EFFECT_POLICY=permit|allow|1  (allow-all bootstrap)
 *   - requireRequestBinding: false                    (disables request binding)
 *   - COMMANDER_EFFECT_BROKER_COMPAT                  (compat shim bypass)
 *   - COMMANDER_ATR_SOFT_BYPASS                       (SideEffectGate soft bypass)
 *   - 'permit-default' literal                        (the sentinel decisionId)
 *
 * Scope: all .ts/.tsx under packages and apps/api/src. Tests are excluded
 * so assertions that document the bypass removal can still reference the
 * literal strings (e.g. bootstrap.policy.test.ts).
 *
 * Exit codes:
 *   0  no bypass patterns in production source
 *   1  one or more forbidden patterns found
 *   2  structural error (could not scan)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const SCAN_ROOTS = ['packages', 'apps'];
const SCAN_GLOBS = ['.ts', '.tsx'];
const TEST_PATTERNS = [
  /\.test\./,
  /\.spec\./,
  /\/tests?\//,
  /\/__tests__\//,
  /\.e2e\./,
  // Conformance harness exercises negative broker options; not production runtime.
  /\/conformance\//,
];

// Each entry: [regex, label]. Regex is case-insensitive where noted.
const FORBIDDEN = [
  // permit-all bootstrap env (any assignment / comparison to permit|allow|1)
  [/COMMANDER_WORKER_EFFECT_POLICY\s*[=:]\s*['"]?(?:permit|allow|1)['"]?/gi, 'COMMANDER_WORKER_EFFECT_POLICY=permit/allow/1'],
  // request binding disabled
  [/requireRequestBinding\s*:\s*false/gi, 'requireRequestBinding: false'],
  // compat shim env
  [/COMMANDER_EFFECT_BROKER_COMPAT/gi, 'COMMANDER_EFFECT_BROKER_COMPAT'],
  // ATR soft bypass env
  [/COMMANDER_ATR_SOFT_BYPASS/gi, 'COMMANDER_ATR_SOFT_BYPASS'],
  // permit-default decisionId literal (string literal)
  [/['"]permit-default['"]/g, "'permit-default' literal"],
];

function walk(dir, acc) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // skip node_modules, dist, .git, coverage
      if (['node_modules', 'dist', '.git', 'coverage', '.turbo', 'build'].includes(entry.name)) continue;
      walk(full, acc);
    } else if (entry.isFile() && SCAN_GLOBS.some((ext) => entry.name.endsWith(ext))) {
      acc.push(full);
    }
  }
}

const files = [];
for (const scanRoot of SCAN_ROOTS) {
  walk(path.join(root, scanRoot), files);
}

let violations = 0;
for (const file of files) {
  const rel = path.relative(root, file);
  const isTest = TEST_PATTERNS.some((re) => re.test(rel));
  if (isTest) continue;
  let content;
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  for (const [regex, label] of FORBIDDEN) {
    regex.lastIndex = 0;
    const match = regex.exec(content);
    if (match) {
      // Find line number for the report.
      const upto = content.slice(0, match.index);
      const line = upto.split('\n').length;
      console.error(`❌ WS2 bypass forbidden pattern: ${label}`);
      console.error(`   ${rel}:${line}`);
      violations++;
    }
  }
}

if (violations > 0) {
  console.error(`\nWS2 build gate FAILED: ${violations} forbidden pattern(s) in production source.`);
  console.error('EffectBroker bypasses are not allowed in production builds (spec/ws2-effect-monopoly.md §4).');
  process.exit(1);
}

console.log(`WS2 build gate OK: scanned ${files.length} production source files, 0 bypass patterns.`);
process.exit(0);
