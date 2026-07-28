#!/usr/bin/env node
/**
 * Legacy Authority Inventory Gate — Task 1
 *
 * Scans API, Web, CLI, MCP, and runtime entry points that can create or mutate
 * a run/effect/approval/evidence, classifies each authority, and fails when a
 * new write-capable legacy authority appears without a matching fixture entry.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

export type AuthorityKind = 'canonical' | 'read-only-legacy' | 'write-capable-legacy' | 'temporary-gate';
export type Disposition = 'retain' | 'migrate-and-delete' | 'migrate-to-readonly' | 'remove';

export interface InventoryEntry {
  path: string;
  authorityKind: AuthorityKind;
  callers: string[];
  writesExternally: boolean;
  canonicalReplacement: string | null;
  disposition: Disposition;
}

export interface InventoryResult {
  entries: InventoryEntry[];
  newWriteAuthorities: InventoryEntry[];
  passed: boolean;
}

const ROOT = process.cwd();
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.turbo', 'coverage', '.worktrees']);
const SRC_EXTENSIONS = new Set(['.ts', '.tsx']);

const WRITE_PATTERNS = [
  { regex: /\bnew\s+AgentRuntime\b/, label: 'AgentRuntime construction' },
  { regex: /\bnew\s+(UltimateOrchestrator|TELOSOrchestrator)\b/, label: 'orchestrator construction' },
  { regex: /\bnew\s+RunLedger\b/, label: 'RunLedger construction' },
  { regex: /\bnew\s+(?:Sqlite)?WarRoomStore\b/, label: 'WarRoomStore construction' },
];

const READ_PATTERNS = [
  { regex: /\bfetchWarRoomSnapshot\b/, label: 'fetchWarRoomSnapshot' },
  { regex: /\bgetRuntimeStats\b/, label: 'getRuntimeStats' },
  { regex: /\bgetTenantRunDurations\b/, label: 'getTenantRunDurations' },
  { regex: /\blistModels\b/, label: 'listModels' },
  { regex: /\broute_task\b/, label: 'route_task' },
];

interface ClassificationRule {
  path: string;
  authorityKind: AuthorityKind;
  writesExternally: boolean;
  canonicalReplacement: string | null;
  disposition: Disposition;
  reason?: string;
}

const HARDCODED_RULES: ClassificationRule[] = [
  // Canonical V2 authorities
  {
    path: 'apps/api/src/v1GatewayEndpoints.ts',
    authorityKind: 'canonical',
    writesExternally: true,
    canonicalReplacement: null,
    disposition: 'retain',
  },
  {
    path: 'apps/api/src/actionGatewayEndpoints.ts',
    authorityKind: 'canonical',
    writesExternally: true,
    canonicalReplacement: null,
    disposition: 'retain',
  },
  {
    path: 'packages/kernel/src/postgres.ts',
    authorityKind: 'canonical',
    writesExternally: true,
    canonicalReplacement: null,
    disposition: 'retain',
  },
  {
    path: 'packages/kernel/src/sqlite.ts',
    authorityKind: 'canonical',
    writesExternally: true,
    canonicalReplacement: null,
    disposition: 'retain',
  },
  {
    path: 'packages/worker-plane/src/m3-worker-plane.ts',
    authorityKind: 'canonical',
    writesExternally: true,
    canonicalReplacement: null,
    disposition: 'retain',
  },
  {
    path: 'packages/effect-broker/src/index.ts',
    authorityKind: 'canonical',
    writesExternally: true,
    canonicalReplacement: null,
    disposition: 'retain',
  },
  // Temporary gates
  {
    path: 'apps/api/src/legacyExecutionGuard.ts',
    authorityKind: 'temporary-gate',
    writesExternally: false,
    canonicalReplacement: null,
    disposition: 'remove',
  },
  {
    path: 'scripts/architecture-gate.ts',
    authorityKind: 'temporary-gate',
    writesExternally: false,
    canonicalReplacement: null,
    disposition: 'remove',
  },
  {
    path: 'scripts/legacy-authority-inventory.ts',
    authorityKind: 'temporary-gate',
    writesExternally: false,
    canonicalReplacement: null,
    disposition: 'remove',
  },
  // Write-capable legacy authorities
  {
    path: 'apps/api/src/sharedRuntime.ts',
    authorityKind: 'write-capable-legacy',
    writesExternally: true,
    canonicalReplacement: 'POST /v1/runs',
    disposition: 'migrate-and-delete',
  },
  {
    path: 'apps/api/src/agentRuntimeRegistry.ts',
    authorityKind: 'write-capable-legacy',
    writesExternally: true,
    canonicalReplacement: 'POST /v1/runs + worker-plane',
    disposition: 'migrate-and-delete',
  },
  {
    path: 'apps/api/src/orchestratorEndpoints.ts',
    authorityKind: 'write-capable-legacy',
    writesExternally: true,
    canonicalReplacement: 'POST /v1/runs with WorkGraph',
    disposition: 'migrate-and-delete',
  },
  {
    path: 'packages/core/src/cliEntry.ts',
    authorityKind: 'write-capable-legacy',
    writesExternally: true,
    canonicalReplacement: 'local CLI only; no enterprise writes',
    disposition: 'migrate-to-readonly',
  },
  {
    path: 'packages/mcp-server/src/stdioServer.ts',
    authorityKind: 'write-capable-legacy',
    writesExternally: true,
    canonicalReplacement: 'MCP execute_agent → ActionGatewayClient',
    disposition: 'migrate-and-delete',
  },
  {
    path: 'packages/core/src/controlPlane/index.ts',
    authorityKind: 'write-capable-legacy',
    writesExternally: true,
    canonicalReplacement: 'distributed identity from authority closure',
    disposition: 'migrate-and-delete',
  },
  {
    path: 'apps/api/src/store.ts',
    authorityKind: 'write-capable-legacy',
    writesExternally: true,
    canonicalReplacement: 'kernel projections',
    disposition: 'migrate-and-delete',
  },
  {
    path: 'apps/api/src/sequentialExecutor.ts',
    authorityKind: 'write-capable-legacy',
    writesExternally: true,
    canonicalReplacement: 'POST /v1/runs',
    disposition: 'migrate-and-delete',
  },
  {
    path: 'packages/core/src/agentLoop.ts',
    authorityKind: 'write-capable-legacy',
    writesExternally: true,
    canonicalReplacement: 'worker-plane agent loop',
    disposition: 'migrate-and-delete',
  },
  {
    path: 'packages/core/src/atr/runLedger.ts',
    authorityKind: 'write-capable-legacy',
    writesExternally: true,
    canonicalReplacement: 'kernel run repository',
    disposition: 'migrate-and-delete',
  },
  {
    path: 'packages/core/src/atr/taskQueue.ts',
    authorityKind: 'write-capable-legacy',
    writesExternally: true,
    canonicalReplacement: 'kernel task queue',
    disposition: 'migrate-and-delete',
  },
  {
    path: 'packages/core/src/cli/commands/_shared.ts',
    authorityKind: 'write-capable-legacy',
    writesExternally: true,
    canonicalReplacement: 'local CLI helpers only',
    disposition: 'migrate-to-readonly',
  },
  {
    path: 'packages/core/src/cli/commands/core.ts',
    authorityKind: 'write-capable-legacy',
    writesExternally: true,
    canonicalReplacement: 'local CLI only; no enterprise writes',
    disposition: 'migrate-to-readonly',
  },
  {
    path: 'packages/core/src/cli/commands/small-features.ts',
    authorityKind: 'write-capable-legacy',
    writesExternally: true,
    canonicalReplacement: 'local CLI only; no enterprise writes',
    disposition: 'migrate-to-readonly',
  },
  {
    path: 'packages/core/src/cli/commands/up.ts',
    authorityKind: 'write-capable-legacy',
    writesExternally: true,
    canonicalReplacement: 'local CLI only; no enterprise writes',
    disposition: 'migrate-to-readonly',
  },
  {
    path: 'packages/core/src/cli/commands/workflow.ts',
    authorityKind: 'write-capable-legacy',
    writesExternally: true,
    canonicalReplacement: 'local CLI only; no enterprise writes',
    disposition: 'migrate-to-readonly',
  },
  {
    path: 'packages/core/src/commander/factory.ts',
    authorityKind: 'write-capable-legacy',
    writesExternally: true,
    canonicalReplacement: 'local runtime factory only',
    disposition: 'migrate-to-readonly',
  },
  {
    path: 'packages/core/src/runtime/httpServer.ts',
    authorityKind: 'write-capable-legacy',
    writesExternally: true,
    canonicalReplacement: 'local runtime HTTP server only',
    disposition: 'migrate-to-readonly',
  },
  {
    path: 'packages/core/src/runtime/mcpRemoteRuntime.ts',
    authorityKind: 'write-capable-legacy',
    writesExternally: true,
    canonicalReplacement: 'ActionGatewayClient',
    disposition: 'migrate-and-delete',
  },
  {
    path: 'packages/core/src/runtime/openapi.ts',
    authorityKind: 'write-capable-legacy',
    writesExternally: true,
    canonicalReplacement: 'ActionGatewayClient',
    disposition: 'migrate-and-delete',
  },
  {
    path: 'packages/core/src/runtime/runtimeFactory.ts',
    authorityKind: 'write-capable-legacy',
    writesExternally: true,
    canonicalReplacement: 'worker-plane runtime factory',
    disposition: 'migrate-and-delete',
  },
  // Read-only legacy
  {
    path: 'apps/web/src/hooks/useWarRoom.ts',
    authorityKind: 'read-only-legacy',
    writesExternally: false,
    canonicalReplacement: 'kernel read projections',
    disposition: 'migrate-to-readonly',
  },
];

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (!SKIP_DIRS.has(entry)) yield* walk(full);
    } else {
      const extIdx = entry.lastIndexOf('.');
      const ext = extIdx > 0 ? entry.slice(extIdx) : '';
      if (SRC_EXTENSIONS.has(ext)) {
        yield full;
      }
    }
  }
}

function isTestFile(relPath: string): boolean {
  return relPath.includes('.test.') || relPath.includes('.spec.') || relPath.includes('/tests/') || relPath.includes('/__tests__/');
}

function findSourceFiles(): string[] {
  const files: string[] = [];
  for (const dir of ['apps', 'packages']) {
    const dirPath = join(ROOT, dir);
    try {
      for (const f of walk(dirPath)) {
        const rel = relative(ROOT, f).replace(/\\/g, '/');
        if (!isTestFile(rel)) files.push(rel);
      }
    } catch {
      // directory may not exist
    }
  }
  return files.sort();
}

export function readSource(relPath: string): string {
  return readFileSync(join(ROOT, relPath), 'utf-8');
}

export function scanFile(relPath: string): { writes: string[]; reads: string[] } {
  const content = readSource(relPath);
  const writes: string[] = [];
  const reads: string[] = [];
  for (const { regex, label } of WRITE_PATTERNS) {
    if (regex.test(content)) writes.push(label);
  }
  for (const { regex, label } of READ_PATTERNS) {
    if (regex.test(content)) reads.push(label);
  }
  return { writes, reads };
}

function classifyByPath(relPath: string): ClassificationRule | null {
  const hardcoded = HARDCODED_RULES.find((r) => r.path === relPath);
  if (hardcoded) return hardcoded;
  if (relPath.startsWith('packages/kernel/src/') || relPath.startsWith('packages/worker-plane/src/')) {
    return {
      path: relPath,
      authorityKind: 'canonical',
      writesExternally: false,
      canonicalReplacement: null,
      disposition: 'retain',
    };
  }
  return null;
}

function buildImportGraph(files: string[]): Map<string, string[]> {
  const graph = new Map<string, string[]>();
  for (const f of files) {
    graph.set(f, []);
  }
  for (const f of files) {
    const content = readSource(f);
    const importRe = /\bfrom\s+['"]([^'"]+)['"]|\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
    let m: RegExpExecArray | null;
    while ((m = importRe.exec(content)) !== null) {
      const target = m[1] ?? m[2];
      if (!target || !target.startsWith('.') || target.endsWith('.json')) continue;
      const fromDir = dirname(join(ROOT, f));
      const candidateBase = join(fromDir, target);
      for (const ext of ['.ts', '.tsx', '/index.ts', '/index.tsx']) {
        const candidate = `${candidateBase}${ext}`;
        const relCandidate = relative(ROOT, candidate).replace(/\\/g, '/');
        if (graph.has(relCandidate)) {
          graph.get(relCandidate)!.push(f);
          break;
        }
      }
    }
  }
  for (const [target, callers] of graph) {
    graph.set(
      target,
      [...new Set(callers)].sort(),
    );
  }
  return graph;
}

export function buildInventory(): InventoryResult {
  const files = findSourceFiles();
  const graph = buildImportGraph(files);
  const entries: InventoryEntry[] = [];
  const knownPaths = new Set(HARDCODED_RULES.map((r) => r.path));

  for (const relPath of files) {
    const rule = classifyByPath(relPath);
    if (rule) {
      entries.push({
        path: relPath,
        authorityKind: rule.authorityKind,
        callers: graph.get(relPath) ?? [],
        writesExternally: rule.writesExternally,
        canonicalReplacement: rule.canonicalReplacement,
        disposition: rule.disposition,
      });
      continue;
    }

    const { writes, reads } = scanFile(relPath);
    if (writes.length > 0) {
      entries.push({
        path: relPath,
        authorityKind: 'write-capable-legacy',
        callers: graph.get(relPath) ?? [],
        writesExternally: true,
        canonicalReplacement: 'unknown — requires canonical replacement',
        disposition: 'migrate-and-delete',
      });
    } else if (reads.length > 0) {
      entries.push({
        path: relPath,
        authorityKind: 'read-only-legacy',
        callers: graph.get(relPath) ?? [],
        writesExternally: false,
        canonicalReplacement: null,
        disposition: 'migrate-to-readonly',
      });
    }
  }

  // Ensure known rules that do not have a source file (e.g. deleted) are still represented.
  const existingPaths = new Set(entries.map((e) => e.path));
  for (const rule of HARDCODED_RULES) {
    if (!existingPaths.has(rule.path)) {
      entries.push({
        path: rule.path,
        authorityKind: rule.authorityKind,
        callers: [],
        writesExternally: rule.writesExternally,
        canonicalReplacement: rule.canonicalReplacement,
        disposition: rule.disposition,
      });
    }
  }

  const sortedEntries = entries.sort((a, b) => a.path.localeCompare(b.path));

  // Compare against fixture
  let fixture: InventoryEntry[] = [];
  try {
    const fixturePath = join(ROOT, 'scripts', 'fixtures', 'legacy-authorities.json');
    fixture = JSON.parse(readFileSync(fixturePath, 'utf-8')) as InventoryEntry[];
  } catch {
    // fixture missing; treat as empty
  }
  const fixtureWritePaths = new Set(
    fixture.filter((e) => e.authorityKind === 'write-capable-legacy').map((e) => e.path),
  );
  const newWriteAuthorities = sortedEntries.filter(
    (e) => e.authorityKind === 'write-capable-legacy' && !fixtureWritePaths.has(e.path),
  );

  return {
    entries: sortedEntries,
    newWriteAuthorities,
    passed: newWriteAuthorities.length === 0,
  };
}

function formatJson(result: InventoryResult): string {
  return JSON.stringify(
    {
      passed: result.passed,
      newWriteAuthorities: result.newWriteAuthorities.map((e) => e.path),
      entries: result.entries,
    },
    null,
    2,
  );
}

function formatText(result: InventoryResult): string {
  const lines: string[] = [];
  lines.push(`Legacy Authority Inventory — ${result.passed ? 'PASS' : 'FAIL'}`);
  lines.push(`Entries: ${result.entries.length}`);
  if (result.newWriteAuthorities.length > 0) {
    lines.push(`\nNew write-capable legacy authorities (gate failure):`);
    for (const e of result.newWriteAuthorities) {
      lines.push(`  - ${e.path}`);
    }
  }
  for (const kind of ['canonical', 'temporary-gate', 'write-capable-legacy', 'read-only-legacy'] as AuthorityKind[]) {
    const subset = result.entries.filter((e) => e.authorityKind === kind);
    if (subset.length === 0) continue;
    lines.push(`\n[${kind}]`);
    for (const e of subset) {
      lines.push(`  ${e.path}`);
      if (e.canonicalReplacement) {
        lines.push(`    → ${e.canonicalReplacement}`);
      }
    }
  }
  return lines.join('\n');
}

function main(): void {
  const args = process.argv.slice(2);
  const result = buildInventory();
  const formatIdx = args.indexOf('--format');
  const formatValue = formatIdx >= 0 ? args[formatIdx + 1] : undefined;
  if (formatValue === 'json') {
    console.log(formatJson(result));
  } else if (formatIdx >= 0 && formatValue !== 'text') {
    process.stderr.write(`Unknown format: ${formatValue ?? '(none)'}. Use 'json' or 'text'.\n`);
    process.exit(2);
  } else {
    console.log(formatText(result));
  }
  if (!result.passed) {
    process.stderr.write('Gate failed: new write-capable legacy authorities detected.\n');
    process.exit(1);
  }
}

// Guard so the CLI only runs when this file is the entry point. The check is
// intentionally simple: it matches the file basename under tsx, which is the
// supported runtime for this script.
const isMain = (process.argv[1] ?? '').split(/[\\/]/).pop() === 'legacy-authority-inventory.ts';
if (isMain) {
  main();
}
