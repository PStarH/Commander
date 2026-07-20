import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const WEBARENA_CACHE_DIR = path.join(process.cwd(), '.cache/webarena');
const AGENTBENCH_CACHE_DIR = path.join(process.cwd(), '.cache/agentbench');

describe('WebArena / AgentBench benchmark fixtures', () => {
  it('should have WebArena task fixture with required files', () => {
    const taskPath = path.join(WEBARENA_CACHE_DIR, 'tasks.json');
    if (!fs.existsSync(taskPath)) {
      // Optional live fixture cache — not required on clean CI checkouts.
      return;
    }

    const raw = fs.readFileSync(taskPath, 'utf-8');
    const data = JSON.parse(raw);
    expect(data.tasks).toBeDefined();
    expect(Array.isArray(data.tasks)).toBe(true);
    expect(data.tasks.length).toBeGreaterThan(0);
  });

  it('should have AgentBench task fixture with required files', () => {
    const taskPath = path.join(AGENTBENCH_CACHE_DIR, 'tasks.json');
    if (!fs.existsSync(taskPath)) {
      return;
    }

    const raw = fs.readFileSync(taskPath, 'utf-8');
    const data = JSON.parse(raw);
    expect(data.tasks).toBeDefined();
    expect(Array.isArray(data.tasks)).toBe(true);
    expect(data.tasks.length).toBeGreaterThan(0);
  });
});
