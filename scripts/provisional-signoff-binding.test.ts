import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const PROJECT_SHORT_FINGERPRINT = '09D0DB9C03667BEE';

test('policy records the project key as four provisional technical rows', () => {
  const policy = readFileSync(join(process.cwd(), 'docs/security/keys-rotation.md'), 'utf8');

  assert.match(policy, /PROVISIONAL PRE-RELEASE BINDING \(not a human approval\)/);
  assert.match(
    policy,
    /does \*\*not\*\* represent four independent human approvals or Authority Closure/,
  );
  assert.match(policy, /Formal release remains blocked/);
  assert.equal((policy.match(new RegExp(PROJECT_SHORT_FINGERPRINT, 'g')) ?? []).length, 4);
});
