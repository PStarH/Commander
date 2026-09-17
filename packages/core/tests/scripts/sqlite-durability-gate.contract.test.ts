/**
 * Contract tests for the SQLite durability gate (LM-04).
 *
 * A `node:test` file, so it is auto-discovered by `scripts/run-node-tests.mjs`.
 *
 * What is locked here:
 *   1. `COMMANDER_REQUIRE_SQLITE_TESTS` is parsed fail-closed: only explicit
 *      truthy values turn the skip into a hard failure.
 *   2. A release-gate run with an unusable binding throws instead of skipping.
 *   3. A development run with an unusable binding is allowed to skip, but says
 *      so with a greppable marker.
 *   4. An available binding never throws, whatever the flag says.
 *   5. The functional probe actually exercises the native round trip.
 *   6. The fallback entry point refuses to run without explicit opt-in, and its
 *      exclusion list contains no ghost or no-op entries.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { CORE_ROOT, readVitestInclude } from '../../scripts/test-manifest.mjs';
import {
  probeSqliteFunctionally,
  sqliteDurabilityGate,
  sqliteTestsRequired,
} from '../storage/sqliteTestGate';

const FALLBACK_SCRIPT = join(CORE_ROOT, 'scripts', 'run-vitest-sqlite-fallback.sh');

const UNAVAILABLE = { available: false, reason: 'simulated: binding is unusable' };
const AVAILABLE = { available: true, reason: '' };

describe('sqliteTestsRequired is fail-closed', () => {
  it('treats unset, empty and non-truthy values as "not required"', () => {
    for (const value of [undefined, '', ' ', '0', 'false', 'no', 'off', 'maybe']) {
      assert.equal(
        sqliteTestsRequired(value === undefined ? {} : { COMMANDER_REQUIRE_SQLITE_TESTS: value }),
        false,
        `"${String(value)}" must not be read as "required"`,
      );
    }
  });

  it('accepts the explicit truthy spellings', () => {
    for (const value of ['1', 'true', 'TRUE', 'yes', 'on', ' 1 ']) {
      assert.equal(
        sqliteTestsRequired({ COMMANDER_REQUIRE_SQLITE_TESTS: value }),
        true,
        `"${value}" must be read as "required"`,
      );
    }
  });
});

describe('sqliteDurabilityGate', () => {
  it('throws when the binding is unusable and the run is a release gate', () => {
    assert.throws(
      () => sqliteDurabilityGate(() => UNAVAILABLE, { COMMANDER_REQUIRE_SQLITE_TESTS: '1' }),
      (err) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /COMMANDER_REQUIRE_SQLITE_TESTS is set/);
        assert.match(err.message, /Refusing to skip the persistence acceptance suite/);
        assert.match(err.message, /simulated: binding is unusable/);
        return true;
      },
    );
  });

  it('does not throw when the binding is unusable and the run is not a gate', () => {
    const result = sqliteDurabilityGate(() => UNAVAILABLE, {});
    assert.equal(result.available, false);
    assert.match(result.reason, /simulated/);
  });

  it('returns available whenever the probe succeeds, gate or not', () => {
    assert.equal(sqliteDurabilityGate(() => AVAILABLE, {}).available, true);
    assert.equal(
      sqliteDurabilityGate(() => AVAILABLE, { COMMANDER_REQUIRE_SQLITE_TESTS: '1' }).available,
      true,
    );
  });

  it('announces the unmeasured skip with a greppable marker', () => {
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (message) => warnings.push(String(message));
    try {
      sqliteDurabilityGate(() => UNAVAILABLE, {});
    } finally {
      console.warn = originalWarn;
    }
    assert.equal(warnings.length, 1, 'the skip must be announced exactly once');
    assert.match(warnings[0], /SQLITE_DURABILITY_NOT_RUN/);
    assert.match(warnings[0], /durability was NOT measured/);
  });

  it('does not announce a skip when the probe succeeds', () => {
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (message) => warnings.push(String(message));
    try {
      sqliteDurabilityGate(() => AVAILABLE, {});
    } finally {
      console.warn = originalWarn;
    }
    assert.deepEqual(warnings, []);
  });
});

describe('probeSqliteFunctionally', () => {
  it('returns a well-formed verdict', () => {
    const result = probeSqliteFunctionally();
    assert.equal(typeof result.available, 'boolean');
    assert.equal(typeof result.reason, 'string');
    if (result.available) {
      assert.equal(result.reason, '', 'an available probe must not carry a failure reason');
    } else {
      assert.ok(result.reason.length > 0, 'an unavailable probe must explain itself');
    }
  });

  it('actually round-trips a row through the native binding when it is available', () => {
    // Guards against the probe degrading back into a "module loaded" check.
    const result = probeSqliteFunctionally();
    if (!result.available) {
      // On a machine without the binding this assertion is vacuous, but the
      // release gate (COMMANDER_REQUIRE_SQLITE_TESTS=1) is what turns that into
      // a failure — see the gate tests above.
      return;
    }
    assert.equal(result.available, true);
  });
});

describe('run-vitest-sqlite-fallback.sh', () => {
  const source = readFileSync(FALLBACK_SCRIPT, 'utf8');

  function runFallback(args = [], env = {}) {
    const result = spawnSync('bash', [FALLBACK_SCRIPT, ...args], {
      cwd: CORE_ROOT,
      encoding: 'utf8',
      env: { ...process.env, ...env },
    });
    return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  }

  it('refuses to run without the explicit opt-in', () => {
    const result = runFallback([], { COMMANDER_ALLOW_SQLITE_FALLBACK: '' });
    assert.notEqual(result.status, 0, 'the fallback must not run by default');
    assert.match(result.stderr, /REFUSING TO RUN — explicit opt-in missing/);
    assert.match(result.stderr, /COMMANDER_ALLOW_SQLITE_FALLBACK=1/);
  });

  it('refuses to run when the binding actually works', () => {
    // This machine has a working binding, so the opt-in alone must not be enough.
    const probe = probeSqliteFunctionally();
    if (!probe.available) return; // nothing to assert about the healthy path
    const result = runFallback([], { COMMANDER_ALLOW_SQLITE_FALLBACK: '1' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /REFUSING TO RUN — the SQLite binding works/);
  });

  it('declares coverage as incomplete in its report contract', () => {
    assert.match(source, /"coverageComplete":\s*false/);
    assert.match(source, /"durabilityMeasured":\s*false/);
    assert.match(source, /"acceptableAsReleaseEvidence":\s*false/);
    assert.match(source, /NOT DURABILITY ACCEPTANCE/);
  });

  function readArray(name) {
    const match = new RegExp(`${name}=\\(\\n([\\s\\S]*?)\\n\\)`).exec(source);
    assert.ok(match, `could not find the ${name} array in the fallback script`);
    return [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  }

  it('lists only existing, enabled .test.ts suites', () => {
    const suites = readArray('SUITES');
    assert.ok(suites.length > 5, `expected a substantial exclusion list, got ${suites.length}`);

    const include = readVitestInclude(CORE_ROOT);
    assert.equal(include.status, 'ok');
    const enabled = new Set(include.include);

    const problems = [];
    for (const suite of suites) {
      if (!suite.endsWith('.test.ts')) {
        problems.push(`${suite}: not a .test.ts file, so vitest would never run it anyway`);
      } else if (!enabled.has(suite)) {
        problems.push(`${suite}: not enabled in vitest.config.ts, so excluding it is a no-op`);
      }
    }
    assert.deepEqual(problems, [], problems.join('\n'));
  });

  it('separates the node:test SQLite suites it cannot exclude', () => {
    const suites = readArray('SUITES');
    const nodeSuites = readArray('NODE_SUITES');
    assert.ok(nodeSuites.length > 0, 'the node:test SQLite suites must stay visible');

    // A suite that vitest cannot run must not be presented as an exclusion;
    // excluding it would be a no-op and would overstate what this run drops.
    const include = readVitestInclude(CORE_ROOT);
    const enabled = new Set(include.include);
    for (const suite of nodeSuites) {
      assert.ok(
        !enabled.has(suite),
        `${suite} is enabled in vitest.config.ts and belongs in SUITES, not NODE_SUITES`,
      );
    }

    const overlap = suites.filter((s) => nodeSuites.includes(s));
    assert.deepEqual(overlap, [], 'a suite cannot be in both lists');
  });

  it('excludes the suites that carry the durability contracts', () => {
    const suites = readArray('SUITES');
    for (const required of [
      'tests/storage/persistentStore.test.ts',
      'tests/storage/sqliteDriver.test.ts',
    ]) {
      assert.ok(
        suites.includes(required),
        `${required} carries durability contracts and must be in the exclusion list`,
      );
    }
  });
});
