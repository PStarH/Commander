import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const consumerSources = ['contracts.ts', 'deterministicModel.ts', 'invoke.ts', 'cli.ts'];

describe('external consumer boundary', () => {
  it('does not import Commander packages or repository internals', () => {
    for (const source of consumerSources) {
      const body = readFileSync(resolve(import.meta.dirname, '..', 'src', source), 'utf8');
      expect(body).not.toMatch(/@commander\//);
      expect(body).not.toMatch(/(?:^|['"])(?:\.\.\/)+(?:packages|apps)\//m);
    }
  });
});
