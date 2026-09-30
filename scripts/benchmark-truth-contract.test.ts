/**
 * benchmark-truth-contract.test.ts — LM-19
 *
 * A benchmark scaffold proves its *plumbing*, never its *capability*. The
 * defect this file guards against is the two being collapsed into one success
 * field: six stub benchmarks that always failed were compared against a local
 * zero baseline and printed "Capability check passed", and the GAIA fixture fed
 * its own answer back as the agent output, producing a 100% score that was
 * reported as a GAIA result.
 *
 * The contract, asserted here:
 *   1. Only a `live` run at or above a reviewed baseline can be a capability
 *      PASS. `scaffold` / `simulated` are always NOT_EVALUATED.
 *   2. A missing baseline is NOT_EVALUATED — never an auto-created pass.
 *   3. The rendered verdict never contains "Capability check passed" unless the
 *      status really is PASS, so a CI log cannot be misread.
 *   4. Every benchmark script declares a non-live execution mode and routes its
 *      verdict through the shared helper.
 *   5. GAIA labels its oracle-echo fixture (`oracleEcho: true`,
 *      `scoringEligible: false`) instead of publishing the tautology as a score.
 *   6. No script writes a baseline unless that act is explicitly requested.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  capabilityStrictFromEnv,
  capabilityVerdict,
  formatCapabilityVerdict,
} from './benchmarkEnv.js';

const SCRIPTS_DIR = join(import.meta.dirname ?? __dirname, '..', 'scripts');

/** The seven stub scaffolds migrated alongside GAIA. */
const SCAFFOLD_SCRIPTS = [
  'benchmark-agentbench.ts',
  'benchmark-crab.ts',
  'benchmark-swebench.ts',
  'benchmark-osworld.ts',
  'benchmark-caict-ai-safety.ts',
  'benchmark-mlcommons-ailuminate.ts',
  'benchmark-webarena.ts',
];

const ALL_BENCH_SCRIPTS = [...SCAFFOLD_SCRIPTS, 'benchmark-gaia.ts'];

function readScript(name: string): string {
  return readFileSync(join(SCRIPTS_DIR, name), 'utf-8');
}

describe('capabilityVerdict — only a live run with a reviewed baseline can PASS', () => {
  it('scaffold mode is NOT_EVALUATED and not scoring-eligible', () => {
    const v = capabilityVerdict({
      mode: 'scaffold',
      accuracy: 1,
      baselineAccuracy: 1,
      strict: false,
    });
    assert.equal(v.status, 'NOT_EVALUATED');
    assert.equal(v.scoringEligible, false);
    assert.equal(v.exitCode, 0, 'a diagnostic run still exits 0');
  });

  it('scaffold mode exits non-zero under strict (required-job) mode', () => {
    const v = capabilityVerdict({
      mode: 'scaffold',
      accuracy: 1,
      baselineAccuracy: 1,
      strict: true,
    });
    assert.equal(v.status, 'NOT_EVALUATED');
    assert.equal(v.exitCode, 1);
  });

  it('simulated mode is NOT_EVALUATED even with a matching baseline', () => {
    const v = capabilityVerdict({ mode: 'simulated', accuracy: 1, baselineAccuracy: 1 });
    assert.equal(v.status, 'NOT_EVALUATED');
    assert.equal(v.scoringEligible, false);
  });

  it('a live run with no baseline is NOT_EVALUATED — never an auto-pass', () => {
    const v = capabilityVerdict({ mode: 'live', accuracy: 1, baselineAccuracy: null });
    assert.equal(v.status, 'NOT_EVALUATED');
    assert.equal(v.scoringEligible, false);
    assert.match(v.reason, /no reviewed baseline/i);
  });

  it('a live run below its baseline FAILS', () => {
    const v = capabilityVerdict({ mode: 'live', accuracy: 0.4, baselineAccuracy: 0.9 });
    assert.equal(v.status, 'FAIL');
    assert.equal(v.exitCode, 1);
    assert.equal(v.scoringEligible, true, 'a regression is real evidence');
  });

  it('a live run at or above its baseline PASSES', () => {
    const at = capabilityVerdict({ mode: 'live', accuracy: 0.9, baselineAccuracy: 0.9 });
    assert.equal(at.status, 'PASS');
    assert.equal(at.exitCode, 0);
    const above = capabilityVerdict({ mode: 'live', accuracy: 0.95, baselineAccuracy: 0.9 });
    assert.equal(above.status, 'PASS');
  });
});

