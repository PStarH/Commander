import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { load } from 'js-yaml';

type Step = {
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
};
type Workflow = {
  on: { workflow_dispatch: { inputs: Record<string, { default: unknown }> } };
  jobs: Record<
    string,
    { if?: string; environment?: string; permissions?: Record<string, string>; steps: Step[] }
  >;
};
const ci = load(
  readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'),
) as Workflow;

describe('GitHub launch CI evidence boundaries', () => {
  it('keeps sandbox credentials behind explicit dispatch and a named environment', () => {
    const job = ci.jobs['github-sandbox-adapter'];
    assert.ok(job, 'GitHub sandbox adapter job must exist');
    assert.equal(ci.on.workflow_dispatch.inputs.run_github_live_proof?.default, false);
    assert.equal(
      job.if,
      "github.event_name == 'workflow_dispatch' && inputs.run_github_live_proof",
    );
    assert.equal(job.environment, 'github-sandbox');
    assert.deepEqual(job.permissions, { contents: 'read' });
    const mint = job.steps.find((step) =>
      step.uses?.startsWith('actions/create-github-app-token@'),
    );
    assert.ok(mint);
    assert.equal(mint.with?.repositories, '${{ vars.GITHUB_TEST_REPO }}');
    assert.equal(mint.with?.['permission-pull-requests'], 'write');
    assert.equal(
      mint.with?.['permission-contents'],
      undefined,
      'preparing branches must not grant the agent contents write',
    );
  });

  it('opts into both live scenarios and retains their actual exit status', () => {
    const job = ci.jobs['github-sandbox-adapter'];
    assert.ok(job);
    const proof = job.steps.find((step) => step.name === 'Run real GitHub adapter scenarios');
    assert.ok(proof);
    assert.equal(proof.env?.LIVE_GITHUB, '1');
    assert.equal(proof.env?.LIVE_GITHUB_RESPONSE_CUT, '1');
    assert.match(proof.run ?? '', /github\.live\.test\.ts/);
    assert.doesNotMatch(proof.run ?? '', /\|\|\s*(?:true|echo)/);
    assert.match(proof.run ?? '', /GITHUB_SHA/);
    const upload = job.steps.find((step) => step.uses?.startsWith('actions/upload-artifact@'));
    assert.equal(upload?.with?.['if-no-files-found'], 'error');
  });

  it('registers the credential-free regression and demo tests in ordinary CI', () => {
    const job = ci.jobs['github-launch-contract'];
    assert.ok(job);
    assert.equal(job.if, undefined);
    assert.ok(job.steps.some((step) => step.run?.includes('pnpm test:github:offline')));
    assert.doesNotMatch(JSON.stringify(job), /secrets\./);
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      scripts: Record<string, string>;
    };
    assert.match(pkg.scripts['test:github:offline'] ?? '', /github-action-demo\.test\.ts/);
    assert.match(pkg.scripts['test:github:offline'] ?? '', /github-launch-ci\.test\.ts/);
    assert.doesNotMatch(pkg.scripts['test:github:offline'] ?? '', /github\.live\.test\.ts/);
  });

  it('runs the full recovery proof only in the disposable cell runtime job', () => {
    const job = ci.jobs['l4-b-cell-runtime'];
    assert.ok(job);
    const proof = job.steps.find((step) =>
      step.name?.includes('GitHub recovery through real Gateway'),
    );
    assert.ok(proof);
    assert.equal(proof.run, 'pnpm cell:github-recovery --up');
    assert.match(proof.name ?? '', /synthetic provider/);
    assert.ok(job.steps.some((step) => step.uses?.startsWith('actions/upload-artifact@')));
  });

  it('keeps the independent provider oracle credential outside execution services', () => {
    const compose = load(
      readFileSync(new URL('../docker-compose.cell-e2e.yml', import.meta.url), 'utf8'),
    ) as { services: Record<string, { environment: Record<string, string> }> };
    assert.match(
      compose.services['github-fixture']!.environment.CELL_GITHUB_ORACLE_TOKEN ?? '',
      /\?set CELL_GITHUB_ORACLE_TOKEN/,
    );
    for (const service of ['worker', 'adapter-ops']) {
      assert.doesNotMatch(JSON.stringify(compose.services[service]), /ORACLE_TOKEN/);
    }
  });
});
