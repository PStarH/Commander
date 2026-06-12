#!/usr/bin/env node
/**
 * audit-wiring.mjs — CI gate that fails the build if any "shipped-but-unwired"
 * module from the v2 reversibility matrix is found with 0 import sites in src/.
 *
 * A module is "wired" if at least one file in src/ (excluding the module's own
 * defining file) imports from the module's path.
 *
 * Run from packages/core/:
 *   node scripts/audit-wiring.mjs
 *
 * Exit code 0 = all modules wired (PASS)
 * Exit code 1 = at least one module has 0 import sites (FAIL)
 *
 * Source of truth: docs/rfcs/reversibility-rfc-v2.md Part 3
 * Machine-readable: packages/core/reversibility.matrix.json
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join, relative, sep } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PACKAGE_ROOT = resolve(__dirname, '..');
const SRC_ROOT = join(PACKAGE_ROOT, 'src');
const MATRIX_PATH = join(PACKAGE_ROOT, 'reversibility.matrix.json');

if (!existsSync(MATRIX_PATH)) {
  console.error(`[audit-wiring] FATAL: ${relative(process.cwd(), MATRIX_PATH)} not found.`);
  console.error('Run scripts/audit-wiring.mjs from packages/core/ after creating the matrix.');
  process.exit(2);
}

const matrix = JSON.parse(readFileSync(MATRIX_PATH, 'utf-8'));

function collectFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectFiles(full, out);
    } else if (entry.isFile() && (full.endsWith('.ts') && !full.endsWith('.d.ts'))) {
      out.push(full);
    }
  }
  return out;
}

function grepCount(filePath, patterns) {
  let count = 0;
  const source = readFileSync(filePath, 'utf-8');
  for (const pat of patterns) {
    const escaped = pat.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`\\b${escaped}\\b`, 'g');
    const matches = source.match(re);
    if (matches) count += matches.length;
  }
  return count;
}

function countImportSites(filePath, modulePathSuffix) {
  const source = readFileSync(filePath, 'utf-8');
  const escaped = modulePathSuffix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Match either the absolute path (e.g. '../runtime/processCrashSafety')
  // or the relative basename (e.g. './processCrashSafety'). Both must match
  // so a wire-up from inside the same directory is detected.
  const baseName = escaped.split('/').pop();
  const re = new RegExp(
    `from\\s+['"](?:[^'"]*${escaped}['"]|\\.\\/${baseName}['"]|\\.\\.\\/${baseName}['"]|\\.\\.\\/\\.\\.\\/${baseName}['"])`,
    'g'
  );
  return (source.match(re) || []).length;
}

const files = collectFiles(SRC_ROOT);

const FAIL = '\x1b[31m';
const OK = '\x1b[32m';
const WARN = '\x1b[33m';
const RESET = '\x1b[0m';

const rows = [];
let fail = 0;
let warn = 0;

for (const mode of matrix.modes) {
  if (!mode.expectedWiredModules || mode.expectedWiredModules.length === 0) {
    continue;
  }
  for (const mod of mode.expectedWiredModules) {
    const definingRel = mod.definingFile || '';
    const importSuffix = definingRel
      ? definingRel.replace(/\.ts$/, '').replace(/^src\//, '')
      : mod.name;

    let externalImportSites = 0;
    let selfImportSites = 0;
    let importingFiles = [];
    for (const f of files) {
      const rel = relative(PACKAGE_ROOT, f).split(sep).join('/');
      const count = countImportSites(f, importSuffix);
      if (count === 0) continue;
      if (rel === definingRel) {
        selfImportSites += count;
      } else {
        externalImportSites += count;
        importingFiles.push(rel);
      }
    }

    const minRequired = mod.minCallSites ?? 1;
    const status = externalImportSites >= minRequired
      ? 'ok'
      : (mod.optional ? 'warn' : 'fail');
    if (status === 'fail') fail++;
    if (status === 'warn') warn++;
    rows.push({
      mode: mode.id,
      module: mod.name,
      importSuffix,
      callSites: externalImportSites,
      selfRefs: selfImportSites,
      importers: importingFiles,
      minRequired,
      status,
      tier: mod.tier ?? 'n/a',
    });
  }
}

const pad = (s, n) => String(s).padEnd(n);
console.log('');
console.log(`${pad('Mode', 5)} ${pad('Module', 32)} ${pad('Imports', 8)} ${pad('Self', 5)} ${pad('Min', 4)} ${pad('Status', 7)} Tier`);
console.log('-'.repeat(85));
for (const r of rows) {
  const color = r.status === 'ok' ? OK : r.status === 'warn' ? WARN : FAIL;
  const label = r.status === 'ok' ? 'PASS' : r.status === 'warn' ? 'WARN' : 'FAIL';
  console.log(`${pad('M' + r.mode, 5)} ${pad(r.module, 32)} ${pad(String(r.callSites), 8)} ${pad(String(r.selfRefs), 5)} ${pad(String(r.minRequired), 4)} ${color}${pad(label, 7)}${RESET} ${r.tier}`);
}
console.log('-'.repeat(85));
console.log(`Total modules audited: ${rows.length}`);
console.log(`  Pass: ${rows.filter(r => r.status === 'ok').length}`);
console.log(`  Warn: ${warn}`);
console.log(`  Fail: ${fail}`);
if (rows.some(r => r.callSites === 0 && r.status !== 'warn')) {
  console.log('');
  console.log('Unwired modules (import sites: 0):');
  for (const r of rows) {
    if (r.callSites === 0 && r.status !== 'warn') {
      console.log(`  M${r.mode} ${r.module} (${r.tier}) — definingFile: ${r.importSuffix}`);
    }
  }
}
console.log('');

if (fail > 0) {
  console.error(`${FAIL}[audit-wiring] FAIL${RESET}: ${fail} module(s) have 0 import sites in src/.`);
  console.error('These are reversibility components that exist as files but are not wired into the runtime.');
  console.error('See docs/rfcs/reversibility-rfc-v2.md for the wire-up tiers.');
  process.exit(1);
}

console.log(`${OK}[audit-wiring] PASS${RESET}: all expected modules are wired.`);
process.exit(0);
