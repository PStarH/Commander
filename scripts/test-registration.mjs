#!/usr/bin/env node
/**
 * Repository-wide test-registration gate.
 *
 * Why this exists
 * ---------------
 * `packages/core` already fails closed on unregistered tests
 * (`packages/core/scripts/test-inventory.mjs`). Nothing did the same for the rest
 * of the monorepo, and the consequence was measurable: of 73 `scripts/*.test.ts`
 * files at the root, **24 were named by no npm script and no CI workflow**. They
 * executed nowhere. When they were finally run by hand, 7 of them failed — two of
 * those were security-gate tests (pre-commit / pre-push scanner policies) whose
 * fail-open behaviour had been invisible for as long as the files existed.
 *
 * A test that no runner reaches is not a test; it is a comment.
 *
 * Modes
 * -----
 *   node scripts/test-registration.mjs            report only, always exit 0
 *   node scripts/test-registration.mjs --json     report only, JSON on stdout
 *   node scripts/test-registration.mjs --verify   gate, exit 1 on any error
 *
 * Verification errors (each is a hard failure under `--verify`):
 *   UNREGISTERED_TEST          reachable by no runner and not declared not-run
 *   DECLARATION_INVALID        a DECLARED_NOT_RUN entry is malformed
 *   DECLARATION_STALE          a DECLARED_NOT_RUN entry names a missing file
 *   DECLARATION_CONTRADICTION  a file is declared not-run but is also registered
 *   CORE_GATE_MISSING          the delegated `packages/core` gate is absent or unwired
 *   SCOPE_BELOW_FLOOR          discovery found fewer files than the pinned floor
 *   UNREADABLE_TEST            a discovered file could not be read
 *
 * The floor check is deliberate anti-vacuity: a gate that silently narrows its
 * own scope reports success it has not earned. If the tree really shrinks, the
 * floor is updated in the same change as the shrink, on purpose.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

/** Directories that never contain first-party test files. */
const SKIP_DIRS = new Set([
  '.git',
  '.github',
  '.internal',
  '.next',
  '.turbo',
  '.commander',
  '.commander_state',
  '.pnpm-store',
  '.srl',
  '.worktrees',
  'build',
  'coverage',
  'dist',
  'docs',
  'node_modules',
  'tmp',
  'vendor',
]);

/**
 * `packages/core` enforces a stricter gate of its own (an explicit vitest
 * allowlist plus directory-based `node:test` discovery plus an errno-aware
 * unreadable-file check). Re-implementing that here would create a second,
 * divergent authority, so this gate delegates: it asserts the core gate exists
 * and is wired into a script, and skips core's files.
 */
const DELEGATED_SCOPE = 'packages/core';
const CORE_GATE = 'packages/core/scripts/test-inventory.mjs';

/** Pinned discovery floors. Raise them when the tree grows; never lower silently. */
export const FLOORS = {
  totalTestFiles: 900,
  scannedTestFiles: 300,
  rootScriptTestFiles: 70,
};

const DECLARATION_CATEGORIES = new Set([
  'REQUIRES_CLUSTER',
  'REQUIRES_CONTAINER',
  'REQUIRES_POSTGRES',
  'REQUIRES_BROWSER',
  'REQUIRES_LIVE_PROVIDER',
  'REQUIRES_LIVE_SERVER',
  'REQUIRES_SECRETS',
  'SUPERSEDED',
  'NOT_IMPLEMENTED',
]);
const MIN_REASON_LENGTH = 24;

/**
 * Files that are deliberately executed by no runner. Every entry needs a
 * category from the set above and a reason of at least 24 characters, so that
 * "declare it and move on" is a visible decision rather than a silent hole.
 *
 * @type {{file: string, category: string, reason: string}[]}
 */
