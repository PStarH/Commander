import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

const internalPaths = [
  '.internal/docs/plans/2026-07-30-abcde-execution-runbook.md',
  '.internal/customer-discovery/e-launch-gated-research.md',
  'docs/runbooks/design-partner-launch-readiness.md',
  'PRIVACY.md',
];
const missingPaths = internalPaths.filter((path) => !existsSync(resolve(process.cwd(), path)));
const skipIfPublicCheckout =
  missingPaths.length > 0 ? `internal docs unavailable: ${missingPaths.join(', ')}` : false;

test(
  'A-E remains authoritative and E0 starts before technical readiness completes',
  { skip: skipIfPublicCheckout },
  () => {
    const aeRunbook = readWorkspaceFile(internalPaths[0]);
    const technicalReadiness = readWorkspaceFile(internalPaths[2]);
    assert.match(aeRunbook, /E0 starts immediately/);
    assert.match(aeRunbook, /G1-G8 gates do not block E0 contact/);
    assert.match(technicalReadiness, /G1-G8 are technical readiness gates for E1/);
    assert.match(technicalReadiness, /not prerequisites for first customer contact/);
  },
);

test(
  'customer discovery separates contact, shadow, and governed writes',
  { skip: skipIfPublicCheckout },
  () => {
    const customerDiscovery = readWorkspaceFile(internalPaths[1]);
    assert.match(customerDiscovery, /E0-CONTACT/);
    assert.match(customerDiscovery, /E0-SHADOW/);
    assert.match(customerDiscovery, /立即开始少量、具体/);
    assert.match(customerDiscovery, /E1 仍必须等待/);
    assert.doesNotMatch(customerDiscovery, /no outreach.*before public launch/i);
    assert.doesNotMatch(customerDiscovery, /访谈只在 launch 后开始/);
  },
);

test(
  'privacy requires explicit training consent and supports withdrawal and deletion',
  { skip: skipIfPublicCheckout },
  () => {
    const privacy = readWorkspaceFile(internalPaths[3]);
    assert.match(privacy, /does not imply consent\s+to model training/);
    assert.match(privacy, /explicit tenant-scoped\s+opt-in/);
    assert.match(privacy, /No training\s+dataset is exported by default/);
    assert.match(privacy, /Withdrawal and deletion/);
  },
);

test(
  'governed rollback benchmark wording matches command availability',
  { skip: skipIfPublicCheckout },
  () => {
    const technicalReadiness = readWorkspaceFile(internalPaths[2]);
    const packageJson = JSON.parse(readWorkspaceFile('package.json')) as {
      scripts?: Record<string, unknown>;
    };
    const commandExists = typeof packageJson.scripts?.['benchmark:governed-rollback'] === 'string';

    if (commandExists) {
      assert.doesNotMatch(technicalReadiness, /planned command and does not exist yet/);
    } else {
      assert.match(technicalReadiness, /planned command and does not exist yet/);
    }
  },
);
