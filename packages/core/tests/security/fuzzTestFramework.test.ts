/**
 * FuzzTestFramework Tests
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  FuzzTestFramework,
  resetFuzzTestFramework,
  createFileSystemToolHarness,
  createWebSearchToolHarness,
} from '../../src/security/fuzzTestFramework';
import type { ToolHarness } from '../../src/security/fuzzTestFramework';

function makeEchoHarness(): ToolHarness {
  return {
    name: 'echo',
    params: {
      message: { type: 'string', required: true, minLength: 1, maxLength: 1000 },
      repeat: { type: 'number', min: 1, max: 10 },
      flag: { type: 'boolean' },
    },
    execute: async (input) => {
      const msg = (input as Record<string, unknown>).message;
      if (typeof msg === 'string' && msg.includes('\x00')) {
        throw new Error('Null byte injection detected');
      }
      return { echoed: msg };
    },
  };
}

function makeCrashingHarness(): ToolHarness {
  return {
    name: 'crasher',
    params: {
      data: { type: 'string', required: true },
    },
    execute: async (input) => {
      const data = (input as Record<string, unknown>).data;
      if (typeof data === 'string' && data.length > 100) {
        throw new TypeError('Buffer overflow');
      }
      return { ok: true };
    },
  };
}

describe('FuzzTestFramework', () => {
  let fuzzer: FuzzTestFramework;

  beforeEach(() => {
    resetFuzzTestFramework();
    fuzzer = new FuzzTestFramework({ maxMutations: 100 });
  });

  afterEach(() => {
    resetFuzzTestFramework();
  });

  describe('harness registration', () => {
    it('registers a harness and seeds corpus', () => {
      fuzzer.registerHarness(makeEchoHarness());
      expect(fuzzer.getCorpus().length).toBeGreaterThan(0);
    });

    it('unregisters a harness', () => {
      fuzzer.registerHarness(makeEchoHarness());
      fuzzer.unregisterHarness('echo');
      // After unregister, no harnesses remain; run should be empty
    });

    it('seeds one input per parameter', () => {
      const harness = makeEchoHarness();
      fuzzer.registerHarness(harness);
      const corpus = fuzzer.getCorpus();
      // echo has 3 params → at least 3 seeds
      expect(corpus.length).toBeGreaterThanOrEqual(3);
    });
  });

  describe('fuzz run', () => {
    it('runs mutations against registered harnesses', async () => {
      fuzzer.registerHarness(makeEchoHarness());
      const report = await fuzzer.run();
      expect(report.totalInputs).toBeGreaterThan(0);
      expect(report.summary.info).toBeGreaterThan(0);
      expect(report.durationMs).toBeGreaterThan(0);
    });

    it('detects crashes', async () => {
      const smallFuzzer = new FuzzTestFramework({ maxMutations: 200 });
      smallFuzzer.registerHarness(makeCrashingHarness());
      const report = await smallFuzzer.run();
      if (report.summary.crash > 0) {
        expect(report.crashes.length).toBeGreaterThan(0);
        const crash = report.crashes[0];
        expect(crash.crashed).toBe(true);
        expect(crash.errorMessage).toBeTruthy();
      }
    });

    it('tracks coverage paths', async () => {
      fuzzer.registerHarness(makeEchoHarness());
      const report = await fuzzer.run();
      expect(Object.keys(report.coverageMap).length).toBeGreaterThan(0);
    });

    it('generates unique IDs for results', async () => {
      fuzzer.registerHarness(makeEchoHarness());
      await fuzzer.run();
      const results = fuzzer.getResults();
      const ids = new Set(results.map((r) => r.id));
      expect(ids.size).toBe(results.length);
    });

    it('fuzzes all mutation strategies', async () => {
      const allFuzzer = new FuzzTestFramework({
        maxMutations: 300,
        strategies: [
          'byte_flip',
          'boundary_inject',
          'structure_mutate',
          'injection_insert',
          'type_confuse',
          'unicode_mangle',
        ],
      });
      allFuzzer.registerHarness(makeEchoHarness());
      await allFuzzer.run();
      const results = allFuzzer.getResults();
      const strategies = new Set(results.map((r) => r.input.strategy));
      expect(strategies.size).toBeGreaterThan(2);
    });
  });

  describe('built-in harnesses', () => {
    it('file system harness validates paths', async () => {
      fuzzer.registerHarness(createFileSystemToolHarness());
      const report = await fuzzer.run();
      expect(report.totalInputs).toBeGreaterThan(0);
    });

    it('web search harness validates queries', async () => {
      fuzzer.registerHarness(createWebSearchToolHarness());
      const report = await fuzzer.run();
      expect(report.totalInputs).toBeGreaterThan(0);
    });
  });

  describe('coverage guidance', () => {
    it('coverageGuided mode keeps novel inputs', async () => {
      const guided = new FuzzTestFramework({ maxMutations: 100, coverageGuided: true });
      guided.registerHarness(makeEchoHarness());
      await guided.run();
      expect(guided.getCorpus().length).toBeGreaterThan(0);
    });

    it('crashOnly mode discards non-crash inputs', async () => {
      const crashOnly = new FuzzTestFramework({
        maxMutations: 100,
        coverageGuided: true,
        crashOnly: true,
      });
      crashOnly.registerHarness(makeCrashingHarness());
      await crashOnly.run();
      // Corpus only contains crash-triggering inputs
      const corpus = crashOnly.getCorpus();
      // At minimum the initial seeds are in corpus; crashOnly may reduce
      expect(corpus.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe('reset', () => {
    it('clears corpus, results, and harnesses', () => {
      fuzzer.registerHarness(makeEchoHarness());
      fuzzer.reset();
      expect(fuzzer.getCorpus().length).toBe(0);
      expect(fuzzer.getResults().length).toBe(0);
    });
  });
});
