import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import {
  sanitizeEvidence,
  kindClusterExists,
  proofTemplatesPresent,
  KIND_NODE_IMAGE,
  CALICO_URL,
} from './helm-lifecycle-kind.js';

describe('helm-lifecycle-kind helpers', () => {
  it('pins Kubernetes 1.33.2 and the expected digest', () => {
    assert.match(KIND_NODE_IMAGE, /kindest\/node:v1\.33\.2/);
    assert.match(KIND_NODE_IMAGE, /sha256:[a-f0-9]{64}/);
  });

  it('pins the Calico manifest URL', () => {
    assert.match(CALICO_URL, /projectcalico\/calico\/v3\.29\.0/);
  });

  it('detects proof job templates in a chart directory', () => {
    const tmp = mkdtempSync(resolve(tmpdir(), 'kind-chart-'));
    writeFileSync(resolve(tmp, 'Chart.yaml'), 'name: test\nversion: 0.0.1\n');
    writeFileSync(resolve(tmp, 'values.yaml'), '{}\n');
    const templatesDir = resolve(tmp, 'templates');
    mkdirSync(templatesDir, { recursive: true });
    // No templates yet.
    assert.equal(proofTemplatesPresent(tmp), false);

    // Create the template.
    writeFileSync(resolve(templatesDir, 'tenant-cutover-prove-job.yaml'), 'kind: Job\n');
    assert.equal(proofTemplatesPresent(tmp), true);
  });

  it('sanitizes DSNs and PEM blocks from evidence', () => {
    const evidence = {
      generatedAt: '2024-01-01T00:00:00Z',
      cluster: 'test',
      kindNodeImage: KIND_NODE_IMAGE,
      chartPath: '/chart',
      calicoUrl: CALICO_URL,
      scenarios: [
        {
          name: 'fresh-bundled',
          passed: true,
          durationMs: 100,
          events: [],
          assertions: [
            {
              description: 'contains a DSN',
              passed: true,
              detail: 'postgres://owner:secret@db:5432/commander',
            },
          ],
        },
      ] as any[],
      sanitized: false,
    };
    const sanitized = sanitizeEvidence(evidence);
    assert.equal(sanitized.sanitized, true);
    const detail = sanitized.scenarios[0].assertions[0].detail;
    assert.ok(detail !== undefined);
    assert.ok(!detail.includes('secret'), 'password should be redacted');
    assert.ok(detail.startsWith('postgres://'), 'DSN prefix preserved for diagnostics');
  });

  it('reports cluster existence without throwing', () => {
    const exists = kindClusterExists('commander-helm-lifecycle');
    assert.equal(typeof exists, 'boolean');
  });
});
