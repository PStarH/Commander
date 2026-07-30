import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  runAdapterOpsReconciliationMock,
  runCellReconciliationE2E,
} from './l4-b-cell-reconciliation-e2e.js';

describe('l4-b-cell-reconciliation-e2e', () => {
  it('records one read-only outcome query and no retry of the remote write', async () => {
    const result = await runAdapterOpsReconciliationMock();
    assert.deepEqual(result.counters, {
      forwardWrites: 1,
      outcomeQueries: 1,
      duplicateWrites: 0,
    });
    assert.equal(result.effectState, 'COMPLETED');
  });

  it('caps same-process mock evidence at ENFORCED-script-only', async () => {
    const result = await runCellReconciliationE2E({ mode: 'mock' });
    assert.equal(result.passed, true);
    assert.equal(result.verdict, 'ENFORCED-script-only');
    assert.equal(JSON.stringify(result).includes('PROVEN'), false);
  });

  it('renders enterprise adapter-ops with a two-replica PDB', () => {
    const values = readFileSync(
      new URL('../deploy/helm/commander/values-enterprise.yaml', import.meta.url),
      'utf8',
    );
    const defaults = readFileSync(
      new URL('../deploy/helm/commander/values.yaml', import.meta.url),
      'utf8',
    );
    const pdb = readFileSync(
      new URL('../deploy/helm/commander/templates/pdb.yaml', import.meta.url),
      'utf8',
    );

    assert.match(values, /adapterOps:[\s\S]*?replicas:\s*2/);
    assert.match(
      defaults,
      /adapterOps:[\s\S]*?pdb:[\s\S]*?enabled:\s*false[\s\S]*?minAvailable:\s*1/,
    );
    assert.match(pdb, /component:\s*adapter-ops/);
    assert.match(pdb, /\.Values\.adapterOps\.pdb\.enabled/);
    assert.match(pdb, /minAvailable:\s*\{\{\s*\.Values\.adapterOps\.pdb\.minAvailable/);
  });
});
