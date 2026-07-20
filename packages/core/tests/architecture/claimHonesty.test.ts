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

  it('ARCHITECTURE + PRINCIPLES do not claim packages/operations is the timer/outbox plane', () => {
    const arch = readFileSync(join(ROOT, 'ARCHITECTURE.md'), 'utf8');
    const principles = readFileSync(join(ROOT, 'PRINCIPLES.md'), 'utf8');
    const maps = arch + principles;
    assert.doesNotMatch(
      arch,
      /packages\/operations`\s*\|\s*Outbox\/timer mains/i,
      'ARCHITECTURE must not describe ABSENT operations as outbox/timer',
    );
    assert.match(
      maps,
      /kernel-ops|packages\/kernel\/src\/ops/i,
      'maps must name kernel-ops for reclaim/timer/outbox',
    );
    assert.match(maps, /compensation/i, 'maps must acknowledge compensation ownership gap');
    assert.match(
      maps,
      /ban(?:s|ned)?[\s*`]*@commander\/operations|ban(?:s|ned)?[\s*`]*resurrect/i,
      'maps must state arch-guard bans resurrecting @commander/operations',
    );
    assert.doesNotMatch(
      maps,
      /reintroduce\s+`?@commander\/operations`?\s+as/i,
      'must not invite resurrecting @commander/operations under another name',
    );
    assert.match(
      maps,
      /adapter-ops[\s\S]{0,120}L4-B follow-up|L4-B follow-up[\s\S]{0,120}adapter-ops/i,
      'adapter-ops must be documented as L4-B follow-up only on master',
    );
  });

  it('no production kernel-ops main wires consumeCompensationBatch (library-only gap)', () => {
    const mainPath = join(ROOT, 'packages/kernel/src/ops/main.ts');
    assert.ok(existsSync(mainPath));
    const main = readFileSync(mainPath, 'utf8');
    assert.doesNotMatch(
      main,
      /consumeCompensationBatch/,
      'kernel-ops main must not silently claim compensation drain; library remains for a dedicated owner',
    );
    const consumer = join(ROOT, 'packages/kernel/src/ops/compensationConsumer.ts');
    assert.ok(existsSync(consumer), 'compensation consumer library should still exist');
  });
});
