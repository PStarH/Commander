import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { projectHelmReleaseRevision } from './helm-release-projection.js';

const chartContentSha256 = 'b'.repeat(64);

describe('Helm release projection claim directory', () => {
  it('accepts a Secret-backed claim directory environment variable', () => {
    assert.doesNotThrow(() =>
      projectHelmReleaseRevision({
        namespace: 'commander',
        releaseName: 'commander',
        revision: '7',
        manifest: [
          'apiVersion: apps/v1',
          'kind: Deployment',
          'metadata:',
          '  name: commander-adapter-ops',
          '  namespace: commander',
          'spec:',
          '  template:',
          '    spec:',
          '      containers:',
          '        - name: adapter-ops',
          '          image: example.invalid/adapter-ops',
          '          env:',
          '            - name: COMMANDER_ADAPTER_OPS_CLAIM_SECRET_DIR',
          '              value: /var/run/commander/adapter-ops',
          '',
        ].join('\n'),
        values: 'tenantAuthority:\n  chartContentSha256: ' + chartContentSha256 + '\n',
      }),
    );
  });
});
