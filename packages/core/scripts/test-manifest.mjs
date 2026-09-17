/**
 * Single source of truth for `packages/core` test discovery.
 *
 * Why this file exists
 * --------------------
 * `packages/core` has two runners with two hand-maintained registration lists:
 *
 *   - vitest     -> the `include:` allowlist in `vitest.config.ts`
 *   - `node:test` -> every `*.test.ts` under `tests/` that does NOT import vitest
 *
 * The two lists can disagree, and the failure mode is silent: a file that
 * imports vitest but is absent from `include:` is executed by *neither* runner.
 * (It is also unreachable via an explicit CLI argument — vitest's `include:` is
 * a filter, not a default, so `vitest run tests/foo.test.ts` prints
 * "No test files found" and exits 1.)
 *
 * `DECLARED_NOT_RUN` closes that hole. Every `*.test.ts` file under the scanned
 * roots must be reachable by a runner *or* listed here with a category and a
 * reason. A file that is in neither place fails `test-inventory.mjs --verify`.
 * The list is machine-checked, so it cannot rot into a set of stale comments.
 *
 * Ownership note: several files below live in directories owned by other
 * workstreams, so the opt-out is declared centrally here rather than by adding
 * imports to those files.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

/** `packages/core` — resolved from this module, never from `process.cwd()`. */
export const CORE_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Roots scanned for test files, relative to `CORE_ROOT`. */
export const TEST_ROOTS = ['tests', 'src'];

/** Directories never scanned (build output, dependencies, caches). */
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'coverage',
  'build',
  '.git',
  '.commander_benchmarks',
  '.vitest',
  '__snapshots__',
]);

/** Extensions the runners can actually execute as a test entry point. */
export const TEST_FILE_PATTERN = /\.test\.ts$/;

/**
 * Categories for `DECLARED_NOT_RUN`. Closed set — an unknown category is a
 * verification error, so new entries must pick a real reason.
 */
export const DECLARATION_CATEGORIES = new Set([
  // Needs a network peer, live provider credentials or an external service.
  'requires-external-env',
  // Needs orchestrated multi-process fault injection / crash harness.
  'chaos-orchestration',
  // Runs, but currently fails against a real defect tracked elsewhere.
  'known-red-tracked',
  // Verified unreachable; not yet triaged.
  'unregistered-known-debt',
  // Superseded by another suite that covers the same contract.
  'superseded',
]);

const MIN_REASON_LENGTH = 24;

/**
 * Test files that exist but are deliberately not executed by any runner.
 *
 * Every entry must name a real file and carry a category from
 * `DECLARATION_CATEGORIES` plus a reason of at least `MIN_REASON_LENGTH`
 * characters. `test-inventory.mjs --verify` rejects missing files, unknown
 * categories, short reasons, and entries that contradict a runner registration.
 */
