/**
 * Guards against reintroduction of verified-dead modules deleted during
 * consolidation iterations.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '../../../..');

describe('orphan deletion guards', () => {
  it('does not reintroduce apps/api deterministicTaskAllocator', () => {
    assert.equal(
      existsSync(join(ROOT, 'apps/api/src/deterministicTaskAllocator.ts')),
      false,
      'deterministicTaskAllocator was deleted as an orphan (2026-07-15); do not reintroduce',
    );
  });

  it('architecture-gate config no longer exempts deterministicTaskAllocator', () => {
    const cfgPath = join(ROOT, 'scripts/architecture-gate.config.json');
    assert.ok(existsSync(cfgPath));
    const text = readFileSync(cfgPath, 'utf8');
    assert.doesNotMatch(
      text,
      /deterministicTaskAllocator/,
      'exception list must shrink when orphans are deleted',
    );
  });
});
