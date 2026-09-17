import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const WEBARENA_CACHE_DIR = path.join(process.cwd(), '.cache/webarena');
const AGENTBENCH_CACHE_DIR = path.join(process.cwd(), '.cache/agentbench');
const WEBARENA_TASKS = path.join(WEBARENA_CACHE_DIR, 'tasks.json');
const AGENTBENCH_TASKS = path.join(AGENTBENCH_CACHE_DIR, 'tasks.json');

/**
 * HC1-3..5 (`.internal/audit-2026-09-10/batchH-core-tests-part1.md`): both cases
 * used to `return` when the optional live fixture cache was absent. On a clean
 * CI checkout the cache is always absent, so the suite reported **two passes
 * that asserted nothing** — a green result that proved only that a file was
 * missing. A precondition that cannot be met must be reported as a skip with a
 * named reason, never as a pass.
 */
describe('WebArena / AgentBench benchmark fixtures', () => {
  it.skipIf(!fs.existsSync(WEBARENA_TASKS))(
    'should have WebArena task fixture with required files',
    () => {
      const raw = fs.readFileSync(WEBARENA_TASKS, 'utf-8');
      const data = JSON.parse(raw);
      expect(data.tasks).toBeDefined();
      expect(Array.isArray(data.tasks)).toBe(true);
      expect(data.tasks.length).toBeGreaterThan(0);
    },
  );

  it.skipIf(!fs.existsSync(AGENTBENCH_TASKS))(
    'should have AgentBench task fixture with required files',
    () => {
      const raw = fs.readFileSync(AGENTBENCH_TASKS, 'utf-8');
      const data = JSON.parse(raw);
      expect(data.tasks).toBeDefined();
      expect(Array.isArray(data.tasks)).toBe(true);
      expect(data.tasks.length).toBeGreaterThan(0);
    },
  );
});
