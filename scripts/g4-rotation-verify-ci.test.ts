import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { load } from 'js-yaml';

type WorkflowStep = {
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  env?: Record<string, string>;
  with?: Record<string, string>;
};

type Workflow = {
  permissions?: Record<string, string>;
  jobs?: Record<
    string,
    {
      'runs-on'?: string;
      environment?: string;
      needs?: string | string[];
      steps?: WorkflowStep[];
    }
  >;
};

function readWorkflow(): { source: string; workflow: Workflow } {
  const source = readFileSync(
    join(process.cwd(), '.github/workflows/g4-rotation-verify.yml'),
    'utf8',
  );
  return { source, workflow: load(source) as Workflow };
}

describe('G4 rotation-only CI workflow', () => {
  it('is an isolated GitHub-hosted workflow with a strict four-signature contract', () => {
    const { source, workflow } = readWorkflow();

    assert.match(source, /^on:\s*\n\s+workflow_dispatch:\s*$/m);
    assert.deepEqual(workflow.permissions, { contents: 'read' });

    const job = workflow.jobs?.['g4-rotation-verify'];
    assert.ok(job, 'workflow must define the g4-rotation-verify job');
    assert.equal(job['runs-on'], 'ubuntu-latest');
    assert.equal(job.environment, undefined);
    assert.equal(job.needs, undefined);

    const steps = job.steps ?? [];
    assert.equal(
      steps.find((step) => step.uses === 'actions/checkout@v6')?.uses,
      'actions/checkout@v6',
    );
    assert.equal(
      steps.find((step) => step.uses === 'pnpm/action-setup@v6')?.uses,
      'pnpm/action-setup@v6',
    );
    assert.equal(
      steps.find((step) => step.uses === 'actions/setup-node@v7')?.uses,
      'actions/setup-node@v7',
    );
    assert.equal(
      steps.find((step) => step.name === 'Install locked dependencies')?.run,
      'pnpm install --frozen-lockfile',
    );

    const importStep = steps.find((step) => step.name === 'Import authorized rotation public key');
    assert.ok(importStep, 'workflow must import the protected public key');
    assert.equal(
      importStep.env?.COMMANDER_GPG_PUBLIC_KEY_ASC,
      '${{ secrets.COMMANDER_GPG_PUBLIC_KEY_ASC }}',
    );
    assert.match(importStep.run ?? '', /GNUPGHOME=.*commander-g4-gnupg/);
    assert.match(importStep.run ?? '', /gpg --batch --import/);
    assert.match(importStep.run ?? '', />>\s*"\$GITHUB_ENV"/);
    assert.doesNotMatch(
      importStep.run ?? '',
      /PRIVATE|SECRET|echo\s+"?\$COMMANDER_GPG_PUBLIC_KEY_ASC/,
    );

    const verifyStep = steps.find((step) => step.name === 'Run strict rotation verification');
    assert.ok(verifyStep, 'workflow must run the rotation verifier');
    assert.match(verifyStep.run ?? '', /pnpm rotate:verify --json/);
    assert.match(verifyStep.run ?? '', /verified\s*!==\s*4/);
    assert.match(verifyStep.run ?? '', /failed\s*!==\s*0/);
    assert.match(verifyStep.run ?? '', /pending\s*!==\s*0/);

    const artifact = steps.find((step) => step.name === 'Upload sanitized rotation result');
    assert.ok(artifact, 'workflow must upload the sanitized result');
    assert.equal(artifact.if, 'always()');
    assert.equal(artifact.uses, 'actions/upload-artifact@v4');
    assert.match(artifact.with?.path ?? '', /g4-rotation-result\.json/);

    assert.doesNotMatch(source, /l4-b|commander-dr|COMMANDER_DR/i);
  });
});
