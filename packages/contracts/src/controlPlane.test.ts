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

const identity: WorkloadIdentity = {
  workloadId: 'worker-1',
  tenantId: 'tenant-1',
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

test('exports migrated control-plane contracts without a runtime dependency', () => {
  assert.equal(identity.tenantId, 'tenant-1');
  assert.equal(decision.effect, 'require_approval');
  assert.equal(audit.type, 'effect.admitted');
  assert.equal(effect, 'allow');
  assert.equal(sandbox, 'required');
  assert.equal(CONTROL_PLANE_API_VERSION, 'v2');
  assert.deepEqual(CONTROL_PLANE_RESOURCES, ['identity', 'tenant', 'policy', 'audit', 'registry']);
});
