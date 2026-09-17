#!/usr/bin/env npx tsx
/**
 * Codemod: split type names out of value re-export blocks in barrel files.
 *
 * `export { A, B } from './x'` where A is an interface/type breaks raw tsx
 * ESM transforms (isolated-modules style; vitest tolerates it, standalone
 * demo-qa scripts do not). Rewrites such blocks into
 * `export type { A } from './x';` + `export { B } from './x';`.
 *
 * Run with --write to apply; default is a dry-run printout.
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'fs';
import { join, dirname, resolve } from 'path';

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (p.includes('node_modules')) continue;
    const s = statSync(p);
    if (s.isDirectory()) walk(p, out);
    else if (/index\.tsx?$/.test(e)) out.push(p);
  }
  return out;
}

function resolveModule(barrel: string, modPath: string): string | null {
  if (!modPath.startsWith('.')) return null;
  const base = resolve(dirname(barrel), modPath);
  for (const cand of [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]) {
    try {
      readFileSync(cand);
      return cand;
    } catch {
      /* try next */
    }
  }
  return null;
}

const WRITE = process.argv.includes('--write');
const barrels = walk('packages/core/src');
let fixedFiles = 0;
let fixedNames = 0;

for (const barrel of barrels) {
  const src = readFileSync(barrel, 'utf8');
  const re = /export\s*\{([^}]*)\}\s*from\s*'([^']+)'/g;
  let changed = false;
  let out = '';
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const names = m[1]
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const modPath = m[2];
    const file = resolveModule(barrel, modPath);
    if (!file || names.length === 0) continue;
    const modSrc = readFileSync(file, 'utf8');
    const valueNames: string[] = [];
    const typeNames: string[] = [];
    for (const name of names) {
      const clean = name.replace(/^type\s+/, '');
      const isType =
        new RegExp(`export (?:interface|type) ${clean}\\b`).test(modSrc) ||
        new RegExp(`export type \\{[^}]*\\b${clean}\\b`, 's').test(modSrc);
      if (isType) {
        typeNames.push(clean);
      } else {
        valueNames.push(name);
      }
    }
    if (typeNames.length === 0) continue;
    fixedNames += typeNames.length;
    changed = true;
    out += src.slice(last, m.index);
    if (valueNames.length > 0) {
      out += `export { ${valueNames.join(', ')} } from '${modPath}';\n`;
    }
    out += `export type { ${typeNames.join(', ')} } from '${modPath}';`;
    last = m.index + m[0].length;
  }
  if (changed) {
    out += src.slice(last);
    fixedFiles++;
    if (WRITE) {
      writeFileSync(barrel, out);
      console.log(`FIXED ${barrel}`);
    } else {
      console.log(`WOULD FIX ${barrel}`);
    }
  }
}

console.log(
  `files: ${fixedFiles}, names split: ${fixedNames}, ${WRITE ? 'APPLIED' : 'DRY RUN (use --write)'}`,
);
