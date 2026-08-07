#!/usr/bin/env node
/**
 * Architecture V2 gate.
 *
 * Enforces package boundaries and versioning rules from docs/architecture/ ADRs.
 *
 * Run: npx tsx scripts/architecture-gate.ts
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { authoritySignals } from './legacy-authority-inventory';

interface GateConfig {
  v2Packages: string[];
  forbiddenCoreImports: string[];
  v2ImportExceptions: string[];
  api: {
    path: string;
    legacyImportExceptions: string[];
    unversionedRouteExceptions: string[];
  };
  authorityExceptions: string[];
}

const ROOT = process.cwd();
const CONFIG_PATH = join(ROOT, 'scripts', 'architecture-gate.config.json');
const config: GateConfig = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));

const failures: string[] = [];

const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.turbo', 'coverage']);

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const st = statSync(path);
    if (st.isDirectory()) {
      if (!SKIP_DIRS.has(entry)) yield* walk(path);
    } else if (path.endsWith('.ts')) yield path;
  }
}

function checkFile(path: string, forbiddenImports: string[]): string[] {
  const content = readFileSync(path, 'utf-8');
  const found: string[] = [];
  for (const imp of forbiddenImports) {
    const pattern = new RegExp(`\\bfrom\\s+['"]${imp.replace(/\//g, '\\/')}['"]`, 'g');
    if (pattern.test(content)) found.push(imp);
  }
  return found;
}

// Legacy execution is quarantined during the strangler migration. Every file
// that can construct or expose the old AgentRuntime must pass through the
// single guard; otherwise a new route can silently recreate a second
// execution authority.
const legacyExecutionFiles = [
  'apps/api/src/orchestratorEndpoints.ts',
  'apps/api/src/pipelineEndpoints.ts',
];
for (const relativePath of legacyExecutionFiles) {
  const path = join(ROOT, relativePath);
  try {
    const content = readFileSync(path, 'utf-8');
    if (!content.includes('legacyExecutionGuard')) {
      failures.push(`${relativePath} is a legacy execution boundary without legacyExecutionGuard`);
    }
  } catch {
    // A deleted legacy file is acceptable; the route registry must be updated
    // separately if a replacement is introduced.
  }
}

// 1. V2 packages must not import @commander/core at all.
for (const pkg of config.v2Packages) {
  const pkgDir = join(ROOT, pkg, 'src');
  try {
    for (const file of walk(pkgDir)) {
      const rel = relative(ROOT, file).replace(/\\/g, '/');
      if (config.v2ImportExceptions.some((ex) => rel === ex || rel.endsWith(`/${ex}`))) continue;
      const bad = checkFile(file, config.forbiddenCoreImports);
      if (bad.length > 0) {
        failures.push(`${rel} imports forbidden @commander/core modules: ${bad.join(', ')}`);
      }
    }
  } catch {
    // package may not have src yet
  }
}

// 2. apps/api legacy files are exempt, but new files must not import core execution/runtime modules.
const apiDir = join(ROOT, config.api.path);
for (const file of walk(apiDir)) {
  const base = relative(apiDir, file).replace(/\\/g, '/');
  const content = readFileSync(file, 'utf-8');
  const runtimeSignals = authoritySignals(`apps/api/src/${base}`, content).writes;
  if (runtimeSignals.includes('construct:AgentRuntime')) {
    failures.push(`apps/api source ${base} constructs forbidden in-process AgentRuntime`);
  }
  if (config.api.legacyImportExceptions.includes(base)) continue;
  const bad = checkFile(file, config.forbiddenCoreImports);
  if (bad.length > 0) {
    failures.push(
      `apps/api new file ${base} imports forbidden @commander/core modules: ${bad.join(', ')}`,
    );
  }
}

// 3. Public API routes must be versioned (/v1/* or /v2/*), except legacy exemptions.
for (const file of walk(apiDir)) {
  const base = relative(apiDir, file).replace(/\\/g, '/');
  if (!base.endsWith('.ts')) continue;
  if (base.includes('/') || base.startsWith('v1')) continue;
  if (config.api.unversionedRouteExceptions.includes(base)) continue;
  const content = readFileSync(file, 'utf-8');
  if (!/\b(?:router|app)\s*\.\s*(?:get|post|put|patch|delete|use|all)\s*\(/.test(content)) {
    continue;
  }
  failures.push(`apps/api public route file ${base} is not versioned under /v1/*`);
}

// 4. New code must not use in-process Map/SQLite as production authority.
function hasInProcessAuthorityMap(path: string, content: string): boolean {
  if (/^\/\*\* Ephemeral[\s\S]*durable[\s\S]*belongs to the kernel/i.test(content)) return false;
  const source = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true);
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'Map'
    ) {
      let parent: ts.Node | undefined = node.parent;
      while (parent) {
        if (ts.isFunctionLike(parent)) return;
        if (ts.isClassLike(parent)) {
          if (parent.name?.text.startsWith('InMemory')) return;
          break;
        }
        parent = parent.parent;
      }
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

for (const pkg of [...config.v2Packages, 'apps/api']) {
  const dir = join(ROOT, pkg);
  try {
    for (const file of walk(dir)) {
      const rel = relative(ROOT, file).replace(/\\/g, '/');
      if (rel.includes('.test.') || rel.includes('/testing/')) continue;
      if (config.authorityExceptions.some((ex) => rel === ex || rel.endsWith(`/${ex}`))) continue;
      const apiBase = rel.startsWith('apps/api/src/') ? rel.slice('apps/api/src/'.length) : null;
      const isExistingMigrationException =
        (apiBase !== null && config.api.legacyImportExceptions.includes(apiBase)) ||
        config.v2ImportExceptions.some((ex) => rel === ex || rel.endsWith(`/${ex}`));
      if (isExistingMigrationException) continue;
      const content = readFileSync(file, 'utf-8');
      if (hasInProcessAuthorityMap(rel, content)) {
        failures.push(`${rel} appears to use in-process Map as authority`);
      }
      if (/better-sqlite3(?!\s*test)/.test(content)) {
        failures.push(`${rel} appears to use better-sqlite3 dependency in production package`);
      }
    }
  } catch {
    // skip
  }
}

if (failures.length > 0) {
  console.error('Architecture V2 gate failed:');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

console.log('Architecture V2 gate passed.');
