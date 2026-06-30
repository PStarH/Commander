/*
 * Circular Dependency Detection — guards against re-introducing import cycles
 * in the core package. A-grade modularity requires no runtime cycles in src/.
 *
 * Strategy: parse TypeScript files with a lightweight regex import scanner
 * (no madge dependency — keeps the test zero-install), build a directed
 * import graph, and run Tarjan's SCC algorithm to find any strongly-
 * connected component with size > 1. Reports offending file chains clearly.
 *
 * Scope: src/ only (all .ts files under src/, not tests/). Tests may
 * legitimately cycle through test helpers.
 *
 * Whitelist: certain pairs are type-only cycles that don't matter at runtime
 * (e.g. pluginManager and plugins/builtin via type-only imports). The test
 * fails on VALUE-import cycles only, since those actually cause runtime
 * "undefined" errors. type-only imports (import type {...}) are erased by
 * the TypeScript compiler and are safe.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

interface ImportEdge {
  from: string; // absolute path of importing file
  to: string;   // absolute path of imported file
  isTypeOnly: boolean;
}

const SRC_ROOT = path.resolve(path.join(process.cwd(), 'src'));

// Walk all .ts files under src/ and collect value-import edges.
function collectValueImportEdges(): ImportEdge[] {
  const edges: ImportEdge[] = [];
  const visited = new Set<string>();

  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith('.ts') && !entry.name.endsWith('.tsx')) continue;
      if (entry.name.endsWith('.d.ts')) continue;
      if (visited.has(full)) continue;
      visited.add(full);

      const src = fs.readFileSync(full, 'utf8');
      // Two import forms to handle separately:
      //   import type { X } from 'mod'      → type-only (erased at runtime)
      //   import { X } from 'mod'           → value import
      //   import DefaultName from 'mod'     → value import
      //   import * as ns from 'mod'         → value import
      //   import Default, { X } from 'mod'  → value import
      // We treat anything that does NOT start with `import type` as a value import.
      // Also handle side-effect-only `import 'mod'` (value).
      const statements = src.match(/^[\t ]*import[^\n]+/gm) || [];
      for (const stmt of statements) {
        const isTypeOnly = /^[\t ]*import\s+type\b/.test(stmt);
        const specMatch = stmt.match(/from\s+['"]([^'"]+)['"]/);
        const sideEffectMatch = stmt.match(/^[\t ]*import\s+['"]([^'"]+)['"]/);
        const spec = specMatch ? specMatch[1] : sideEffectMatch ? sideEffectMatch[1] : null;
        if (!spec) continue;
        // Only relative imports inside the package.
        if (!spec.startsWith('.')) continue;
        const resolved = resolveModule(full, spec);
        if (!resolved) continue;
        edges.push({ from: full, to: resolved, isTypeOnly });
      }
    }
  };

  walk(SRC_ROOT);
  return edges;
}

/** Resolve a relative module spec to an absolute file path. */
function resolveModule(fromFile: string, spec: string): string | null {
  const base = path.resolve(path.dirname(fromFile), spec);
  const candidates = [
    base,
    base + '.ts',
    base + '.tsx',
    path.join(base, 'index.ts'),
    path.join(base, 'index.tsx'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  }
  return null;
}

/** Tarjan's SCC algorithm. Returns SCCs with size > 1. */
function findSCCs(nodes: string[], edges: Array<{ from: string; to: string }>): string[][] {
  const adj = new Map<string, string[]>();
  for (const n of nodes) adj.set(n, []);
  for (const e of edges) {
    if (adj.has(e.from)) adj.get(e.from)!.push(e.to);
  }
  let index = 0;
  const stack: string[] = [];
  const onStack = new Set<string>();
  const indices = new Map<string, number>();
  const lowlinks = new Map<string, number>();
  const sccs: string[][] = [];

  const strongConnect = (v: string) => {
    indices.set(v, index);
    lowlinks.set(v, index);
    index++;
    stack.push(v);
    onStack.add(v);
    for (const w of adj.get(v) || []) {
      if (!indices.has(w)) {
        strongConnect(w);
        lowlinks.set(v, Math.min(lowlinks.get(v)!, lowlinks.get(w)!));
      } else if (onStack.has(w)) {
        lowlinks.set(v, Math.min(lowlinks.get(v)!, indices.get(w)!));
      }
    }
    if (lowlinks.get(v) === indices.get(v)) {
      const scc: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        scc.push(w);
      } while (w !== v);
      if (scc.length > 1) sccs.push(scc);
    }
  };

  for (const v of nodes) {
    if (!indices.has(v)) strongConnect(v);
  }
  return sccs;
}

