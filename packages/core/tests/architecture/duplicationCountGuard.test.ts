/**
 * PRINCIPLES §3 — duplication count guard (ENFORCED ceilings).
 *
 * Methodology is LOCKED (reproducible pure-fs walk; 2026-07-15 audit).
 * Changing regexes, roots, or allowlists is an intentional amendment:
 *   - Lowering a ceiling requires a real deletion + evidence (diff / PR).
 *   - Raising a ceiling requires intentional amendment + PRINCIPLES changelog.
 * Ceilings are CURRENT live counts, not aspirational targets.
 * The test fails only if a count goes UP (growth regression).
 *
 * ## Scope roots
 * - Walk: packages/** + apps/**
 * - Include: *.ts product sources only
 * - Exclude dirs: node_modules, dist, coverage, .git, .turbo, build, tests,
 *   test, __tests__, __mocks__
 * - Exclude files: *.d.ts, *.test.ts, *.spec.ts
 * - Count only declaration lines matching the regexes below
 *   (not re-exports, not type-only interfaces unless noted).
 *
 * ## Concepts
 * - orchestrator: `export class \w*Orchestrator`
 * - store:        `export class \w*(Store|Repository)`
 * - memory:       fixed allowlist of product memory-system class names
 *                 (not every helper under memory/; path-walk is 24–32 and is
 *                 NOT the locked definition — PRINCIPLES “memory system 7”
 *                 matches this allowlist exactly)
 * - stateMachine: `export class \w*StateMachine` + RUN_TRANSITIONS +
 *                 STEP_TRANSITIONS const tables in contracts
 *
 * Wired into root package.json `test:arch`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '../../../..');

/**
 * Live ceilings — locked 2026-07-15 methodology audit.
 * Never invent lower than live without a real deletion.
 * orchestrator=10, store=49, memory=7, stateMachine=6.
 * memory 19→17 (curator merge + apps/api EpisodicMemoryStore delete): TtlMemoryCurator merged into MemoryCurator (2026-07-15).
 * memory 17→16 (MemorySystem facade deleted 2026-07-17; assertNamespaced kept as namespaceGuard).
 * memory 16→7 (L3-10a 2026-07-17): product allowlist drops non-product internals
 *   (EpisodicMemoryStore ACT-R, MemoryFederation, MemoryManagerAgent, MemoryQualityGate,
 *   CrossModelMemory). Ceiling matches live product count; see spec/l3-10a-memory-ceiling.md.
 */
const CEILINGS = {
  orchestrator: 10,
  store: 49,
  memory: 7,
  stateMachine: 6,
} as const;

const SKIP_DIR = new Set([
  'node_modules',
  'dist',
  '.git',
  'coverage',
  '.turbo',
  'build',
  'tests',
  'test',
  '__tests__',
  '__mocks__',
]);

/** 1) Orchestrator — name ends with Orchestrator */
const ORCH_RE = /^\s*export\s+class\s+(\w*Orchestrator)\b/gm;

/** 2) Store / Repository */
const STORE_RE = /^\s*export\s+class\s+(\w*(?:Store|Repository))\b/gm;

/**
 * 3) Memory system — allowlist of product memory systems / alternate impls.
 * Explicitly NOT counted: Memory*Tool, errors, poisoning detectors/engines,
 * scorers (BM25/Thompson), HNSW/TemporalGraph/Reflexion helpers, InMemory*
 * non-memory doubles, ProjectMemoryStoreAdapter.
 * L3-10a non-product internals (still in tree, not product write authority):
 * EpisodicMemoryStore, MemoryFederation, MemoryManagerAgent, MemoryQualityGate,
 * CrossModelMemory — see spec/l3-10a-memory-ceiling.md.
 */
const MEMORY_RE =
  /^\s*export\s+class\s+(UnifiedMemory|ThreeLayerMemory|MemoryCurator|MemoryIndexManager|ConversationStore|SemanticMemoryStore|ProceduralMemoryStore)\b/gm;

/** 4a) State machine classes */
const SM_CLASS_RE = /^\s*export\s+class\s+(\w*StateMachine)\b/gm;

/** 4b) Canonical transition tables (contracts/src/states.ts) */
const SM_TRANSITIONS_RE = /^\s*export\s+const\s+(RUN_TRANSITIONS|STEP_TRANSITIONS)\b/gm;

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
    if (st.isDirectory()) {
      walkTsFiles(p, acc);
    } else if (
      name.endsWith('.ts') &&
      !name.endsWith('.d.ts') &&
      !name.endsWith('.test.ts') &&
      !name.endsWith('.spec.ts')
    ) {
      acc.push(p);
    }
  }
  return acc;
}

function productTsFiles(): string[] {
  return [...walkTsFiles(join(ROOT, 'packages')), ...walkTsFiles(join(ROOT, 'apps'))];
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
    const rel = relative(ROOT, file).replace(/\\/g, '/');
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
    for (const m of text.matchAll(MEMORY_RE)) {
      memory.push(`${rel}:${m[1]}`);
    }
    for (const m of text.matchAll(SM_CLASS_RE)) {
      stateMachine.push(`${rel}:${m[1]}`);
    }
    for (const m of text.matchAll(SM_TRANSITIONS_RE)) {
      stateMachine.push(`${rel}:${m[1]}`);
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
      `store count ${counts.store.length} > ceiling ${CEILINGS.store} (first 30):\n` +
        counts.store.sort().slice(0, 30).join('\n'),
    );
  });

  it('memory-system class count (allowlist) does not increase', () => {
    assert.ok(
      counts.memory.length <= CEILINGS.memory,
      `memory count ${counts.memory.length} > ceiling ${CEILINGS.memory}:\n` +
        counts.memory.sort().join('\n'),
    );
  });

  it('stateMachine count (classes + RUN/STEP_TRANSITIONS) does not increase', () => {
    assert.ok(
      counts.stateMachine.length <= CEILINGS.stateMachine,
      `stateMachine count ${counts.stateMachine.length} > ceiling ${CEILINGS.stateMachine}:\n` +
        counts.stateMachine.sort().join('\n'),
    );
  });

  it('reports current counts for PRINCIPLES reconciliation', () => {
    const summary = {
      orchestrator: counts.orchestrator.length,
      store: counts.store.length,
      memory: counts.memory.length,
      stateMachine: counts.stateMachine.length,
      ceilings: CEILINGS,
    };
    // Soft assert: at least one orchestrator so walk is not empty/broken.
    assert.ok(summary.orchestrator >= 1, JSON.stringify(summary, null, 2));
    // Surface live counts in assertion message for CI logs / PRINCIPLES sync.
    assert.ok(
      summary.orchestrator <= CEILINGS.orchestrator &&
        summary.store <= CEILINGS.store &&
        summary.memory <= CEILINGS.memory &&
        summary.stateMachine <= CEILINGS.stateMachine,
      `count-guard summary: ${JSON.stringify(summary)}`,
    );
  });
});
