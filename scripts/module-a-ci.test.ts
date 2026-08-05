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

function qualityWorkflow(): Workflow {
  return load(readFileSync(join(process.cwd(), '.github/workflows/ci.yml'), 'utf8')) as Workflow;
}

describe('Module A CI workflow', () => {
  it('declares architecture-gate runtime dependencies at the workspace root', () => {
    const packageJson = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
      devDependencies?: Record<string, string>;
    };
    assert.ok(
      packageJson.devDependencies?.typescript,
      'workspace root must declare typescript because architecture-gate imports it directly',
    );
  });

  it('builds postgres-runtime before the clean core typecheck', () => {
    const quality = qualityWorkflow().jobs?.quality;
    assert.ok(quality, 'Quality workflow must define its quality job');
    const coreTypecheck = quality.steps?.find((step) => step.name === 'TypeScript check (core)');
    assert.match(
      coreTypecheck?.run ?? '',
      /pnpm --filter @commander\/postgres-runtime build[\s\S]*pnpm --filter @commander\/core exec tsc --noEmit/,
      'clean core typecheck must build postgres-runtime declarations first',
    );
  });

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

  it('masks generated cell secrets', () => {
    const job = qualityWorkflow().jobs?.['l4-b-cell-runtime'];
    assert.ok(job, 'Quality workflow must define the L4-B Cell Runtime job');
    const generate = job.steps?.find((step) => step.name === 'Generate cell compose secrets');
    assert.match(generate?.run ?? '', /::add-mask::/);
    for (const name of [
      'POSTGRES_PASSWORD',
      'COMMANDER_API_KEY',
      'COMMANDER_MASTER_KEY',
      'JWT_SECRET',
      'COMMANDER_CAPABILITY_TOKEN_KEY',
      'COMMANDER_INTEGRITY_KEY',
      'COMMANDER_WORKER_AUTH_TOKEN',
    ]) {
      assert.match(generate?.run ?? '', new RegExp(`write_masked_env ${name} `));
    }
  });

  it('always tears down the cell compose topology', () => {
    const job = qualityWorkflow().jobs?.['l4-b-cell-runtime'];
    assert.ok(job, 'Quality workflow must define the L4-B Cell Runtime job');
    const teardown = job.steps?.find((step) => step.name === 'Tear down cell compose');
    assert.equal(teardown?.if, 'always()');
    assert.equal(teardown?.run, 'pnpm cell:down');
  });

  it('captures failed cell service logs before teardown', () => {
    const job = qualityWorkflow().jobs?.['l4-b-cell-runtime'];
    assert.ok(job, 'Quality workflow must define the L4-B Cell Runtime job');
    const flowIndex = job.steps?.findIndex(
      (step) => step.name === 'Cell compensation E2E compose (C3)',
    );
    const diagnosticsIndex = job.steps?.findIndex(
      (step) => step.name === 'Capture cell failure diagnostics',
    );
    const teardownIndex = job.steps?.findIndex((step) => step.name === 'Tear down cell compose');
    const flow = job.steps?.[flowIndex ?? -1];
    const diagnostics = job.steps?.[diagnosticsIndex ?? -1];

    assert.equal(flow?.run, 'pnpm cell:compensation-e2e -- --mode compose');
    assert.equal(diagnostics?.if, 'failure()');
    assert.match(diagnostics?.run ?? '', /com\.docker\.compose\.service/);
    assert.match(diagnostics?.run ?? '', /docker logs/);
    assert.ok((flowIndex ?? -1) < (diagnosticsIndex ?? -1));
    assert.ok((diagnosticsIndex ?? -1) < (teardownIndex ?? -1));
  });
});
