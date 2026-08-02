import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { load } from 'js-yaml';

type WorkflowStep = {
  name?: string;
  run?: string;
  uses?: string;
  if?: string;
  with?: Record<string, string | number>;
};

type Workflow = {
  jobs?: Record<
    string,
    {
      'runs-on'?: string;
      'timeout-minutes'?: number;
      env?: Record<string, string>;
      steps?: WorkflowStep[];
    }
  >;
};

function moduleAWorkflow(): Workflow {
  return load(
    readFileSync(join(process.cwd(), '.github/workflows/module-a-ci.yml'), 'utf8'),
  ) as Workflow;
}

describe('Module A CI workflow', () => {
  it('uses a reproducible runner and preserves gate evidence on failure', () => {
    const workflow = moduleAWorkflow();
    const job = workflow.jobs?.['module-a-gates'];
    assert.ok(job, 'Module A workflow must define its gate job');
    assert.equal(job['runs-on'], 'ubuntu-latest');
    assert.equal(job['timeout-minutes'], 30);
    assert.equal(job.env?.COMMANDER_CI_EVIDENCE_DIR, '.internal/evidence/ci/module-a');

    const steps = job.steps ?? [];
    const setupPnpm = steps.find((step) => step.uses === 'pnpm/action-setup@v6');
    assert.equal(setupPnpm?.with?.version, '9.15.4');
    const setupNode = steps.find((step) => step.uses === 'actions/setup-node@v7');
    assert.equal(setupNode?.with?.['node-version'], '22');

    const install = steps.find((step) => step.name === 'Install locked dependencies');
    assert.equal(install?.run, 'pnpm install --frozen-lockfile');

    const gate = steps.find((step) => step.name === 'Run Module A gates');
    assert.equal(gate?.run, 'bash scripts/ci/module-a-gates.sh');

    const artifact = steps.find((step) => step.name === 'Upload Module A evidence');
    assert.equal(artifact?.if, 'always()');
    assert.equal(artifact?.uses, 'actions/upload-artifact@v4');
    assert.equal(artifact?.with?.path, '.internal/evidence/ci/module-a/');
  });

  it('keeps the gate runner executable and versioned in the repository', () => {
    const script = join(process.cwd(), 'scripts/ci/module-a-gates.sh');
    assert.equal(existsSync(script), true);
    assert.notEqual(statSync(script).mode & 0o111, 0);
    assert.match(readFileSync(script, 'utf8'), /overall_status=0/);
  });

  it('does not use the tsx IPC CLI for workflow test entrypoints', () => {
    for (const workflow of readdirSync(join(process.cwd(), '.github/workflows'))) {
      if (!workflow.endsWith('.yml') && !workflow.endsWith('.yaml')) continue;
      const source = readFileSync(join(process.cwd(), '.github/workflows', workflow), 'utf8');
      assert.doesNotMatch(
        source.replaceAll('node --import tsx --test', ''),
        /\btsx --test\b/,
        `${workflow} must use node --import tsx`,
      );
    }
  });

  it('uses pnpm for the pre-commit vitest smoke in pnpm workspaces', () => {
    const source = readFileSync(join(process.cwd(), 'scripts/precommitHook.ts'), 'utf8');
    assert.match(source, /execFileSync\(\s*'pnpm'/s);
    assert.doesNotMatch(source, /execFileSync\(\s*'npx'/s);
  });
});
