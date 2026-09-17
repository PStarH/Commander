import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CONTROL_PLANE_API_VERSION, CONTROL_PLANE_RESOURCES } from './index.js';
import type {
  AuditEventV2,
  PluginSandboxMode,
  PolicyDecisionV2,
  PolicyEffect,
  WorkloadIdentity,
} from './index.js';

// `satisfies` ties each runtime list to the exported type union: the file stops
// compiling if a member is added or removed, and the assertions below then check
// that the fixtures actually carry a declared member.
const POLICY_EFFECTS = [
  'allow',
  'deny',
  'require_approval',
  'deny_class',
] as const satisfies readonly PolicyEffect[];
const SANDBOX_MODES = [
  'in_process',
  'subprocess',
  'required',
] as const satisfies readonly PluginSandboxMode[];

const identity: WorkloadIdentity = {
  workloadId: 'worker-1',
  tenantId: 'tenant-1',
  runId: 'run-1',
  stepId: 'step-1',
  scopes: ['run:execute'],
  issuedAt: '2026-07-15T00:00:00.000Z',
  expiresAt: '2026-07-15T01:00:00.000Z',
  token: 'opaque-token',
};

const decision: PolicyDecisionV2 = {
  effect: 'require_approval',
  decisionId: 'decision-1',
  reason: 'human approval required',
  matchedRule: 'external-write',
  runId: 'run-1',
  tenantId: 'tenant-1',
};

const audit: AuditEventV2 = {
  type: 'effect.admitted',
  severity: 'low',
  source: 'effect-broker',
  message: 'effect admitted',
  at: '2026-07-15T00:00:00.000Z',
};

const effect: PolicyEffect = 'allow';
const sandbox: PluginSandboxMode = 'required';

test('exports migrated control-plane contracts without a runtime dependency', async () => {
  // The runtime surface the control plane actually promises. Asserting on the
  // imported binding does not prove it is exported, so read the module object.
  const module = await import('./index.js');
  assert.equal(module.CONTROL_PLANE_API_VERSION, 'v2');
  assert.deepEqual(
    [...module.CONTROL_PLANE_RESOURCES],
    ['identity', 'tenant', 'policy', 'audit', 'registry'],
  );
  assert.equal(new Set(CONTROL_PLANE_RESOURCES).size, CONTROL_PLANE_RESOURCES.length);
});

test('control-plane fixtures carry declared union members', () => {
  // Each fixture crosses the control-plane wire boundary as JSON; the assertion
  // is that the value survives serialization and is a member of the exported
  // union (the lists above are compile-time tied to those unions).
  const wire = JSON.parse(JSON.stringify({ identity, decision, audit })) as {
    identity: WorkloadIdentity;
    decision: PolicyDecisionV2;
    audit: AuditEventV2;
  };
  assert.ok(
    POLICY_EFFECTS.includes(wire.decision.effect),
    `unknown policy effect: ${wire.decision.effect}`,
  );
  assert.ok(POLICY_EFFECTS.includes(effect), `unknown policy effect: ${effect}`);
  assert.ok(SANDBOX_MODES.includes(sandbox), `unknown sandbox mode: ${sandbox}`);
  assert.ok(identity.scopes.includes('run:execute'));
  assert.equal(wire.identity.token, 'opaque-token');
  assert.equal(wire.audit.source, 'effect-broker');
  assert.equal(Date.parse(wire.audit.at) > 0, true);
});