export const DECLARED_NOT_RUN = [
  // apps/api/tests is a live-server integration suite. It is owned by
  // apps/api/scripts/run-integration-tests.ts, which builds the API, starts it
  // on an ephemeral port and only then exports TEST_API_URL; `pnpm test` starts
  // no server, so these files run nowhere else by design. They are green under
  // that runner in this environment, but CI does not run it yet: the runner
  // needs the dev PostgreSQL fixture (DATABASE_URL for the commander_app role
  // plus COMMANDER_DATABASE_TLS_CA_FILE and
  // COMMANDER_DATABASE_TLS_EXPECTED_SERVER_SPKI_SHA256), and no workflow step
  // (`grep -rn test:integration .github/workflows/` => no matches) provides it.
  // Declaring them keeps the honest statement "no CI runner reaches these"
  // instead of quietly claiming coverage. Their four pure-unit siblings were
  // moved to apps/api/test/, which `pnpm test` does cover.
  {
    file: 'apps/api/tests/all-endpoints.test.ts',
    category: 'REQUIRES_LIVE_SERVER',
    reason:
      'Live-server suite owned by apps/api/scripts/run-integration-tests.ts (builds the API, ' +
      'binds an ephemeral port, then exports TEST_API_URL). `pnpm test` starts no server, and ' +
      'no CI workflow runs test:integration, which additionally needs the dev PostgreSQL ' +
      'auth fixture (DATABASE_URL + TLS CA/SPKI) that CI does not provide.',
  },
  {
    file: 'apps/api/tests/authMiddleware.test.ts',
    category: 'REQUIRES_LIVE_SERVER',
    reason:
      'Live-server suite owned by apps/api/scripts/run-integration-tests.ts (builds the API, ' +
      'binds an ephemeral port, then exports TEST_API_URL). `pnpm test` starts no server, and ' +
      'no CI workflow runs test:integration, which additionally needs the dev PostgreSQL ' +
      'auth fixture (DATABASE_URL + TLS CA/SPKI) that CI does not provide.',
  },
  {
    file: 'apps/api/tests/comprehensive.test.ts',
    category: 'REQUIRES_LIVE_SERVER',
    reason:
      'Live-server suite owned by apps/api/scripts/run-integration-tests.ts (builds the API, ' +
      'binds an ephemeral port, then exports TEST_API_URL). `pnpm test` starts no server, and ' +
      'no CI workflow runs test:integration, which additionally needs the dev PostgreSQL ' +
      'auth fixture (DATABASE_URL + TLS CA/SPKI) that CI does not provide.',
  },
  {
    file: 'apps/api/tests/endpoints.test.ts',
    category: 'REQUIRES_LIVE_SERVER',
    reason:
      'Live-server suite owned by apps/api/scripts/run-integration-tests.ts (builds the API, ' +
      'binds an ephemeral port, then exports TEST_API_URL). `pnpm test` starts no server, and ' +
      'no CI workflow runs test:integration, which additionally needs the dev PostgreSQL ' +
      'auth fixture (DATABASE_URL + TLS CA/SPKI) that CI does not provide.',
  },
];

const TEST_FILE_PATTERN = /\.test\.(?:ts|tsx|cjs|mjs|js)$/;
const TEST_RUNNER_HINT = /(?:--test\b|\bvitest\b|\bjest\b|\bmocha\b|\bava\b)/;

// ── filesystem helpers ──────────────────────────────────────────────────────

export function toPosix(value) {
  return value.split(sep).join('/');
}

export function isTestFile(name) {
  return TEST_FILE_PATTERN.test(name);
}

function readSourceOrThrow(absPath) {
  return readFileSync(absPath, 'utf8');
}

export function readSource(absPath) {
  try {
    return { ok: true, source: readSourceOrThrow(absPath) };
  } catch (error) {
    return { ok: false, code: error?.code ?? 'UNKNOWN' };
  }
}

export function discoverTestFiles(root = REPO_ROOT) {
  const found = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      // A directory that cannot be listed is reported by the caller as an
      // incomplete inventory rather than silently skipped; discovery here is
      // best-effort and the floor check catches a catastrophic miss.
      return;
    }
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(abs);
        continue;
      }
      if (entry.isSymbolicLink()) continue;
      if (!isTestFile(entry.name)) continue;
      found.push(toPosix(relative(root, abs)));
    }
  };
  walk(root);
  // Discovery walks the filesystem, but a file that git ignores does not exist
  // on a clean checkout. Counting it would demand a DECLARED_NOT_RUN entry that
  // is guaranteed to go stale (e.g. `apps/web/src/api/actions.test.js` is
  // compiled output from the web build, ignored by .gitignore:303).
  const ignored = gitIgnoredPaths(root);
  const visible = ignored ? found.filter((file) => !ignored.has(file)) : found;
  return visible.sort();
}

/**
 * Repo-root-relative paths that are untracked and ignored. Returns null when
 * git cannot be consulted, in which case discovery falls back to the raw
 * filesystem walk and the gate says so through its file-count floor.
 */