describe('formatCapabilityVerdict — the string "Capability check passed" is reserved', () => {
  it('never prints the PASS sentence for a non-PASS verdict', () => {
    for (const mode of ['scaffold', 'simulated'] as const) {
      const v = capabilityVerdict({ mode, accuracy: 1, baselineAccuracy: 1 });
      const line = formatCapabilityVerdict(v, { accuracy: 1, baselineAccuracy: 1 });
      assert.doesNotMatch(line, /Capability check passed/);
      assert.match(line, /NOT_EVALUATED/);
      assert.match(line, /not a pass/i);
    }
  });

  it('prints the PASS sentence only for a real PASS', () => {
    const v = capabilityVerdict({ mode: 'live', accuracy: 1, baselineAccuracy: 0.5 });
    assert.match(
      formatCapabilityVerdict(v, { accuracy: 1, baselineAccuracy: 0.5 }),
      /Capability check passed/,
    );
  });
});

describe('capabilityStrictFromEnv', () => {
  it('is false by default and true only for the exact opt-in value', () => {
    assert.equal(capabilityStrictFromEnv({} as NodeJS.ProcessEnv), false);
    assert.equal(
      capabilityStrictFromEnv({ COMMANDER_BENCHMARK_STRICT: '1' } as NodeJS.ProcessEnv),
      true,
    );
    for (const other of ['0', 'true', 'yes', '']) {
      assert.equal(
        capabilityStrictFromEnv({ COMMANDER_BENCHMARK_STRICT: other } as NodeJS.ProcessEnv),
        false,
        `${other} must not enable strict mode`,
      );
    }
  });
});

describe('benchmark scripts declare a non-live mode and route through the shared verdict', () => {
  for (const name of ALL_BENCH_SCRIPTS) {
    it(`${name} declares a scaffold/simulated execution mode`, () => {
      const src = readScript(name);
      assert.match(
        src,
        /BenchmarkExecutionMode/,
        'must import/annotate the execution-mode type so the mode is explicit',
      );
      assert.match(src, /const SCAFFOLD_MODE[^=]*=\s*'(scaffold|simulated)'/);
      assert.doesNotMatch(
        src,
        /const SCAFFOLD_MODE[^=]*=\s*'live'/,
        'a scaffold script must not declare itself live',
      );
    });

    it(`${name} computes its verdict with capabilityVerdict + capabilityStrictFromEnv`, () => {
      const src = readScript(name);
      assert.match(src, /capabilityVerdict\(/);
      assert.match(src, /capabilityStrictFromEnv\(/);
      assert.match(src, /formatCapabilityVerdict\(/);
    });

    it(`${name} never prints an unconditional capability pass`, () => {
      const src = readScript(name);
      assert.doesNotMatch(
        src,
        /Capability check passed/,
        'the sentence must come from formatCapabilityVerdict, never be hardcoded',
      );
    });
  }
});

describe('baseline writes are explicit, never a by-product of verification', () => {
  for (const name of SCAFFOLD_SCRIPTS) {
    it(`${name} gates saveBaseline behind COMMANDER_BENCHMARK_SAVE_BASELINE`, () => {
      const src = readScript(name);
      if (!src.includes('saveBaseline(')) return; // script has no baseline concept
      const guardIndex = src.indexOf('COMMANDER_BENCHMARK_SAVE_BASELINE');
      assert.ok(guardIndex >= 0, 'must reference the explicit opt-in guard');

      // Match *call sites* only. `function saveBaseline(` is the declaration and
      // legitimately precedes the guard; every invocation must follow it.
      const callSites: number[] = [];
      const re = /saveBaseline\(/g;
      let match: RegExpExecArray | null;
      while ((match = re.exec(src)) !== null) {
        const before = src.slice(Math.max(0, match.index - 24), match.index);
        if (/function\s+$/.test(before)) continue; // declaration, not a call
        callSites.push(match.index);
      }
      assert.ok(callSites.length > 0, 'expected at least one saveBaseline call site');
      for (const index of callSites) {
        assert.ok(
          index > guardIndex,
          'every saveBaseline call must sit after the explicit opt-in guard',
        );
      }
    });
  }
});

describe('GAIA labels its oracle echo instead of publishing it as a score', () => {
  const src = readScript('benchmark-gaia.ts');

  it('marks fixture tasks as oracle echoes that are not scoring-eligible', () => {
    assert.match(src, /oracleEcho:\s*true/);
    assert.match(src, /scoringEligible:\s*false/);
  });

  it('carries the provenance labels into the emitted artifact', () => {
    assert.match(src, /executionMode:\s*SCAFFOLD_MODE/);
    assert.match(src, /capabilityStatus:\s*capability\.status/);
    assert.match(src, /scoringEligible:\s*capability\.scoringEligible/);
  });

  it('scopes the spine verdict to plumbing rather than capability', () => {
    assert.match(src, /plumbing check, not a capability result/);
  });
});
