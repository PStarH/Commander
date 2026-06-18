#!/usr/bin/env tsx
/**
 * Audit script: detect "built but unwired" reversibility modules.
 *
 * Reads scripts/reversibility.matrix.json and verifies that each listed module
 * is both imported and called from the expected runtime source files.
 *
 * Run in CI:
 *   pnpm audit:wiring
 *
 * Exit codes:
 *   0 = all modules wired
 *   1 = one or more modules are unwired
 */

import * as fs from 'fs';
import * as path from 'path';

interface WiringExpectation {
  name: string;
  importPattern: string;
  callSitePattern: string;
  minCallSites: number;
  srcPaths: string[];
}

interface WiringMatrix {
  modules: WiringExpectation[];
}

const MATRIX_PATH = path.join(process.cwd(), 'scripts', 'reversibility.matrix.json');

function loadMatrix(): WiringMatrix {
  const raw = fs.readFileSync(MATRIX_PATH, 'utf-8');
  return JSON.parse(raw) as WiringMatrix;
}

function countMatches(content: string, pattern: string): number {
  try {
    const matches = content.match(new RegExp(pattern, 'g'));
    return matches?.length ?? 0;
  } catch {
    console.error(`  Invalid regex pattern: ${pattern}`);
    return 0;
  }
}

function auditModule(mod: WiringExpectation): {
  name: string;
  wired: boolean;
  imports: number;
  callSites: number;
} {
  let totalImports = 0;
  let totalCallSites = 0;

  for (const srcPath of mod.srcPaths) {
    const fullPath = path.join(process.cwd(), srcPath);
    if (!fs.existsSync(fullPath)) {
      continue;
    }
    const content = fs.readFileSync(fullPath, 'utf-8');
    totalImports += countMatches(content, mod.importPattern);
    totalCallSites += countMatches(content, mod.callSitePattern);
  }

  return {
    name: mod.name,
    wired: totalImports >= 1 && totalCallSites >= mod.minCallSites,
    imports: totalImports,
    callSites: totalCallSites,
  };
}

function main(): void {
  const matrix = loadMatrix();
  const unwired: string[] = [];
  const wired: string[] = [];

  for (const mod of matrix.modules) {
    const result = auditModule(mod);
    const status = result.wired ? 'OK  ' : 'FAIL';
    const line = `${status} ${result.name}: imports=${result.imports}, callSites=${result.callSites} (need >=${mod.minCallSites})`;
    if (result.wired) {
      wired.push(line);
    } else {
      unwired.push(line);
    }
  }

  console.log('=== Wired modules ===');
  for (const line of wired) {
    console.log(`  ${line}`);
  }

  if (unwired.length > 0) {
    console.log('');
    console.log('=== UNWIRED modules ===');
    for (const line of unwired) {
      console.log(`  ${line}`);
    }
    console.log('');
    console.error(`Audit failed: ${unwired.length} module(s) unwired`);
    process.exit(1);
  }

  console.log('');
  console.log('=== Audit passed: all modules wired ===');
  process.exit(0);
}

main();
