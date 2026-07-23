import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DatasetVersionManager } from '../../../../src/plugins/builtin/eval/datasetVersionManager';
import { runWithTenant } from '../../../../src/runtime/tenantContext';

describe('DatasetVersionManager tenant isolation', () => {
  it('blocks foreign reads and mutations', () => {
    const manager = new DatasetVersionManager();
    const dataset = runWithTenant('tenant-a', () =>
      manager.create({
        name: 'tenant-a-private',
        cases: [{ id: 'case-1', input: 'question', expectedOutput: 'answer' }],
      }),
    );

    runWithTenant('tenant-b', () => {
      assert.deepEqual(manager.list(), []);
      assert.equal(manager.get(dataset.id), undefined);
      assert.deepEqual(manager.getCases(dataset.id), []);
      assert.equal(manager.delete(dataset.id), false);
      assert.throws(
        () => manager.addCases({ datasetId: dataset.id, cases: [] }),
        /Dataset not found/,
      );
      assert.throws(() => manager.rollback(dataset.id, 1), /Dataset not found/);
      assert.throws(() => manager.export(dataset.id), /Dataset not found/);
    });
  });
});
