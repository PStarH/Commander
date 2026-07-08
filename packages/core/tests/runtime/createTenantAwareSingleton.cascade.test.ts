/**
 * Regression gate for the `createTenantAwareSingleton` tenant-isolation contract.
 *
 * `tenantAwareSingleton.ts` now enforces the boundary itself:
 *   - In production (`NODE_ENV === 'production'`) a call to `.get()` outside an
 *     active tenant context throws `TenantIsolationError`.
 *   - In development/test an implicit `__default__` tenant is used so local and
 *     CI paths do not need to wrap every boot sequence in `runWithTenant()`.
 *
 * Because the runtime enforces the rule, production source files must NOT
 * carry `allowGlobalFallback: true` (or any `allowGlobalFallback` literal) at
 * `createTenantAwareSingleton` call sites. The option is reserved for targeted
 * test fixtures and for the type definition in `tenantAwareSingleton.ts`.
 *
 * This test scans `packages/core/src/**.ts` and fails if any production call
 * site still contains the opt-out flag.
 */
import { describe, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

function resolveSrcRoot(): string {
  const cwdCandidate = join(process.cwd(), 'src');
  if (existsMarker(cwdCandidate, 'runtime/tenantAwareSingleton.ts')) return cwdCandidate;

  let here: string;
  try {
    here = dirname(fileURLToPath(import.meta.url));
  } catch {
    here = process.cwd();
  }
  let cursor = here;
  for (let i = 0; i < 8 && cursor !== dirname(cursor); i++) {
    const candidate = join(cursor, 'src');
    if (existsMarker(candidate, 'runtime/tenantAwareSingleton.ts')) return candidate;
    cursor = dirname(cursor);
  }

  throw new Error(
    `cascade-scan: could not resolve SRC_ROOT. cwd=${process.cwd()}, ` +
      `here=${here}. Tried ${cwdCandidate} and walked ancestors of here. ` +
      `Ensure the test is invoked from the package root (\`pnpm -F core test\`) or ` +
      `that this file lives under <repo>/packages/core/tests/runtime/.`,
  );
}

function existsMarker(root: string, marker: string): boolean {
  try {
    statSync(join(root, marker));
    return true;
  } catch {
    return false;
  }
}

const SRC_ROOT = resolveSrcRoot();
const API_DEFINITION_REL = 'runtime/tenantAwareSingleton.ts';
const WINDOW_LINES = 15;
const FORBIDDEN_FLAG = 'allowGlobalFallback';
const CALL_PATTERN =
  /^\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*Singleton)\s*=\s*createTenantAwareSingleton\b/;
const MINIMUM_EXPECTED_SITES = 50;

interface SingletonSite {
  file: string;
  line: number;
  name: string;
  hasForbiddenFlag: boolean;
}

function* walkTypeScriptFiles(dir: string): Generator<string> {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const fullPath = join(dir, entry);
    let stats;
    try {
      stats = statSync(fullPath);
    } catch {
      continue;
    }
    if (stats.isDirectory()) {
      yield* walkTypeScriptFiles(fullPath);
    } else if (stats.isFile() && fullPath.endsWith('.ts')) {
      yield fullPath;
    }
  }
}

function toRelativePosix(absolutePath: string): string {
  return relative(SRC_ROOT, absolutePath).split(sep).join('/');
}

function scanFile(absolutePath: string): SingletonSite[] {
  const rel = toRelativePosix(absolutePath);
  if (rel === API_DEFINITION_REL) return [];

  let text: string;
  try {
    text = readFileSync(absolutePath, 'utf8');
  } catch {
    return [];
  }

  const lines = text.split('\n');
  const matches: SingletonSite[] = [];

  for (let i = 0; i < lines.length; i++) {
    const m = CALL_PATTERN.exec(lines[i]);
    if (!m) continue;

    const lo = Math.max(0, i - WINDOW_LINES);
    const hi = Math.min(lines.length - 1, i + WINDOW_LINES);
    let hasForbiddenFlag = false;
    for (let j = lo; j <= hi; j++) {
      if (lines[j].includes(FORBIDDEN_FLAG)) {
        hasForbiddenFlag = true;
        break;
      }
    }

    matches.push({
      file: rel,
      line: i + 1,
      name: m[1],
      hasForbiddenFlag,
    });
  }
  return matches;
}

function scanAllSources(): SingletonSite[] {
  const sites: SingletonSite[] = [];
  for (const f of walkTypeScriptFiles(SRC_ROOT)) {
    sites.push(...scanFile(f));
  }
  sites.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line));
  return sites;
}

describe('createTenantAwareSingleton cascade coverage', () => {
  it('no production call site carries allowGlobalFallback within ±15 lines', () => {
    const sites = scanAllSources();

    if (sites.length < MINIMUM_EXPECTED_SITES) {
      throw new Error(
        `Scanner found only ${sites.length} createTenantAwareSingleton sites ` +
          `(expected >= ${MINIMUM_EXPECTED_SITES}). Either the singleton wiring ` +
          `regressed or the scanner is broken. Inspect SRC_ROOT=${SRC_ROOT} and ` +
          `the CALL_PATTERN/WALK_TYPE_SCRIPT_FILES logic.`,
      );
    }

    const offending = sites.filter((s) => s.hasForbiddenFlag);
    if (offending.length > 0) {
      const MAX_LIST = 25;
      const formatted = offending
        .slice(0, MAX_LIST)
        .map((m) => `  - ${m.file}:${m.line}  (${m.name})`)
        .join('\n');
      const overflow =
        offending.length > MAX_LIST ? `\n  ... and ${offending.length - MAX_LIST} more` : '';
      throw new Error(
        `${offending.length}/${sites.length} createTenantAwareSingleton call sites ` +
          `still carry "${FORBIDDEN_FLAG}" within ±${WINDOW_LINES} lines. ` +
          `Production code must rely on the implicit default-tenant behaviour in ` +
          `development/test and the TenantIsolationError boundary in production. ` +
          `Remove the flag from these production call sites:\n${formatted}${overflow}`,
      );
    }
  });
});
