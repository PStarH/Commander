import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DESIGN_PARTNER_FAULT_POINTS,
  DESIGN_PARTNER_SCENARIOS,
  validateCampaignObservation,
  type DesignPartnerCampaignObservation,
} from './design-partner-faults.js';

function completeObservation(): DesignPartnerCampaignObservation {
  return {
    schema: 'commander-design-partner-campaign/v1',
    startedAt: '2026-07-29T00:00:00.000Z',
    endedAt: '2026-07-29T00:05:00.000Z',
    driver: {
      boundary: 'external-process',
      identity: 'container:fault-driver-1',
    },
    topology: {
      backend: 'postgresql',
      processIdentities: {
        gateway: 'container:gateway-1',
        kernelOps: 'container:kernel-ops-1',
        adapterOps: 'container:adapter-ops-1',
        worker: 'container:worker-1',
        verifier: 'container:verifier-1',
      },
      databaseRoles: [
        'commander_owner',
        'commander_app',
        'commander_tenant_authority',
        'commander_scheduler',
        'commander_worker',
        'commander_adapter_ops',
      ],
      externalSystem: { mode: 'real', identitySha256: 'a'.repeat(64) },
      standardClientPath: true,
    },
    faultPoints: [...DESIGN_PARTNER_FAULT_POINTS],
    scenarios: DESIGN_PARTNER_SCENARIOS.map((scenario) => ({
      id: scenario.id,
      passed: true,
      expectedExternalWrites: scenario.expectedExternalWrites,
      observedExternalWrites: scenario.expectedExternalWrites,
      observedOutcomeQueries: scenario.requiresOutcomeQuery ? 1 : 0,
      terminalDisposition: scenario.allowedTerminalDispositions[0],
      receiptVerified: true,
      evidencePersisted: true,
      reconciliationLatencyMs: scenario.requiresOutcomeQuery ? 1_000 : 0,
    })),
  };
}

describe('design-partner fault campaign contract', () => {
  it('contains every proof-standard scenario and lifecycle fault point exactly once', () => {
    assert.deepEqual(
      DESIGN_PARTNER_SCENARIOS.map(({ id }) => id),
      [
        'tenant_isolation',
        'identity',
        'policy_binding',
        'approval_binding',
        'mutation_resistance',
        'lease_fencing',
        'idempotency',
        'ambiguous_completion',
        'confirmed_not_applied',
        'irreducible_unknown',
        'compensation',
        'kill_switch',
        'evidence',
        'recovery',
        'backup_restore',
      ],
    );
    assert.deepEqual(DESIGN_PARTNER_FAULT_POINTS, [
      'before_remote_request',
      'after_remote_commit',
      'before_local_complete',
      'during_outcome_query',
      'during_compensation',
      'during_evidence_persist',
    ]);
    assert.equal(new Set(DESIGN_PARTNER_SCENARIOS.map(({ id }) => id)).size, 15);
    assert.equal(new Set(DESIGN_PARTNER_FAULT_POINTS).size, 6);
  });

  it('accepts only a complete campaign with exact write bounds and verified evidence', () => {
    assert.deepEqual(validateCampaignObservation(completeObservation()), []);
  });

  it('rejects missing, duplicate, over-writing, unqueried, and unverifiable scenarios', () => {
    const missing = completeObservation();
    missing.scenarios.pop();
    assert.ok(validateCampaignObservation(missing).includes('SCENARIO_MISSING:backup_restore'));

    const duplicate = completeObservation();
    duplicate.scenarios.push({ ...duplicate.scenarios[0]! });
    assert.ok(
      validateCampaignObservation(duplicate).includes('SCENARIO_DUPLICATE:tenant_isolation'),
    );

    const overWrite = completeObservation();
    overWrite.scenarios.find(({ id }) => id === 'ambiguous_completion')!.observedExternalWrites = 2;
    assert.ok(
      validateCampaignObservation(overWrite).includes(
        'SCENARIO_EXTERNAL_WRITE_COUNT_INVALID:ambiguous_completion',
      ),
    );

    const unqueried = completeObservation();
    unqueried.scenarios.find(({ id }) => id === 'ambiguous_completion')!.observedOutcomeQueries = 0;
    assert.ok(
      validateCampaignObservation(unqueried).includes(
        'SCENARIO_OUTCOME_QUERY_REQUIRED:ambiguous_completion',
      ),
    );

    const unverifiable = completeObservation();
    unverifiable.scenarios.find(({ id }) => id === 'evidence')!.receiptVerified = false;
    assert.ok(
      validateCampaignObservation(unverifiable).includes('SCENARIO_RECEIPT_UNVERIFIED:evidence'),
    );
  });
});
