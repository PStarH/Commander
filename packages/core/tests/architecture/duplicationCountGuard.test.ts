/**
 * PRINCIPLES §3 — duplication count guard (ENFORCED ceilings).
 *
 * Methodology is LOCKED here. Changing the regex or roots is an intentional
 * amendment (update PRINCIPLES changelog + raise/lower ceilings with evidence).
 * Ceilings are CURRENT live counts (2026-07-15 census), not aspirational targets.
 * The test fails only if a count goes UP.
 *
 * Scope: packages/** + apps/** TypeScript product sources.
 * Excludes: node_modules, dist, .git, *.d.ts, *.test.ts, tests/, __tests__/
 *
 * Concepts:
 * - orchestrator: `export class XOrchestrator` (name ends with Orchestrator)
 * - store:        `export class XStore|XRepository`
 * - memory:       `export class` under packages/core/src/memory/**,
 *                 packages/core/src/threeLayerMemory.ts, or apps/api/src/*[Mm]emory*
 * - stateMachine: `export class XStateMachine`
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '../../../..');

/** Live ceilings — locked 2026-07-15. Only decrease over time (or amend with evidence). */
const CEILINGS = {
  orchestrator: 10,
  store: 51,
  memory: 21,
  stateMachine: 4,
} as const;

const SKIP_DIR = new Set([
  'node_modules',
  'dist',
  '.git',
  'coverage',
  '.turbo',
  'build',
  'tests',
  '__tests__',
]);

const ORCH_RE = /^export class (\w*Orchestrator)\b/gm;
const STORE_RE = /^export class (\w*(?:Store|Repository))\b/gm;
const CLASS_RE = /^export class (\w+)\b/gm;
const SM_RE = /^export class (\w*StateMachine)\b/gm;

function walkTsFiles(dir: string, acc: string[] = []): string[] {
  if (!existsSync(dir)) return acc;
  for (const name of readdirSync(dir)) {
    if (SKIP_DIR.has(name) || name.startsWith('.')) continue;
    const p = join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) walkTsFiles(p, acc);
    else if (name.endsWith('.ts') && !name.endsWith('.d.ts') && !name.endsWith('.test.ts')) {
      acc.push(p);
    }
  }
  return acc;
}

function productTsFiles(): string[] {
  return [...walkTsFiles(join(ROOT, 'packages')), ...walkTsFiles(join(ROOT, 'apps'))];
}

function isMemoryScoped(rel: string): boolean {
  const n = rel.replace(/\\/g, '/');
  if (n.includes('/packages/core/src/memory/')) return true;
  if (n.endsWith('/packages/core/src/threeLayerMemory.ts')) return true;
  if (n.includes('/apps/api/src/') && /memory/i.test(n.split('/').pop() ?? '')) return true;
  return false;
}

function countAll(): {
  orchestrator: string[];
  store: string[];
  memory: string[];
  stateMachine: string[];
} {
  const orchestrator: string[] = [];
  const store: string[] = [];
  const memory: string[] = [];
  const stateMachine: string[] = [];

  for (const file of productTsFiles()) {
    const rel = relative(ROOT, file);
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const m of text.matchAll(ORCH_RE)) {
      orchestrator.push(`${rel}:${m[1]}`);
    }
    for (const m of text.matchAll(STORE_RE)) {
      store.push(`${rel}:${m[1]}`);
    }
    for (const m of text.matchAll(SM_RE)) {
      stateMachine.push(`${rel}:${m[1]}`);
    }
    if (isMemoryScoped(rel)) {
      for (const m of text.matchAll(CLASS_RE)) {
        const name = m[1]!;
        if (name.endsWith('Error')) continue;
        // Only count memory-domain types in scoped files (skip helpers)
        if (
          /Memory|Curator|Store|Scorer|Gate|Guard|Manager|Federation|Unified|ThreeLayer/.test(
            name,
          )
        ) {
          memory.push(`${rel}:${name}`);
        }
      }
    }
  }
  return { orchestrator, store, memory, stateMachine };
}

describe('PRINCIPLES §3 duplication count guard', () => {
  const counts = countAll();

  it('orchestrator class count does not increase', () => {
    assert.ok(
      counts.orchestrator.length <= CEILINGS.orchestrator,
      `orchestrator count ${counts.orchestrator.length} > ceiling ${CEILINGS.orchestrator}:\n` +
        counts.orchestrator.sort().join('\n'),
    );
  });

  it('store/repository class count does not increase', () => {
    assert.ok(
      counts.store.length <= CEILINGS.store,
      `store count ${counts.store.length} > ceiling ${CEILINGS.store} (first 20):\n` +
        counts.store.sort().slice(0, 20).join('\n'),
    );
  });

  it('memory-domain class count does not increase', () => {
    assert.ok(
      counts.memory.length <= CEILINGS.memory,
      `memory count ${counts.memory.length} > ceiling ${CEILINGS.memory}:\n` +
        counts.memory.sort().join('\n'),
    );
  });

  it('stateMachine class count does not increase', () => {
    assert.ok(
      counts.stateMachine.length <= CEILINGS.stateMachine,
      `stateMachine count ${counts.stateMachine.length} > ceiling ${CEILINGS.stateMachine}:\n` +
        counts.stateMachine.sort().join('\n'),
    );
  });

  it('reports current counts for PRINCIPLES reconciliation', () => {
    // Soft assert equality so drift is visible in failure message if someone
    // lowers a ceiling without updating this diagnostic.
    const summary = {
      orchestrator: counts.orchestrator.length,
      store: counts.store.length,
      memory: counts.memory.length,
      stateMachine: counts.stateMachine.length,
      ceilings: CEILINGS,
    };
    assert.ok(summary.orchestrator >= 1, JSON.stringify(summary));
  });
});
