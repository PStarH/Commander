#!/usr/bin/env npx tsx
/**
 * Scan core barrel files for types (interface/type) re-exported as values,
 * which breaks raw tsx ESM transforms (vitest tolerates it, standalone
 * demo-qa scripts do not).
 */
import { readFileSync, readdirSync, statSync } from 'fs';
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

const barrels = walk('packages/core/src');
const problems: string[] = [];

for (const barrel of barrels) {
  const src = readFileSync(barrel, 'utf8');
  const re = /export\s*\{([^}]*)\}\s*from\s*'([^']+)'/gs;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const names = m[1]
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const modPath = m[2];
    if (!modPath.startsWith('.')) continue;
    const base = resolve(dirname(barrel), modPath);
    let file = '';
    for (const cand of [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]) {
      try {
        readFileSync(cand);
        file = cand;
        break;
      } catch {
        /* try next */
      }
    }
    if (!file) continue;
    const modSrc = readFileSync(file, 'utf8');
    for (const name of names) {
      const clean = name.replace(/^type\s+/, '');
      const typeDecl = new RegExp(`export (?:interface|type) ${clean}\\b`);
      if (typeDecl.test(modSrc)) {
        problems.push(
          `${barrel}: '${clean}' is a type but re-exported as a value from '${modPath}'`,
        );
      }
    }
  }
}

for (const p of problems) console.log(p);
console.log(`total: ${problems.length}`);