describe('circular dependency detection (A-grade modularity guard)', () => {
  it('src/ has no VALUE-import cycles (type-only cycles are allowed)', () => {
    const edges = collectValueImportEdges();
    const valueEdges = edges.filter((e) => !e.isTypeOnly);
    const nodes = new Set<string>();
    for (const e of valueEdges) {
      nodes.add(e.from);
      nodes.add(e.to);
    }
    const sccs = findSCCs([...nodes], valueEdges);

    if (sccs.length > 0) {
      const report = sccs
        .map((scc, i) => {
          const rel = scc.map((p) => path.relative(SRC_ROOT, p)).join(' → ');
          return `Cycle ${i + 1}: ${rel}`;
        })
        .join('\n');
      assert.fail(
        `Found ${sccs.length} value-import cycle(s) in src/. Cycles cause runtime ` +
          `"undefined" import errors. Offending chains:\n${report}`,
      );
    }
  });

  it('pluginManager.ts is now a barrel (no class definitions)', () => {
    // Regression guard: ensure pluginManager.ts stays a thin re-export and
    // doesn't grow back the 1280-line HookManager class.
    const src = fs.readFileSync(
      path.join(SRC_ROOT, 'pluginManager.ts'),
      'utf8',
    );
    assert.ok(
      !/^export\s+class\s+HookManager/m.test(src),
      'pluginManager.ts must not define class HookManager — it should re-export from hookManager.ts',
    );
    assert.ok(
      /export.*from\s+['"]\.\/hookManager['"]/.test(src),
      'pluginManager.ts must re-export from ./hookManager',
    );
    assert.ok(
      /export.*from\s+['"]\.\/pluginTypes['"]/.test(src),
      'pluginManager.ts must re-export from ./pluginTypes',
    );
  });

  it('providerRegistry.ts is the single source of provider metadata', () => {
    // Regression guard: ensure commanderConfig.ts derives provider metadata
    // from providerRegistry via the get*() accessors, NOT via hardcoded
    // object literals (which would require editing 8+ files per new provider).
    const cfgSrc = fs.readFileSync(
      path.join(SRC_ROOT, 'config', 'commanderConfig.ts'),
      'utf8',
    );
    // Must import from providerRegistry.
    assert.ok(
      /from\s+['"][^'"]*providerRegistry['"]/.test(cfgSrc),
      'commanderConfig.ts must import from providerRegistry',
    );
    // Must call at least one of the get*() accessors.
    assert.ok(
      /getProviderOrder|getEnvMap|getDefaultUrls|getDefaultModels|getDisplayNames|getApiTypes/.test(cfgSrc),
      'commanderConfig.ts must derive provider metadata from providerRegistry accessors',
    );
    // Must NOT have a literal 20+ key object literal assignment to PROVIDER_ORDER etc.
    // (Detect by spotting many string literal keys followed by `:`.)
    const literalBlockRegex = /(?:PROVIDER_ORDER|ENV_MAP|DEFAULT_URLS|DEFAULT_MODELS|DISPLAY_NAMES|API_TYPE)\s*[:=]\s*\{[\s\S]{0,200}?['"][a-z]+['"]\s*:/;
    assert.ok(
      !literalBlockRegex.test(cfgSrc),
      'commanderConfig.ts must not contain a literal provider Record — derive from providerRegistry',
    );
  });

  it('httpServer.ts getDefaultProvider is a one-line factory call', () => {
    // Regression guard: the 60-line 24-case switch must not come back.
    const src = fs.readFileSync(
      path.join(SRC_ROOT, 'runtime', 'httpServer.ts'),
      'utf8',
    );
    // Find the getDefaultProvider DEFINITION (not call sites). Must be a
    // method/function declaration, not `this.getDefaultProvider(...)`.
    const fnMatch = src.match(/(?:private|public|protected|function)\s+getDefaultProvider\s*\([^)]*\)[^{]*\{[\s\S]*?\n\s*\}/);
    assert.ok(fnMatch, 'getDefaultProvider definition must exist in httpServer.ts');
    const fnBody = fnMatch[0];
    assert.ok(
      !/case\s+['"]/.test(fnBody),
      'getDefaultProvider must not contain a switch/case — use createProvider() from providerRegistry',
    );
    assert.ok(
      /createProvider/.test(fnBody),
      'getDefaultProvider must call createProvider() from providerRegistry',
    );
  });
});
