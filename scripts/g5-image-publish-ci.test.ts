import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { load } from 'js-yaml';

type WorkflowStep = {
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, string | boolean>;
};

type Workflow = {
  permissions?: Record<string, string>;
  jobs?: Record<
    string,
    {
      'runs-on'?: string;
      needs?: string;
      outputs?: Record<string, string>;
      env?: Record<string, string>;
      steps?: WorkflowStep[];
    }
  >;
};

function readWorkflow(): { source: string; workflow: Workflow } {
  const source = readFileSync(
    join(process.cwd(), '.github/workflows/g5-image-publish.yml'),
    'utf8',
  );
  return { source, workflow: load(source) as Workflow };
}

describe('G5 GHCR image publisher', () => {
  it('publishes only immutable Gateway and Worker images from a validated SHA', () => {
    const { source, workflow } = readWorkflow();

    assert.match(source, /^on:\s*\n\s+workflow_dispatch:/m);
    assert.deepEqual(workflow.permissions, {
      contents: 'read',
      packages: 'write',
    });
    assert.match(source, /commit_sha:/);
    assert.match(source, /REQUESTED_SHA: \$\{\{ inputs\.commit_sha \}\}/);
    assert.match(source, /\[\[ ! "\$REQUESTED_SHA" =~ \^\[0-9a-f\]\{40\}\$ \]\]/);

    const validate = workflow.jobs?.validate;
    assert.ok(validate, 'workflow must validate the requested commit SHA before checkout');
    assert.equal(validate['runs-on'], 'ubuntu-latest');
    assert.match(validate.steps?.[0]?.run ?? '', /Invalid commit SHA/);

    const publish = workflow.jobs?.publish;
    assert.ok(publish, 'workflow must define a single publish job');
    assert.equal(publish['runs-on'], 'ubuntu-latest');
    assert.equal(publish.needs, 'validate');
    assert.equal(publish.env?.GATEWAY_IMAGE, 'ghcr.io/pstarh/commander-g5-gateway');
    assert.equal(publish.env?.WORKER_IMAGE, 'ghcr.io/pstarh/commander-g5-worker');

    const steps = publish.steps ?? [];
    assert.equal(
      steps.find((step) => step.uses === 'actions/checkout@v6')?.with?.ref,
      '${{ needs.validate.outputs.commit_sha }}',
    );
    assert.equal(
      steps.find((step) => step.uses === 'docker/login-action@v3')?.with?.registry,
      'ghcr.io',
    );

    const gateway = steps.find((step) => step.name === 'Build and push Gateway image');
    assert.equal(gateway?.uses, 'docker/build-push-action@v6');
    assert.equal(gateway?.with?.file, 'apps/api/Dockerfile');
    assert.equal(gateway?.with?.context, '.');
    assert.equal(gateway?.with?.push, true);
    assert.match(String(gateway?.with?.tags), /\$\{\{ env\.GATEWAY_IMAGE \}\}/);
    assert.equal(gateway?.with?.provenance, 'mode=max');

    const worker = steps.find((step) => step.name === 'Build and push Worker image');
    assert.equal(worker?.uses, 'docker/build-push-action@v6');
    assert.equal(worker?.with?.file, 'packages/worker-plane/Dockerfile');
    assert.equal(worker?.with?.context, '.');
    assert.equal(worker?.with?.push, true);
    assert.match(String(worker?.with?.tags), /\$\{\{ env\.WORKER_IMAGE \}\}/);
    assert.equal(worker?.with?.provenance, 'mode=max');

    const artifact = steps.find((step) => step.name === 'Upload image provenance');
    assert.equal(artifact?.uses, 'actions/upload-artifact@v4');
    assert.equal(artifact?.with?.name, 'g5-image-provenance');
    assert.equal(artifact?.with?.path, 'g5-image-provenance.json');

    assert.match(source, /org\.opencontainers\.image\.revision/);
    assert.doesNotMatch(source, /kubectl|kind |docker run|docker compose|KUBECONFIG/i);
  });
});
