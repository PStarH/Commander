import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { describe, it } from 'node:test';

function renderDemoChart(): string {
  return execFileSync(
    'helm',
    [
      'template',
      'cell-demo',
      'deploy/helm/commander',
      '-f',
      'deploy/helm/commander/values-demo.yaml',
      '--set',
      'image.tag=test',
      '--set',
      'tenantAuthority.proofOwnerSecret=cell-demo-proof-owner-r1',
      '--set',
      'tenantAuthority.releaseProjectionConfigMap=cell-demo-projection',
    ],
    { encoding: 'utf8' },
  );
}

function deployment(rendered: string, component: string): string {
  return (
    rendered
      .split(/^---\s*$/m)
      .find(
        (document) =>
          /^kind:\s*Deployment$/m.test(document) &&
          new RegExp(`app\\.kubernetes\\.io/component:\\s*${component}`).test(document),
      ) ?? ''
  );
}

describe('signed evidence deployment wiring', () => {
  it('mounts a dedicated evidence signing secret only into effect-writing runtimes', () => {
    const rendered = renderDemoChart();
    const worker = deployment(rendered, 'worker');
    const adapterOps = deployment(rendered, 'adapter-ops');
    const api = deployment(rendered, 'api');

    for (const runtime of [worker, adapterOps]) {
      assert.match(runtime, /COMMANDER_EVIDENCE_SIGNING_PRIVATE_KEY_PEM/);
      assert.match(runtime, /COMMANDER_EVIDENCE_SIGNING_KEY_ID/);
      assert.match(runtime, /secretKeyRef:[\s\S]*cell-demo-evidence-signing/);
    }
    assert.doesNotMatch(api, /COMMANDER_EVIDENCE_SIGNING_PRIVATE_KEY_PEM/);
    assert.doesNotMatch(api, /COMMANDER_EVIDENCE_SIGNING_KEY_ID/);
    assert.match(rendered, /name:\s*cell-demo-evidence-signing/);
  });
});
