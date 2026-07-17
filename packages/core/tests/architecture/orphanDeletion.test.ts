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

  it('lockFreeStateStore no longer exports a Store class', () => {
    const path = join(ROOT, 'packages/core/src/runtime/lockFreeStateStore.ts');
    assert.ok(existsSync(path), 'stub file may remain; class must not');
    const text = readFileSync(path, 'utf8');
    assert.doesNotMatch(
      text,
      /export class LockFreeStateStore/,
      'LockFreeStateStore class was removed as orphan 2026-07-15',
    );
  });

  it('does not reintroduce MemorySystem facade', () => {
    assert.equal(
      existsSync(join(ROOT, 'packages/core/src/memory/memorySystem.ts')),
      false,
      'MemorySystem facade deleted 2026-07-17 (0 product importers); namespaceGuard keeps MEMORY-001',
    );
  });

  it('plugin autoScorer is a re-export (sample of collapsed duplicates)', () => {
    const path = join(ROOT, 'packages/core/src/plugins/builtin/observability/autoScorer.ts');
    assert.ok(existsSync(path));
    const text = readFileSync(path, 'utf8');
    assert.match(text, /from ['"]\.\.\/\.\.\/\.\.\/observability\/autoScorer['"]/);
    assert.doesNotMatch(text, /^\s*export\s+class\s+AutoScorer\b/m);
  });

  it('plugin DatasetStore is a re-export, not a second class declaration', () => {
    const path = join(ROOT, 'packages/core/src/plugins/builtin/observability/dataset.ts');
    assert.ok(existsSync(path));
    const text = readFileSync(path, 'utf8');
    assert.doesNotMatch(
      text,
      /^\s*export\s+class\s+DatasetStore\b/m,
      'duplicate DatasetStore class must stay collapsed to re-export',
    );
    assert.match(text, /from ['"]\.\.\/\.\.\/\.\.\/observability\/dataset['"]/);
  });

  it('does not reintroduce apps/api episodicMemoryStore', () => {
    assert.equal(
      existsSync(join(ROOT, 'apps/api/src/episodicMemoryStore.ts')),
      false,
      'apps/api EpisodicMemoryStore was health-only zombie; deleted 2026-07-15 Phase B',
    );
  });

  it('architecture-gate config no longer exempts episodicMemoryStore', () => {
    const cfgPath = join(ROOT, 'scripts/architecture-gate.config.json');
    assert.ok(existsSync(cfgPath));
    const text = readFileSync(cfgPath, 'utf8');
    assert.doesNotMatch(text, /episodicMemoryStore/);
  });

  it('does not reintroduce deleted memory backends', () => {
    const deletedPaths = [
      'packages/core/src/memory/jsonStore.ts',
      'packages/core/src/memory/sqliteMemoryStore.ts',
      'apps/api/src/memoryStore.ts',
      'apps/api/src/namespacedMemoryStore.ts',
    ];
    for (const relativePath of deletedPaths) {
      assert.equal(
        existsSync(join(ROOT, relativePath)),
        false,
        `${relativePath} was deleted during memory consolidation; do not reintroduce it`,
      );
    }
  });

  it('runtime memory wiring has no legacy backend symbols', () => {
    const files = [
      join(ROOT, 'packages/core/src/memory/utils.ts'),
      join(ROOT, 'apps/api/src/namespacedMemoryEndpoints.ts'),
    ];
    for (const file of files) {
      assert.ok(existsSync(file));
      assert.doesNotMatch(
        readFileSync(file, 'utf8'),
        /JsonMemoryStore|SqliteMemoryStore|InMemoryMemoryStore|NamespacedMemoryStore/,
        `${file} contains a deleted memory backend symbol`,
      );
    }
  });
});