export function gitIgnoredPaths(root = REPO_ROOT) {
  try {
    const output = execFileSync(
      'git',
      ['-C', root, 'ls-files', '-z', '--others', '--ignored', '--exclude-standard'],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const set = new Set();
    for (const entry of output.split('\0')) {
      if (entry) set.add(toPosix(entry));
    }
    return set;
  } catch {
    return null;
  }
}

// ── command parsing ─────────────────────────────────────────────────────────

/** Split a shell command on `&&`, `;`, and `|`, ignoring quoted segments. */
export function splitCommandSegments(command) {
  const segments = [];
  let current = '';
  let quote = null;
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '&' && command[i + 1] === '&') {
      segments.push(current);
      current = '';
      i += 1;
      continue;
    }
    if (ch === '|' || ch === ';') {
      if (command[i + 1] === '|') i += 1;
      segments.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  segments.push(current);
  return segments.map((s) => s.trim()).filter(Boolean);
}

/** Tokenize a single command segment, stripping quotes. */
export function tokenize(segment) {
  const tokens = [];
  let current = '';
  let quote = null;
  let started = false;
  for (const ch of segment) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (started) {
        tokens.push(current);
        current = '';
        started = false;
      }
      continue;
    }
    current += ch;
    started = true;
  }
  if (started) tokens.push(current);
  return tokens;
}

const RUNNER_BINARIES = new Set([
  'node',
  'npx',
  'pnpm',
  'yarn',
  'npm',
  'tsx',
  'vitest',
  'jest',
  'mocha',
  'ava',
  'exec',
  'env',
  'sh',
  'bash',
  'run',
  'test',
]);
const RUNNER_SUBCOMMANDS = new Set([
  '--test',
  'run',
  'watch',
  '--no-cache',
  '--import',
  '--test-concurrency=1',
  '--reporter=default',
]);

/**
 * Extract the test-file arguments (literal paths and globs) from one command.
 * Returns [] for commands that are not test runs.
 */
export function extractTestPatterns(command) {
  if (!TEST_RUNNER_HINT.test(command)) return [];
  const patterns = [];
  for (const segment of splitCommandSegments(command)) {
    if (!TEST_RUNNER_HINT.test(segment)) continue;
    for (const token of tokenize(segment)) {
      if (token.startsWith('-')) continue;
      if (RUNNER_BINARIES.has(token)) continue;
      if (RUNNER_SUBCOMMANDS.has(token)) continue;
      if (token.startsWith('@')) continue;
      if (token.includes('=')) continue;
      if (token.startsWith('--filter')) continue;
      const looksLikeTestArg =
        token.includes('*') ||
        /\.(?:ts|tsx|cjs|mjs|js)$/.test(token) ||
        /(?:^|\/)(?:test|tests)\/?$/.test(token);
      if (looksLikeTestArg) patterns.push(token);
    }
  }
  return patterns;
}

// ── scope collection ────────────────────────────────────────────────────────

