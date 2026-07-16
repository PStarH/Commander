/**
 * Claim honesty: marketing/docstrings must not overstate durability.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '../../../..');

describe('claim honesty', () => {
  it('apps/api EpisodicMemoryStore stays deleted after the zombie removal', () => {
    const path = join(ROOT, 'apps/api/src/episodicMemoryStore.ts');
    assert.equal(
      existsSync(path),
      false,
      'apps/api EpisodicMemoryStore was deleted as a health-only zombie; do not reintroduce',
    );
  });

  it('EventSourcingEngine header does not claim unconditional WAL durability', () => {
    const path = join(ROOT, 'packages/core/src/runtime/eventSourcingEngine.ts');
    assert.ok(existsSync(path));
    const head = readFileSync(path, 'utf8').slice(0, 1200);
    assert.match(head, /optional file WAL|in-memory only/i);
    assert.doesNotMatch(
      head,
      /Event Sourcing Engine — WAL persistence with hash-chain integrity/,
      'unconditional WAL claim was fixed 2026-07-15',
    );
    const body = readFileSync(path, 'utf8');
    assert.match(body, /isDurable\(\): boolean/, 'must expose isDurable() for callers');
  });
});