export const DECLARED_NOT_RUN = [
  // ---- benchmarks: environment-dependent latency / external API -------------
  {
    file: 'tests/benchmark/advancedPerformanceBenchmark.test.ts',
    category: 'requires-external-env',
    reason: 'Latency-threshold benchmark; asserts wall-clock budgets that are not reproducible on a shared CI runner.',
  },
  {
    file: 'tests/benchmark/comparisonBenchmark.test.ts',
    category: 'requires-external-env',
    reason: 'Latency-threshold benchmark; asserts wall-clock budgets that are not reproducible on a shared CI runner.',
  },
  {
    file: 'tests/benchmark/performanceBenchmark.test.ts',
    category: 'requires-external-env',
    reason: 'Latency-threshold benchmark; asserts wall-clock budgets that are not reproducible on a shared CI runner.',
  },
  {
    file: 'tests/benchmark/loadBenchmark.test.ts',
    category: 'requires-external-env',
    reason: 'Load benchmark with intermittent CI timeouts; needs a dedicated, resource-controlled job.',
  },
  {
    file: 'tests/benchmark/realWorldBenchmark.test.ts',
    category: 'requires-external-env',
    reason: 'Requires the external StepFun API and network egress; must not run in the offline unit suite.',
  },
  {
    file: 'tests/benchmark/multiAgentBenchmark.metrics.test.ts',
    category: 'known-red-tracked',
    reason: 'Imports src/benchmark/multiAgentBenchmark, which does not exist on this branch — module is retired or not yet extracted.',
  },
  // ---- chaos: needs orchestrated fault injection ---------------------------
  {
    file: 'tests/chaos/l1Llm.test.ts',
    category: 'chaos-orchestration',
    reason: 'Chaos suite requiring orchestrated fault injection at the LLM layer; belongs in a dedicated chaos job.',
  },
  {
    file: 'tests/chaos/l2Tool.test.ts',
    category: 'chaos-orchestration',
    reason: 'Chaos suite requiring orchestrated fault injection at the tool layer; belongs in a dedicated chaos job.',
  },
  {
    file: 'tests/chaos/l3System.test.ts',
    category: 'chaos-orchestration',
    reason: 'Chaos suite requiring orchestrated fault injection at the system layer; belongs in a dedicated chaos job.',
  },
  {
    file: 'tests/chaos/l4Tenant.test.ts',
    category: 'chaos-orchestration',
    reason: 'Chaos suite requiring orchestrated fault injection at the tenant layer; belongs in a dedicated chaos job.',
  },
  {
    file: 'tests/chaos/orchestrator.test.ts',
    category: 'chaos-orchestration',
    reason: 'Chaos orchestrator harness; requires the full fault-injection runtime rather than an offline unit run.',
  },
  {
    file: 'tests/chaos/recoveryVerifier.test.ts',
    category: 'chaos-orchestration',
    reason: 'Chaos recovery verifier; requires the fault-injection runtime and a controlled crash surface.',
  },
  // ---- crash / resume harnesses -------------------------------------------
  {
    file: 'tests/stress/resume.hammer.test.ts',
    category: 'chaos-orchestration',
    reason: 'Crash-resume hammer loop; drives repeated process restarts and needs an isolated recovery job.',
  },
  {
    file: 'tests/ultimate/resume.goal.test.ts',
    category: 'chaos-orchestration',
    reason: 'Crash-resume harness for the Goal topology; needs an isolated recovery job, not the offline unit suite.',
  },
  {
    file: 'tests/ultimate/resume.sequential.test.ts',
    category: 'chaos-orchestration',
    reason: 'Crash-resume harness for sequential execution; needs an isolated recovery job.',
  },
  {
    file: 'tests/ultimate/resume.swarm.test.ts',
    category: 'chaos-orchestration',
    reason: 'Crash-resume harness for the Swarm topology; needs an isolated recovery job.',
  },
  {
    file: 'tests/ultimate/resume.taskpool.test.ts',
    category: 'chaos-orchestration',
    reason: 'Crash-resume harness for the task pool; needs an isolated recovery job.',
  },
  // ---- live provider / external environment -------------------------------
  {
    file: 'tests/e2e/real-api.test.ts',
    category: 'requires-external-env',
    reason: 'Exercises a real provider API and needs live credentials; must be a separate, explicitly gated job.',
  },
  {
    file: 'tests/e2e/real-api-chaos.test.ts',
    category: 'requires-external-env',
    reason: 'Real-provider chaos run; needs live credentials plus fault injection, so it cannot run offline.',
  },
  // tests/deployment/tenantDeployment.test.ts is NOT declared here: it needs no
  // deployment target. It provisions its own temp config/data/keys root and runs
  // the local create/migrate/destroy scripts from deploy/scripts (offline, 9
  // tests, ~3s), and deploy/README.md §8 documents running it directly.
  // ---- known-red: real defects tracked outside this workstream ------------
  {
    file: 'tests/runtime/llmCaller.test.ts',
    category: 'known-red-tracked',
    reason: 'FallbackChainExhaustedError does not record a fallback_exhausted sample — a real defect in the LLMCaller phase-1 helper.',
  },
  {
    file: 'tests/ultimate/checkpoint.roundTrip.test.ts',
    category: 'known-red-tracked',
    reason: 'Orchestrator checkpoint emission for the Goal and Swarm topologies is not wired into ReliabilityEngine persistence.',
  },
  {
    file: 'tests/ultimate/coordinationPolicy.test.ts',
    category: 'known-red-tracked',
    reason: 'Uses legacy topology alias names that are incompatible with the D3.2 canonical types.',
  },
  {
    file: 'tests/ultimate/coordinationPolicyLearned.test.ts',
    category: 'known-red-tracked',
    reason: 'Uses legacy topology alias names that are incompatible with the D3.2 canonical types.',
  },
  {
    file: 'tests/ultimate/learnedWeights.test.ts',
    category: 'known-red-tracked',
    reason: 'Uses legacy topology alias names that are incompatible with the D3.2 canonical types.',
  },
  {
    file: 'tests/ultimate/learnedWeightsTenant.test.ts',
    category: 'known-red-tracked',
    reason: 'Uses legacy topology alias names that are incompatible with the D3.2 canonical types.',
  },
  {
    file: 'tests/plugins/observability/otelExporter.test.ts',
    category: 'known-red-tracked',
    reason: 'Requires src/plugins/builtin/observability/otelExporter, which has not been extracted from core yet.',
  },
  {
    file: 'tests/plugins/observability/retryRuleOnRealTraces.test.ts',
    category: 'known-red-tracked',
    reason: 'Depends on the plugin otelExporter module, which has not been extracted from core yet.',
  },
  {
    file: 'tests/security/auditAggregatorBridge.test.ts',
    category: 'known-red-tracked',
    reason: 'Fails in isolation (assertion "expected 0 to be greater than 0") against the current audit aggregator bridge.',
  },
  {
    file: 'src/security/owaspAgenticAiTop10.test.ts',
    category: 'known-red-tracked',
    reason: 'Fails in isolation: an empty detection window is reported as "No detections" instead of the expected GREEN grade.',
  },
  // ---- verified unreachable, not yet triaged ------------------------------
  {
    file: 'tests/capability-token-debug.test.ts',
    category: 'unregistered-known-debt',
    reason: 'Debug scratch test never registered with either runner; verified unreachable. Triage pending.',
  },
  {
    file: 'tests/security/securityGuardianFacade.test.ts',
    category: 'unregistered-known-debt',
    reason: 'Never registered with either runner. Passes in isolation, so it is a candidate for registration after review.',
  },
  {
    file: 'src/storage/dataRetention.test.ts',
    category: 'unregistered-known-debt',
    reason: 'Never registered with either runner. Passes in isolation, so it is a candidate for registration after review.',
  },
];