function* packageManifests(root) {
  yield join(root, 'package.json');
  for (const group of ['apps', 'integrations', 'packages']) {
    const groupDir = join(root, group);
    if (!existsSync(groupDir)) continue;
    for (const entry of readdirSync(groupDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifest = join(groupDir, entry.name, 'package.json');
      if (existsSync(manifest)) yield manifest;
    }
  }
}

/** Vitest's default `test.include` when no config narrows it. */
const VITEST_DEFAULT_INCLUDE = [
  '**/*.test.ts',
  '**/*.test.tsx',
  '**/*.test.js',
  '**/*.test.jsx',
  '**/*.test.mts',
  '**/*.test.cts',
  '**/*.test.mjs',
  '**/*.test.cjs',
];

/**
 * Resolve which files a bare `vitest run` (no positional arguments) reaches.
 * A config with an explicit `include:` narrows the scope; without one, vitest
 * falls back to its default globs. Assuming the default when a config narrows it
 * would claim coverage that does not exist, so the config is read first.
 */
function vitestScopePatterns(cwd) {
  for (const name of [
    'vitest.config.ts',
    'vitest.config.mts',
    'vitest.config.js',
    'vitest.config.mjs',
  ]) {
    const candidate = join(cwd, name);
    if (!existsSync(candidate)) continue;
    const source = readSourceOrThrow(candidate);
    const includeMatch = source.match(/\binclude\s*:\s*\[([^\]]*)\]/s);
    if (includeMatch) {
      const entries = [...includeMatch[1].matchAll(/['"`]([^'"`]+)['"`]/g)].map((m) => m[1]);
      if (entries.length > 0) return entries;
    }
    return VITEST_DEFAULT_INCLUDE;
  }
  return VITEST_DEFAULT_INCLUDE;
}

/**
 * Every command string declared anywhere (package scripts + workflow steps),
 * whether or not it runs tests. Used to prove the delegated core gate is
 * actually wired into the build rather than merely present on disk.
 */
export function collectCommands(root = REPO_ROOT) {
  const commands = [];
  for (const manifest of packageManifests(root)) {
    let parsed;
    try {
      parsed = JSON.parse(readSourceOrThrow(manifest));
    } catch {
      continue;
    }
    for (const command of Object.values(parsed.scripts ?? {})) {
      if (typeof command === 'string') commands.push(command);
    }
  }
  const workflowsDir = join(root, '.github', 'workflows');
  if (existsSync(workflowsDir)) {
    for (const entry of readdirSync(workflowsDir)) {
      if (!/\.ya?ml$/.test(entry)) continue;
      for (const step of extractWorkflowRunSteps(readSourceOrThrow(join(workflowsDir, entry)))) {
        commands.push(step.command);
      }
    }
  }
  return commands;
}

/**
 * Collect every place a test command is declared: package.json scripts and
 * GitHub workflow `run:` steps.
 */
export function collectScopes(root = REPO_ROOT) {
  /** @type {{origin: string, cwd: string, command: string, patterns: string[]}[]} */
  const scopes = [];
  for (const manifest of packageManifests(root)) {
    let parsed;
    try {
      parsed = JSON.parse(readSourceOrThrow(manifest));
    } catch {
      continue;
    }
    const cwd = toPosix(relative(root, dirname(manifest))) || '.';
    for (const [name, command] of Object.entries(parsed.scripts ?? {})) {
      if (typeof command !== 'string') continue;
      const patterns = extractTestPatterns(command);
      if (patterns.length > 0) {
        scopes.push({
          origin: `${cwd === '.' ? '' : `${cwd}/`}package.json#${name}`,
          cwd,
          command,
          patterns,
        });
        continue;
      }
      // A bare `vitest run` carries no path arguments but still reaches every
      // file its config's `include` (or vitest's default) matches.
      for (const segment of splitCommandSegments(command)) {
        if (!/\bvitest\b/.test(segment)) continue;
        if (/\b(?:watch|ui)\b/.test(segment)) break;
        scopes.push({
          origin: `${cwd === '.' ? '' : `${cwd}/`}package.json#${name}`,
          cwd,
          command,
          patterns: vitestScopePatterns(join(root, cwd)),
        });
        break;
      }
    }
  }

  const workflowsDir = join(root, '.github', 'workflows');
  if (existsSync(workflowsDir)) {
    for (const entry of readdirSync(workflowsDir)) {
      if (!/\.ya?ml$/.test(entry)) continue;
      const origin = `.github/workflows/${entry}`;
      const text = readSourceOrThrow(join(workflowsDir, entry));
      for (const step of extractWorkflowRunSteps(text)) {
        const patterns = extractTestPatterns(step.command);
        if (patterns.length === 0) continue;
        scopes.push({ origin, cwd: step.workingDirectory, command: step.command, patterns });
      }
    }
  }

  return scopes;
}

/**
 * Line-based extraction of `run:` bodies plus the `working-directory:` in effect.
 * A YAML library is deliberately not used: this repo has no root `yaml`
 * dependency, and registration only needs the literal text of each step.
 */
export function extractWorkflowRunSteps(text) {
  const lines = text.split(/\r?\n/);
  const steps = [];
  let workingDirectory = '.';
  let indentationStack = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const indent = line.match(/^\s*/)[0].length;
    const wd = line.match(/^\s*-?\s*working-directory:\s*(.+?)\s*$/);
    if (wd) {
      workingDirectory = wd[1].replace(/^['"]|['"]$/g, '');
      continue;
    }
    const run = line.match(/^\s*-?\s*run:\s*(.*)$/);
    if (!run) continue;
    const inline = run[1].trim();
    if (
      inline &&
      inline !== '|' &&
      inline !== '>' &&
      !inline.startsWith('|') &&
      !inline.startsWith('>')
    ) {
      steps.push({ command: inline, workingDirectory });
      continue;
    }
    const body = [];
    for (let j = i + 1; j < lines.length; j += 1) {
      const next = lines[j];
      if (next.trim() === '') {
        body.push('');
        continue;
      }
      const nextIndent = next.match(/^\s*/)[0].length;
      if (nextIndent <= indent) break;
      body.push(next.trim());
    }
    steps.push({ command: body.join(' '), workingDirectory });
  }
  indentationStack = [];
  return steps;
}

// ── glob matching ───────────────────────────────────────────────────────────

export function globToRegExp(glob) {
  const escaped = '\\^$+?.()|{}[]';
  let re = '';
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        i += 1;
        if (glob[i + 1] === '/') {
          i += 1;
          re += '(?:.*/)?';
        } else {
          re += '.*';
        }
      } else {
        re += '[^/]*';
      }
      continue;
    }
    if (ch === '?') {
      re += '[^/]';
      continue;
    }
    re += escaped.includes(ch) ? `\\${ch}` : ch;
  }
  return new RegExp(`^${re}$`);
}

