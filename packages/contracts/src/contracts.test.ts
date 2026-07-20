import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import {
  CONTRACTS_VERSION,
  CONTRACT_SCHEMAS,
  CONTRACT_VERSION,
  KERNEL_ERROR_CODES,
  OPENAPI_V1_SPEC,
  RUN_STATES,
  STEP_STATES,
  TERMINAL_RUN_STATES,
  TERMINAL_STEP_STATES,
  detectBreakingChanges,
  isCompatibleSchemaVersion,
  isTerminalRunState,
  isTerminalStepState,
  isValidRunTransition,
  isValidStepTransition,
  snapshotContracts,
  validateRunTransition,
  validateStepTransition,
} from './index.js';

describe('@commander/contracts state machine', () => {
  it('has stable canonical run states', () => {
    assert.deepStrictEqual(RUN_STATES, [
      'PENDING',
      'RUNNING',
      'PAUSED',
      'SUCCEEDED',
      'FAILED',
      'CANCELLED',
      'COMPENSATING',
      'COMPENSATED',
    ]);
  });

  it('has stable canonical step states', () => {
    assert.deepStrictEqual(STEP_STATES, [
      'PENDING',
      'RUNNING',
      'WAITING_FOR_HUMAN',
      'RETRY_WAIT',
      'SUCCEEDED',
      'FAILED',
      'CANCELLED',
      'SKIPPED',
    ]);
  });

  it('rejects terminal state transitions', () => {
    for (const state of TERMINAL_RUN_STATES) {
      assert.equal(isValidRunTransition(state, 'RUNNING'), false);
      assert.equal(validateRunTransition(state, 'RUNNING').ok, false);
    }
    for (const state of TERMINAL_STEP_STATES) {
      assert.equal(isValidStepTransition(state, 'RUNNING'), false);
      assert.equal(validateStepTransition(state, 'RUNNING').ok, false);
    }
  });

  it('allows valid pause/resume/cancel transitions', () => {
    assert.equal(isValidRunTransition('PENDING', 'PAUSED'), true);
    assert.equal(isValidRunTransition('RUNNING', 'PAUSED'), true);
    assert.equal(isValidRunTransition('PAUSED', 'RUNNING'), true);
    assert.equal(isValidRunTransition('RUNNING', 'CANCELLED'), true);
    assert.equal(isValidRunTransition('PAUSED', 'CANCELLED'), true);
    assert.equal(isValidRunTransition('PENDING', 'CANCELLED'), true);
  });

  it('allows timer deadlines to fail non-terminal waiting steps', () => {
    assert.equal(validateStepTransition('PENDING', 'FAILED').ok, true);
    assert.equal(validateStepTransition('RETRY_WAIT', 'FAILED').ok, true);
    assert.equal(validateStepTransition('WAITING_FOR_HUMAN', 'FAILED').ok, true);
    assert.equal(validateStepTransition('FAILED', 'RUNNING').ok, false);
  });

  it('allows an answered human interaction to release its waiting step', () => {
    assert.equal(validateStepTransition('WAITING_FOR_HUMAN', 'RETRY_WAIT').ok, true);
  });

  it('allows deadlines to fail runs before execution or while paused', () => {
    assert.equal(validateRunTransition('PENDING', 'FAILED').ok, true);
    assert.equal(validateRunTransition('PAUSED', 'FAILED').ok, true);
  });

  it('classifies terminal states correctly', () => {
    for (const state of RUN_STATES) {
      assert.equal(isTerminalRunState(state), TERMINAL_RUN_STATES.has(state));
    }
    for (const state of STEP_STATES) {
      assert.equal(isTerminalStepState(state), TERMINAL_STEP_STATES.has(state));
    }
  });

  it('rejects invalid run transitions', () => {
    assert.equal(isValidRunTransition('PENDING', 'SUCCEEDED'), false);
    assert.equal(isValidRunTransition('SUCCEEDED', 'PENDING'), false);
    assert.equal(isValidRunTransition('FAILED', 'RUNNING'), false);
  });
});

