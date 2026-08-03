import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { load } from 'js-yaml';

const PROJECT_FINGERPRINT = '46F79055E17F2356DC4BFDFD09D0DB9C03667BEE';
const PROJECT_SHORT_FINGERPRINT = '09D0DB9C03667BEE';

describe('provisional sign-off key binding', () => {
  it('binds both CI imports to the replacement project fingerprint', () => {
    const workflow = readFileSync(join(process.cwd(), '.github/workflows/ci.yml'), 'utf8');
    const matches = workflow.match(new RegExp(PROJECT_FINGERPRINT, 'g')) ?? [];
    assert.equal(matches.length, 2);
    assert.equal(workflow.includes('C489A6C6865F81B690408C5B12AA1940B17D9448'), false);
  });

  it('marks all four policy rows as provisional project bindings', () => {
    const policy = readFileSync(join(process.cwd(), 'docs/security/keys-rotation.md'), 'utf8');
    assert.match(policy, /PROVISIONAL PRE-RELEASE BINDING \(not a human approval\)/);
    assert.match(policy, /does \*\*not\*\* represent four independent human approvals/);
    assert.match(policy, /Formal release remains blocked/);
    assert.equal((policy.match(new RegExp(PROJECT_SHORT_FINGERPRINT, 'g')) ?? []).length, 4);
  });

  it('keeps the deploy gate after the key import step', () => {
    const workflow = load(readFileSync(join(process.cwd(), '.github/workflows/ci.yml'), 'utf8')) as {
      jobs: Record<string, { steps: Array<{ name?: string }> }>;
    };
    const steps = workflow.jobs['l4-b-deploy-gates']?.steps ?? [];
    const importIndex = steps.findIndex((step) => step.name === 'Import authorized rotation sign-off key');
    const gateIndex = steps.findIndex((step) => step.name === 'Deploy gates (pnpm test:deploy-gates)');
    assert.ok(importIndex >= 0);
    assert.ok(gateIndex > importIndex);
  });
});
