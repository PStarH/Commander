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
    assert.match(maps, /compensation/i, 'maps must name compensation ownership');
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
    // After L4-B land (#105), adapter-ops is the live PARTIAL deploy unit for
    // compensation/reconcile drain — not a deferred follow-up, not a fifth plane.
    assert.match(
      maps,
      /adapter-ops[\s\S]{0,200}(PARTIAL|compensation|reconcile)/i,
      'adapter-ops must be documented as PARTIAL deploy unit for compensation/reconcile',
    );
    assert.doesNotMatch(
      maps,
      /adapter-ops[\s\S]{0,80}L4-B follow-up only|L4-B follow-up only[\s\S]{0,80}adapter-ops/i,
      'must not still claim adapter-ops is follow-up-only after L4-B land',
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

  it('apps/api StateMachine persist/checkpoint uses atomicWriteFileSync (REL-3)', () => {
    const path = join(ROOT, 'apps/api/src/stateMachine.ts');
    assert.ok(existsSync(path));
    const body = readFileSync(path, 'utf8');
    assert.match(body, /atomicWriteFileSync/, 'must import/use atomicWriteFileSync');
    assert.match(body, /readJsonFileSafe/, 'must use readJsonFileSafe for load paths');
    assert.doesNotMatch(
      body,
      /fs\.writeFileSync\s*\(/,
      'non-atomic fs.writeFileSync was fixed 2026-07-20; do not reintroduce',
    );
  });

  it('security-sensitive Gateway JSON stores use atomicWrite + readJsonFileSafe (REL-3/REL-4)', () => {
    const arrayStores = [
      'apps/api/src/userStore.ts',
      'apps/api/src/apiKeyStore.ts',
      'apps/api/src/webhookEndpoints.ts',
      'apps/api/src/workflowEndpoints.ts',
      'apps/api/src/actionRationale.ts',
    ];
    const objectStores = [
      'apps/api/src/settingsStore.ts',
      'apps/api/src/oidcAuthEndpoints.ts',
      'apps/api/src/approvalConfigEndpoints.ts',
      'apps/api/src/onboardingEndpoints.ts',
    ];
    const files = [...arrayStores, ...objectStores, 'apps/api/src/refreshTokenStore.ts'];
    for (const rel of files) {
      const p = join(ROOT, rel);
      assert.ok(existsSync(p), `${rel} must exist`);
      const body = readFileSync(p, 'utf8');
      assert.match(body, /atomicWriteFileSync/, `${rel} must use atomicWriteFileSync`);
      assert.match(
        body,
        /readJsonFileSafe/,
        `${rel} must use readJsonFileSafe (corrupt-load must not silent-[] then wipe)`,
      );
      assert.doesNotMatch(
        body,
        /fs\.writeFileSync\s*\(/,
        `${rel} must not use non-atomic fs.writeFileSync`,
      );
    }
    for (const rel of arrayStores) {
      const body = readFileSync(join(ROOT, rel), 'utf8');
      assert.match(
        body,
        /readJsonFileSafe\s*<[^>]*>\s*\([^)]*Array\.isArray/,
        `${rel} must pass Array.isArray shape guard (wrong-shape must quarantine)`,
      );
    }
    for (const rel of objectStores) {
      const body = readFileSync(join(ROOT, rel), 'utf8');
      assert.match(
        body,
        /isPlainObjectJson/,
        `${rel} must use isPlainObjectJson shape guard (wrong-shape must quarantine)`,
      );
    }
    const refreshBody = readFileSync(join(ROOT, 'apps/api/src/refreshTokenStore.ts'), 'utf8');
    assert.match(
      refreshBody,
      /isRefreshStoreShape|isSignedEnvelope/,
      'refreshTokenStore must validate signed-or-array top-level shape',
    );
    const helper = readFileSync(join(ROOT, 'apps/api/src/atomicWrite.ts'), 'utf8');
    assert.match(
      helper,
      /isExpectedShape/,
      'readJsonFileSafe must support shape quarantine after parse OK',
    );
  });
});
