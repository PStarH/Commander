import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseWorkloadGuardRenderArgs } from './helm-render-tenant-authority-workload-guard.js';

describe('workload guard renderer CLI', () => {
  it('accepts only namespace, release, and the exact operator subject', () => {
    const args = [
      '--namespace',
      'commander',
      '--release',
      'release-a',
      '--migration-operator-subject',
      'system:serviceaccount:commander-ops:migration-operator',
    ];
    assert.deepEqual(parseWorkloadGuardRenderArgs(args), {
      namespace: 'commander',
      release: 'release-a',
      migrationOperatorSubject: 'system:serviceaccount:commander-ops:migration-operator',
    });
    assert.throws(
      () => parseWorkloadGuardRenderArgs([...args, '--values', '/tmp/values']),
      /TENANT_POLICY_CLI_ARGUMENT_INVALID/,
    );
  });
});