describe('@commander/contracts resources', () => {
  it('exports all 15 canonical resources', () => {
    const resourceSchemas = [
      'organization',
      'project',
      'environment',
      'principal',
      'run',
      'step',
      'workGraph',
      'interaction',
      'artifact',
      'policyBundle',
      'worker',
      'effect',
      'agentDefinition',
      'toolDefinition',
      'connectorDefinition',
    ];
    for (const key of resourceSchemas) {
      assert.ok(key in CONTRACT_SCHEMAS, `Schema ${key} missing from CONTRACT_SCHEMAS`);
      const schema = CONTRACT_SCHEMAS[key as keyof typeof CONTRACT_SCHEMAS] as { $id?: string };
      assert.match(schema.$id ?? '', /\/v2\//, `${key} schema $id must reference v2`);
    }
    assert.equal(resourceSchemas.length, 15);
    const snap = snapshotContracts();
    assert.equal(Object.keys(snap.contracts).length, 5);
    assert.equal(snap.packageVersion, 'v2');
  });
});

describe('@commander/contracts event envelope', () => {
  it('uses tenantId (not tenant) per ADR 007', () => {
    // Verify the field is named tenantId by checking the schema.
    const eventSchema = CONTRACT_SCHEMAS.kernelEvent;
    const props = (eventSchema as any).properties;
    assert.ok(props.tenantId, 'kernelEvent schema must have tenantId property');
    assert.equal(props.tenant, undefined, 'kernelEvent schema must NOT have tenant property');
  });
});

describe('@commander/contracts JSON schemas', () => {
  it('has schemas for all resources + event + error', () => {
    const expected = [
      'organization',
      'project',
      'environment',
      'principal',
      'run',
      'step',
      'workGraph',
      'interaction',
      'artifact',
      'policyBundle',
      'worker',
      'effect',
      'agentDefinition',
      'toolDefinition',
      'connectorDefinition',
      'kernelEvent',
      'kernelError',
    ];
    for (const name of expected) {
      assert.ok(name in CONTRACT_SCHEMAS, `Schema ${name} missing from CONTRACT_SCHEMAS`);
    }
    assert.equal(Object.keys(CONTRACT_SCHEMAS).length, expected.length);
  });

  it('each schema has $id, type, required, and properties', () => {
    for (const [name, schema] of Object.entries(CONTRACT_SCHEMAS)) {
      const s = schema as any;
      assert.ok(s.$id, `Schema ${name} missing $id`);
      assert.ok(s.type, `Schema ${name} missing type`);
      assert.ok(Array.isArray(s.required), `Schema ${name} missing required array`);
      assert.ok(s.properties && typeof s.properties === 'object', `Schema ${name} missing properties`);
    }
  });

  it('run schema enforces uppercase state enum', () => {
    const runSchema = CONTRACT_SCHEMAS.run as any;
    const stateEnum = runSchema.properties.state.enum;
    assert.deepStrictEqual(stateEnum, [...RUN_STATES]);
  });

  it('step schema enforces uppercase state enum', () => {
    const stepSchema = CONTRACT_SCHEMAS.step as any;
    const stateEnum = stepSchema.properties.state.enum;
    assert.deepStrictEqual(stateEnum, [...STEP_STATES]);
  });

  it('effect schema has four durable effect statuses', () => {
    const effectSchema = CONTRACT_SCHEMAS.effect as any;
    const statuses = effectSchema.properties.status.enum;
    assert.deepStrictEqual(statuses, ['ADMITTED', 'COMPLETION_UNKNOWN', 'COMPLETED', 'FAILED']);
  });

  it('connector schema has data classification enum', () => {
    const connectorSchema = CONTRACT_SCHEMAS.connectorDefinition as any;
    const classifications = connectorSchema.properties.dataClassification.enum;
    assert.ok(classifications.includes('pii'));
    assert.ok(classifications.includes('phi'));
  });
});

describe('@commander/contracts OpenAPI V1 spec', () => {
  it('has correct metadata', () => {
    assert.equal(OPENAPI_V1_SPEC.openapi, '3.1.0');
    assert.equal(OPENAPI_V1_SPEC.info.title, 'Commander V1 Resource API');
  });

  it('has paths for all V1 resources', () => {
    const pathKeys = Object.keys(OPENAPI_V1_SPEC.paths);
    assert.ok(pathKeys.some((p) => p.includes('/runs')));
    assert.ok(pathKeys.some((p) => p.includes('/runs/{runId}/steps')));
    assert.ok(pathKeys.some((p) => p.includes('/runs/{runId}/workgraph')));
    assert.ok(pathKeys.some((p) => p.includes('/interactions')));
    assert.ok(pathKeys.some((p) => p.includes('/artifacts')));
    assert.ok(pathKeys.some((p) => p.includes('/effects')));
    assert.ok(pathKeys.some((p) => p.includes('/policy-bundles')));
    assert.ok(pathKeys.some((p) => p.includes('/agents')));
    assert.ok(pathKeys.some((p) => p.includes('/tools')));
    assert.ok(pathKeys.some((p) => p.includes('/connectors')));
  });

  it('run creation returns 202 (async)', () => {
    const runPost = (OPENAPI_V1_SPEC.paths as any)['/runs'].post;
    assert.ok('202' in runPost.responses, 'POST /runs must have 202 response');
  });

  it('uses ApiKeyAuth and requires Idempotency-Key on writes', () => {
    assert.ok('ApiKeyAuth' in (OPENAPI_V1_SPEC.components as any).securitySchemes);
    const runPost = (OPENAPI_V1_SPEC.paths as any)['/runs'].post;
    const paramNames = runPost.parameters.map((p: any) => p.$ref ?? p.name);
    assert.ok(paramNames.some((n: string) => n?.includes('IdempotencyKey') || n === 'Idempotency-Key'));
  });

  it('all component schemas are defined', () => {
    const schemas = (OPENAPI_V1_SPEC.components as any).schemas;
    const expected = [
      'Run', 'Step', 'WorkGraph', 'Interaction', 'Artifact',
      'PolicyBundle', 'Effect', 'AgentDefinition', 'ToolDefinition',
      'ConnectorDefinition', 'KernelEvent', 'Error',
      'CreateRunRequest', 'CreateInteractionResponseRequest',
    ];
    for (const name of expected) {
      assert.ok(name in schemas, `Schema ${name} missing from OpenAPI components`);
    }
  });
});

describe('@commander/contracts compatibility', () => {
  it('contract version matches', () => {
    assert.equal(CONTRACT_VERSION, CONTRACTS_VERSION);
    assert.equal(CONTRACT_VERSION, 'v2');
  });

  it('isCompatibleSchemaVersion accepts v2', () => {
    assert.equal(isCompatibleSchemaVersion('v2'), true);
    assert.equal(isCompatibleSchemaVersion('v1'), false);
    assert.equal(isCompatibleSchemaVersion('v3'), false);
  });

  it('snapshotContracts returns constitution contracts, states, and error codes', () => {
    const snap = snapshotContracts();
    assert.equal(snap.packageVersion, 'v2');
    assert.equal(Object.keys(snap.contracts).length, 5);
    assert.ok(snap.runStates.length >= 8);
    assert.ok(snap.stepStates.length >= 8);
    assert.ok(snap.errorCodes.length >= 20);
    assert.ok(snap.contracts.grant.schemaHash.length === 64);
  });

  it('detectBreakingChanges identifies removed required grant field', () => {
    const baseline = snapshotContracts();
    const current = structuredClone(baseline);
    current.contracts.grant.required = current.contracts.grant.required.filter((f) => f !== 'nonce');
    const changes = detectBreakingChanges(baseline, current);
    assert.ok(changes.length > 0);
    assert.ok(changes.some((c) => c.includes('nonce')));
  });

  it('detectBreakingChanges identifies removed states', () => {
    const baseline = snapshotContracts();
    const current = snapshotContracts();
    current.runStates = current.runStates.filter((s) => s !== 'COMPENSATING');
    const changes = detectBreakingChanges(baseline, current);
    assert.ok(changes.some((c) => c.includes('COMPENSATING')));
  });

  it('detectBreakingChanges returns empty for identical snapshots', () => {
    const snap = snapshotContracts();
    const changes = detectBreakingChanges(snap, snap);
    assert.deepStrictEqual(changes, []);
  });

  it('committed baseline has no breaking drift from current snapshot', () => {
    const baselinePath = join(
      dirname(fileURLToPath(import.meta.url)),
      '../snapshots/contract-snapshot.baseline.json',
    );
    const baseline = JSON.parse(readFileSync(baselinePath, 'utf8')) as ReturnType<typeof snapshotContracts>;
    const current = snapshotContracts();
    const changes = detectBreakingChanges(baseline, current);
    assert.deepStrictEqual(
      changes,
      [],
      `baseline drift detected: ${changes.join('; ')}`,
    );
  });

  it('error codes are stable', () => {
    assert.ok(KERNEL_ERROR_CODES.includes('DUPLICATE_INTERACTION'));
    assert.ok(KERNEL_ERROR_CODES.includes('LEASE_LOST'));
    assert.ok(KERNEL_ERROR_CODES.includes('VERSION_CONFLICT'));
    assert.ok(KERNEL_ERROR_CODES.includes('POLICY_DENIED'));
    assert.ok(KERNEL_ERROR_CODES.includes('CAPABILITY_DENIED'));
  });
});