/** POSIX-normalised path relative to `CORE_ROOT`. */
export function toPosix(p) {
  return p.split(sep).join('/');
}

/**
 * Recursively collect every file under `dir` whose name matches
 * `TEST_FILE_PATTERN`. Returns paths relative to `CORE_ROOT`, POSIX-style.
 */
export function discoverTestFiles(root = CORE_ROOT, roots = TEST_ROOTS) {
  const out = [];
  const walk = (absoluteDir) => {
    let entries;
    try {
      entries = readdirSync(absoluteDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(join(absoluteDir, entry.name));
      } else if (entry.isFile() && TEST_FILE_PATTERN.test(entry.name)) {
        out.push(toPosix(relative(root, join(absoluteDir, entry.name))));
      }
    }
  };
  for (const rel of roots) {
    const absolute = join(root, rel);
    if (existsSync(absolute)) walk(absolute);
  }
  return out.sort();
}

/**
 * True when `source` contains a real `import … from '<moduleName>'` statement.
 *
 * Deliberately line-anchored and statement-bounded:
 *   - Line-anchored so a module specifier that merely appears inside a string
 *     literal or a trailing comment (for example a fixture that writes out an
 *     import statement, or a note saying a file used to import vitest) is not
 *     mistaken for a real import. A plain substring search reported such files
 *     as "mixed runner".
 *   - Bounded by the first `;` or `from`, so a multi-line named import still
 *     matches while the scan cannot run past the end of one statement into a
 *     later one.
 *
 * Every `.test.ts` in this package uses the `import … from` form; no file uses
 * `require(…)`, bare `import '…'`, or dynamic `import('…')`.
 */
function importsFrom(source, moduleName) {
  const escaped = moduleName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const statement = new RegExp(
    `^[ \\t]*import\\b(?:(?!;|\\bfrom\\b)[\\s\\S])*?from[ \\t]*['"]${escaped}['"]`,
    'm',
  );
  return statement.test(source);
}

/**
 * Which runner can execute this file, judged by the test framework it imports.
 *
 * `unknown` means neither runner will produce tests from it — a file in that
 * state is silently worthless, which is why `--verify` rejects it. `mixed`
 * means both frameworks are imported, which double-runs the file and is
 * likewise rejected.
 */
export function classifyRunner(source) {
  const usesVitest = importsFrom(source, 'vitest');
  const usesNodeTest = importsFrom(source, 'node:test');
  if (usesVitest && usesNodeTest) return 'mixed';
  if (usesVitest) return 'vitest';
  if (usesNodeTest) return 'node';
  return 'unknown';
}