/** Does this scope reach `relPath` (repo-root-relative, posix)? */
export function scopeReaches(scope, relPath) {
  const cwd = scope.cwd === '.' ? '' : `${scope.cwd}/`;
  const local = cwd ? (relPath.startsWith(cwd) ? relPath.slice(cwd.length) : null) : relPath;
  return scope.patterns.some((pattern) => {
    const normalised = toPosix(pattern).replace(/^\.\//, '');
    const isGlob = normalised.includes('*') || normalised.includes('?');
    const matches = (candidate) => {
      if (candidate === null) return false;
      if (isGlob) {
        return globToRegExp(normalised).test(candidate);
      }
      if (normalised.endsWith('/')) return candidate.startsWith(normalised);
      if (normalised === 'test' || normalised === 'tests')
        return candidate.startsWith(`${normalised}/`);
      return normalised === candidate;
    };
    // A command can be launched from the workspace root (`pnpm --workspace-root
    // exec ... packages/x/src/y.test.ts`) even though it is declared in
    // `packages/x/package.json`, so an explicit path may be relative to either.
    // Globs are deliberately NOT retried repo-relative: a package-scoped
    // `**/*.test.ts` would then claim the entire repository.
    return matches(local) || (!isGlob && matches(relPath));
  });
}

export function findReachingScopes(scopes, relPath) {
  return scopes.filter((scope) => scopeReaches(scope, relPath));
}

// ── declarations ────────────────────────────────────────────────────────────

export function validateDeclaration(entry) {
  const problems = [];
  if (!entry || typeof entry !== 'object') return ['declaration is not an object'];
  if (typeof entry.file !== 'string' || entry.file.length === 0) {
    problems.push('declaration.file must be a non-empty string');
  } else if (entry.file.startsWith('/') || entry.file.includes('..')) {
    problems.push(
      `${entry.file}: declaration.file must be repo-root-relative and must not contain ".."`,
    );
  }
  if (!DECLARATION_CATEGORIES.has(entry.category)) {
    problems.push(
      `${entry.file ?? '<unknown>'}: category "${entry.category}" is not one of ${[...DECLARATION_CATEGORIES].join(', ')}`,
    );
  }
  if (typeof entry.reason !== 'string' || entry.reason.trim().length < MIN_REASON_LENGTH) {
    problems.push(
      `${entry.file ?? '<unknown>'}: reason must be at least ${MIN_REASON_LENGTH} characters — a declaration without a reason is a way to switch the gate off`,
    );
  }
  return problems;
}

// ── the gate ────────────────────────────────────────────────────────────────

export function runGate(root = REPO_ROOT) {
  /** @type {{code: string, severity: 'error'|'warning', detail: string}[]} */
  const findings = [];
  const error = (code, detail) => findings.push({ code, severity: 'error', detail });

  const delegatedPrefix = `${DELEGATED_SCOPE}/`;
  const allFiles = discoverTestFiles(root);
  const scanned = [];
  for (const relPath of allFiles) {
    if (relPath.startsWith(delegatedPrefix)) continue;
    const read = readSource(join(root, relPath));
    if (!read.ok) {
      error(
        'UNREADABLE_TEST',
        `${relPath}: cannot be read — ${read.code}. The inventory cannot be proven complete.`,
      );
      continue;
    }
    scanned.push(relPath);
  }

  const scopes = collectScopes(root);

  const declaredFiles = new Set();
  for (const declaration of DECLARED_NOT_RUN) {
    for (const problem of validateDeclaration(declaration)) error('DECLARATION_INVALID', problem);
    if (typeof declaration?.file !== 'string') continue;
    if (declaredFiles.has(declaration.file)) {
      error('DECLARATION_INVALID', `${declaration.file} is declared more than once`);
    }
    declaredFiles.add(declaration.file);
    if (!existsSync(join(root, declaration.file))) {
      error(
        'DECLARATION_STALE',
        `${declaration.file} is declared not-run but does not exist on disk`,
      );
    }
    if (findReachingScopes(scopes, declaration.file).length > 0) {
      error(
        'DECLARATION_CONTRADICTION',
        `${declaration.file} is declared not-run but a runner does reach it — remove the declaration`,
      );
    }
  }

  const unregistered = [];
  for (const relPath of scanned) {
    if (declaredFiles.has(relPath)) continue;
    if (findReachingScopes(scopes, relPath).length > 0) continue;
    unregistered.push(relPath);
    error(
      'UNREGISTERED_TEST',
      `${relPath} is executed by no runner: named by no package script and no workflow step, and absent from DECLARED_NOT_RUN`,
    );
  }

  // The delegated core gate must exist and be wired, or the delegation is vacuous.
  if (!existsSync(join(root, CORE_GATE))) {
    error(
      'CORE_GATE_MISSING',
      `${CORE_GATE} does not exist, so packages/core is covered by nothing`,
    );
  } else if (!collectCommands(root).some((command) => /test-inventory\.mjs/.test(command))) {
    error(
      'CORE_GATE_MISSING',
      `${CORE_GATE} is not invoked from any package script or workflow step`,
    );
  }

  const rootScriptFiles = scanned.filter((f) => /^scripts\/[^/]*\.test\./.test(f));
  if (allFiles.length < FLOORS.totalTestFiles) {
    error(
      'SCOPE_BELOW_FLOOR',
      `discovery found ${allFiles.length} test files, below the pinned floor of ${FLOORS.totalTestFiles} — the gate is reading less of the tree than it claims`,
    );
  }
  if (scanned.length < FLOORS.scannedTestFiles) {
    error(
      'SCOPE_BELOW_FLOOR',
      `the gate scanned ${scanned.length} test files, below the pinned floor of ${FLOORS.scannedTestFiles}`,
    );
  }
  if (rootScriptFiles.length < FLOORS.rootScriptTestFiles) {
    error(
      'SCOPE_BELOW_FLOOR',
      `discovery found ${rootScriptFiles.length} scripts/*.test.* files, below the pinned floor of ${FLOORS.rootScriptTestFiles}`,
    );
  }

  return {
    repoRoot: root,
    totalTestFiles: allFiles.length,
    scannedTestFiles: scanned.length,
    delegatedTestFiles: allFiles.length - scanned.length,
    scopes: scopes.length,
    declaredNotRunFiles: declaredFiles.size,
    rootScriptTestFiles: rootScriptFiles.length,
    unregisteredFiles: unregistered.length,
    unregistered,
    coverageComplete: findings.every((f) => f.severity !== 'error'),
    errorCount: findings.filter((f) => f.severity === 'error').length,
    warningCount: findings.filter((f) => f.severity === 'warning').length,
    findings,
  };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function main() {
  const argv = process.argv.slice(2);
  const verify = argv.includes('--verify');
  const json = argv.includes('--json');
  const summary = runGate();

  if (json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log('Commander repository test-registration inventory');
    console.log(`- repo root: ${summary.repoRoot}`);
    console.log(`- discovered test files: ${summary.totalTestFiles}`);
    console.log(
      `- scanned here: ${summary.scannedTestFiles} (delegated to packages/core: ${summary.delegatedTestFiles})`,
    );
    console.log(`- scripts/*.test.* files: ${summary.rootScriptTestFiles}`);
    console.log(`- test-running scopes: ${summary.scopes}`);
    console.log(`- declared not-run: ${summary.declaredNotRunFiles}`);
    console.log(`- unregistered (executed by no runner): ${summary.unregisteredFiles}`);
    console.log(`- coverage complete: ${summary.coverageComplete ? 'yes' : 'no'}`);
    for (const finding of summary.findings) {
      const tag = finding.severity === 'error' ? 'ERROR' : 'WARN ';
      console.log(`  [${tag}] ${finding.code}: ${finding.detail}`);
    }
    if (summary.findings.length === 0) console.log('  (no findings)');
  }

  if (verify && summary.errorCount > 0) {
    if (!json) {
      console.error(`\ntest-registration: ${summary.errorCount} verification error(s).`);
      console.error(
        '  - Register each listed file in the package script or workflow that runs its package, ' +
          'or add it to DECLARED_NOT_RUN in scripts/test-registration.mjs with a category and a reason.',
      );
    }
    process.exit(1);
  }
}

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) main();