/** True when the source contains at least one framework test/suite declaration. */
export function declaresAnyTest(source) {
  return /\b(?:it|test|describe)\s*(?:\.\s*\w+\s*)?\(/.test(source);
}

/** True when the file is a plausible entry point for the `node:test` runner. */
export function isNodeRunnerFile(relPath, source) {
  return classifyRunner(source) === 'node' && !relPath.startsWith('src/');
}

/**
 * Parse the enabled `test.include` list out of `vitest.config.ts`.
 *
 * Uses the TypeScript parser rather than a regex: a regex cannot tell a live
 * entry from a commented-out one, and the `src/` glob's doubled-star segment is
 * indistinguishable from a block-comment opener to any naive comment stripper.
 *
 * @returns {{status: 'ok', include: string[]} | {status: string, detail: string}}
 */
export function readVitestInclude(root = CORE_ROOT) {
  const configPath = join(root, 'vitest.config.ts');
  if (!existsSync(configPath)) {
    return { status: 'CONFIG_MISSING', detail: 'vitest.config.ts not found' };
  }
  let ts;
  try {
    ts = require('typescript');
  } catch {
    return { status: 'CONFIG_UNRESOLVED', detail: 'typescript module is not resolvable' };
  }

  const source = readFileSync(configPath, 'utf8');
  const sourceFile = ts.createSourceFile(configPath, source, ts.ScriptTarget.Latest, true);

  const nameOf = (name) => {
    if (!name) return undefined;
    if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
    return undefined;
  };

  // The `test:` property of the exported config object. Only direct properties
  // of that object are inspected, so `coverage.include` cannot leak in.
  let testObject;
  const findTestObject = (node) => {
    if (testObject) return;
    if (ts.isObjectLiteralExpression(node)) {
      const testProp = node.properties.find(
        (p) => ts.isPropertyAssignment(p) && nameOf(p.name) === 'test',
      );
      if (testProp && ts.isObjectLiteralExpression(testProp.initializer)) {
        testObject = testProp.initializer;
        return;
      }
    }
    ts.forEachChild(node, findTestObject);
  };
  findTestObject(sourceFile);

  if (!testObject) {
    return { status: 'CONFIG_UNRESOLVED', detail: 'no `test:` object literal found in vitest.config.ts' };
  }

  const includeProp = testObject.properties.find(
    (p) => ts.isPropertyAssignment(p) && nameOf(p.name) === 'include',
  );
  if (!includeProp) {
    return { status: 'CONFIG_UNRESOLVED', detail: 'no `test.include` property found' };
  }
  if (!ts.isArrayLiteralExpression(includeProp.initializer)) {
    return {
      status: 'CONFIG_UNRESOLVED',
      detail: '`test.include` is not a static array literal, so the enabled set cannot be determined',
    };
  }

  const include = [];
  for (const element of includeProp.initializer.elements) {
    if (ts.isStringLiteral(element) || ts.isNoSubstitutionTemplateLiteral(element)) {
      include.push(element.text);
    } else if (ts.isSpreadElement(element)) {
      return {
        status: 'CONFIG_UNRESOLVED',
        detail: '`test.include` contains a spread element, so the enabled set cannot be determined statically',
      };
    } else {
      return {
        status: 'CONFIG_UNRESOLVED',
        detail: `\`test.include\` contains a non-literal element: ${element.getText(sourceFile).slice(0, 80)}`,
      };
    }
  }

  return { status: 'ok', include };
}

/** Read a file's source relative to `CORE_ROOT`, or `undefined` if unreadable. */
export function readSource(relPath, root = CORE_ROOT) {
  const result = readSourceDetailed(relPath, root);
  return result.ok ? result.source : undefined;
}

/**
 * Read a file's source and report *why* it failed.
 *
 * `readSource` collapses every failure to `undefined`, which makes an
 * unreadable file indistinguishable from a missing one — and, when the failure
 * is environmental (a sandbox or ACL blocking the read), the gate's verdict
 * becomes non-deterministic for identical input. Callers that report a reason
 * should use this and surface `code`.
 *
 * @returns {{ok: true, source: string} | {ok: false, code: string, message: string}}
 */
export function readSourceDetailed(relPath, root = CORE_ROOT) {
  const full = join(root, relPath);
  try {
    return { ok: true, source: readFileSync(full, 'utf8') };
  } catch (err) {
    const code = err?.code ?? 'UNKNOWN';
    return {
      ok: false,
      code,
      message: `${relPath}: ${code} (${err?.message ?? 'no message'})`,
    };
  }
}

/**
 * True when a read failure is an environment/permission problem rather than a
 * missing file. `ENOENT` means the path is genuinely gone (a repo defect or a
 * discovery/read race); anything else (`EACCES`, `EPERM`, `EBUSY`, ...) means
 * something outside the repository is blocking the read.
 */
export function isEnvironmentReadFailure(code) {
  return code !== 'ENOENT' && code !== 'ENOTDIR';
}

/** Validate a `DECLARED_NOT_RUN` entry. Returns an array of problems. */
export function validateDeclaration(entry, root = CORE_ROOT) {
  const problems = [];
  if (!entry || typeof entry.file !== 'string' || entry.file.length === 0) {
    problems.push('entry has no `file`');
    return problems;
  }
  if (!existsSync(join(root, entry.file))) {
    problems.push(`declared file does not exist: ${entry.file}`);
  }
  if (!DECLARATION_CATEGORIES.has(entry.category)) {
    problems.push(`unknown category "${entry.category}" for ${entry.file}`);
  }
  if (typeof entry.reason !== 'string' || entry.reason.trim().length < MIN_REASON_LENGTH) {
    problems.push(
      `reason for ${entry.file} is missing or shorter than ${MIN_REASON_LENGTH} characters`,
    );
  }
  return problems;
}
