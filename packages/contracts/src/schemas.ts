/**
 * JSON Schema definitions for V2 resources and the governed Action Gateway V1.
 *
 * These schemas are the machine-readable counterpart to the TypeScript types
 * in `resources.ts`, `events.ts`, `states.ts`, and `errors.ts`. They enable
 * runtime validation, consumer-driven contract testing, and CI compatibility
 * checks without requiring a heavy validation library at import time.
 *
 * Each schema uses Draft 2020-12 and has a versioned commander.dev `$id`.
 */

import { RUN_STATES, STEP_STATES } from './states.js';
import { KERNEL_ERROR_CODES } from './errors.js';
import { ACTION_KILL_SWITCH_SCOPES_V1, ACTION_STATES_V1 } from './effects.js';

const BASE = 'https://commander.dev/contracts/v2';
const ACTION_BASE = 'https://commander.dev/contracts/actions/v1';

// ---------------------------------------------------------------------------
// Reusable fragments
// ---------------------------------------------------------------------------

const isoTimestamp = { type: 'string', format: 'date-time' };
const opaqueId = { type: 'string', minLength: 1, maxLength: 256 };
const tenantIdSchema = { type: 'string', minLength: 1, maxLength: 256 };

const metadataSchema = {
  type: 'object',
  additionalProperties: true,
  description: 'Arbitrary key-value metadata.',
};

// ---------------------------------------------------------------------------
// Resource schemas
// ---------------------------------------------------------------------------

export const organizationSchema = {
  $id: `${BASE}/organization.json`,
  type: 'object',
  required: ['id', 'name', 'createdAt'],
  properties: {
    id: opaqueId,
    name: { type: 'string', minLength: 1, maxLength: 256 },
    createdAt: isoTimestamp,
  },
  additionalProperties: false,
};

export const projectSchema = {
  $id: `${BASE}/project.json`,
  type: 'object',
  required: ['id', 'organizationId', 'name', 'createdAt'],
  properties: {
    id: opaqueId,
    organizationId: opaqueId,
    name: { type: 'string', minLength: 1, maxLength: 256 },
    createdAt: isoTimestamp,
  },
  additionalProperties: false,
};

export const environmentSchema = {
  $id: `${BASE}/environment.json`,
  type: 'object',
  required: ['id', 'projectId', 'name'],
  properties: {
    id: opaqueId,
    projectId: opaqueId,
    name: { type: 'string', minLength: 1, maxLength: 256 },
  },
  additionalProperties: false,
};

export const principalSchema = {
  $id: `${BASE}/principal.json`,
  type: 'object',
  required: ['id', 'tenantId', 'subject', 'roles'],
  properties: {
    id: opaqueId,
    tenantId: tenantIdSchema,
    subject: { type: 'string', minLength: 1, maxLength: 512 },
    roles: { type: 'array', items: { type: 'string' } },
  },
  additionalProperties: false,
};

export const runSchema = {
  $id: `${BASE}/run.json`,
  type: 'object',
  required: [
    'id',
    'tenantId',
    'state',
    'version',
    'intentHash',
    'workGraphHash',
    'workGraphVersion',
    'policySnapshotId',
    'createdAt',
    'updatedAt',
    'metadata',
  ],
  properties: {
    id: opaqueId,
    tenantId: tenantIdSchema,
    state: { type: 'string', enum: [...RUN_STATES] },
    version: { type: 'integer', minimum: 0 },
    intentHash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    workGraphHash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    workGraphVersion: { type: 'string', minLength: 1, maxLength: 64 },
    policySnapshotId: { type: 'string', minLength: 1, maxLength: 256 },
    createdAt: isoTimestamp,
    updatedAt: isoTimestamp,
    pausedAt: isoTimestamp,
    terminalAt: isoTimestamp,
    metadata: metadataSchema,
  },
  additionalProperties: false,
};

export const stepSchema = {
  $id: `${BASE}/step.json`,
  type: 'object',
  required: [
    'id',
    'runId',
    'tenantId',
    'kind',
    'state',
    'version',
    'attempt',
    'maxAttempts',
    'priority',
    'dependencies',
    'input',
    'scheduledAt',
    'createdAt',
    'updatedAt',
  ],
  properties: {
    id: opaqueId,
    runId: opaqueId,
    tenantId: tenantIdSchema,
    kind: { type: 'string', minLength: 1, maxLength: 128 },
    state: { type: 'string', enum: [...STEP_STATES] },
    version: { type: 'integer', minimum: 0 },
    attempt: { type: 'integer', minimum: 0 },
    maxAttempts: { type: 'integer', minimum: 1, maximum: 20 },
    priority: { type: 'integer', minimum: -1000, maximum: 1000 },
    dependencies: { type: 'array', items: { type: 'string' } },
    input: { type: 'object', additionalProperties: true },
    output: { type: 'object', additionalProperties: true },
    error: {
      type: 'object',
      required: ['code', 'message', 'retryable'],
      properties: {
        code: { type: 'string' },
        message: { type: 'string' },
        retryable: { type: 'boolean' },
        details: { type: 'object', additionalProperties: true },
      },
    },
    scheduledAt: isoTimestamp,
    createdAt: isoTimestamp,
    updatedAt: isoTimestamp,
  },
  additionalProperties: false,
};

export const workGraphSchema = {
  $id: `${BASE}/workgraph.json`,
  type: 'object',
  required: [
    'id',
    'tenantId',
    'profile',
    'goal',
    'hash',
    'schemaVersion',
    'nodeCount',
    'nodes',
    'createdAt',
  ],
  properties: {
    id: opaqueId,
    tenantId: tenantIdSchema,
    profile: { type: 'string', enum: ['run', 'swarm', 'drive', 'goal', 'company'] },
    goal: { type: 'string', minLength: 1, maxLength: 20_000 },
    hash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    schemaVersion: { type: 'string', minLength: 1, maxLength: 64 },
    nodeCount: { type: 'integer', minimum: 0 },
    nodes: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'kind', 'dependencies'],
        properties: {
          id: { type: 'string' },
          kind: { type: 'string' },
          dependencies: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    createdAt: isoTimestamp,
  },
  additionalProperties: false,
};

export const interactionSchema = {
  $id: `${BASE}/interaction.json`,
  type: 'object',
  required: ['id', 'runId', 'tenantId', 'status', 'prompt', 'createdAt'],
  properties: {
    id: opaqueId,
    runId: opaqueId,
    stepId: opaqueId,
    tenantId: tenantIdSchema,
    status: { type: 'string', enum: ['pending', 'answered', 'expired', 'cancelled'] },
    prompt: { type: 'string' },
    response: {},
    createdAt: isoTimestamp,
    expiresAt: isoTimestamp,
  },
  additionalProperties: false,
};

export const artifactSchema = {
  $id: `${BASE}/artifact.json`,
  type: 'object',
  required: ['id', 'runId', 'tenantId', 'name', 'contentType', 'createdAt'],
  properties: {
    id: opaqueId,
    runId: opaqueId,
    tenantId: tenantIdSchema,
    name: { type: 'string', minLength: 1, maxLength: 512 },
    contentType: { type: 'string' },
    uri: { type: 'string' },
    digest: { type: 'string' },
    createdAt: isoTimestamp,
  },
  additionalProperties: false,
};

export const policyBundleSchema = {
  $id: `${BASE}/policy-bundle.json`,
  type: 'object',
  required: ['name', 'version', 'snapshotId', 'effectDefaults'],
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 256 },
    version: { type: 'integer', minimum: 0 },
    snapshotId: { type: 'string', minLength: 1, maxLength: 256 },
    effectDefaults: {
      type: 'object',
      required: ['allow', 'requireApproval'],
      properties: {
        allow: { type: 'boolean' },
        requireApproval: { type: 'boolean' },
      },
    },
  },
  additionalProperties: false,
};

export const workerSchema = {
  $id: `${BASE}/worker.json`,
  type: 'object',
  required: [
    'id',
    'kind',
    'version',
    'capabilities',
    'status',
    'tenantIds',
    'registeredAt',
    'lastHeartbeatAt',
  ],
  properties: {
    id: opaqueId,
    kind: { type: 'string', minLength: 1, maxLength: 128 },
    version: { type: 'string', minLength: 1, maxLength: 64 },
    capabilities: { type: 'array', items: { type: 'string' } },
    status: { type: 'string', enum: ['ACTIVE', 'DRAINING', 'OFFLINE'] },
    tenantIds: { type: 'array', items: { type: 'string' } },
    registeredAt: isoTimestamp,
    lastHeartbeatAt: isoTimestamp,
  },
  additionalProperties: false,
};

export const effectSchema = {
  $id: `${BASE}/effect.json`,
  type: 'object',
  required: [
    'id',
    'runId',
    'stepId',
    'tenantId',
    'kind',
    'status',
    'idempotencyKey',
    'policyDecisionId',
    'arguments',
    'fencingEpoch',
    'createdAt',
  ],
  properties: {
    id: opaqueId,
    runId: opaqueId,
    stepId: opaqueId,
    tenantId: tenantIdSchema,
    kind: { type: 'string', minLength: 1, maxLength: 128 },
    status: {
      type: 'string',
      enum: [
        'ADMITTED',
        'EXECUTING',
        'COMPLETION_UNKNOWN',
        'COMPLETED',
        'FAILED',
        'COMPENSATED',
        'REJECTED',
      ],
    },
    idempotencyKey: { type: 'string', minLength: 8, maxLength: 256 },
    policyDecisionId: { type: 'string', minLength: 1, maxLength: 256 },
    arguments: { type: 'object', additionalProperties: true },
    result: {
      type: 'object',
      required: ['ok'],
      properties: {
        ok: { type: 'boolean' },
        data: { type: 'object', additionalProperties: true },
        error: {
          type: 'object',
          required: ['code', 'message'],
          properties: {
            code: { type: 'string' },
            message: { type: 'string' },
          },
        },
      },
    },
    fencingEpoch: { type: 'integer', minimum: 0 },
    createdAt: isoTimestamp,
    completedAt: isoTimestamp,
  },
  additionalProperties: false,
};

export const agentDefinitionSchema = {
  $id: `${BASE}/agent-definition.json`,
  type: 'object',
  required: [
    'id',
    'tenantId',
    'name',
    'version',
    'model',
    'systemPrompt',
    'toolAllowlist',
    'requiredCapabilities',
    'maxConcurrency',
    'timeoutMs',
    'metadata',
    'createdAt',
    'updatedAt',
  ],
  properties: {
    id: opaqueId,
    tenantId: tenantIdSchema,
    name: { type: 'string', minLength: 1, maxLength: 256 },
    version: { type: 'integer', minimum: 1 },
    model: { type: 'string', minLength: 1, maxLength: 128 },
    systemPrompt: { type: 'string', maxLength: 100_000 },
    toolAllowlist: { type: 'array', items: { type: 'string' } },
    requiredCapabilities: { type: 'array', items: { type: 'string' } },
    maxConcurrency: { type: 'integer', minimum: 1, maximum: 100 },
    timeoutMs: { type: 'integer', minimum: 1000, maximum: 3_600_000 },
    metadata: metadataSchema,
    createdAt: isoTimestamp,
    updatedAt: isoTimestamp,
  },
  additionalProperties: false,
};

export const toolDefinitionSchema = {
  $id: `${BASE}/tool-definition.json`,
  type: 'object',
  required: [
    'id',
    'tenantId',
    'name',
    'version',
    'description',
    'riskLevel',
    'inputSchema',
    'requiredCapabilities',
    'hasExternalEffects',
    'timeoutMs',
    'metadata',
    'createdAt',
    'updatedAt',
  ],
  properties: {
    id: opaqueId,
    tenantId: tenantIdSchema,
    name: { type: 'string', minLength: 1, maxLength: 256 },
    version: { type: 'integer', minimum: 1 },
    description: { type: 'string', maxLength: 10_000 },
    riskLevel: { type: 'string', enum: ['safe', 'elevated', 'irreversible'] },
    inputSchema: { type: 'object', additionalProperties: true },
    requiredCapabilities: { type: 'array', items: { type: 'string' } },
    hasExternalEffects: { type: 'boolean' },
    timeoutMs: { type: 'integer', minimum: 1000, maximum: 3_600_000 },
    metadata: metadataSchema,
    createdAt: isoTimestamp,
    updatedAt: isoTimestamp,
  },
  additionalProperties: false,
};

export const connectorDefinitionSchema = {
  $id: `${BASE}/connector-definition.json`,
  type: 'object',
  required: [
    'id',
    'tenantId',
    'name',
    'version',
    'endpoint',
    'authMode',
    'requiredScopes',
    'dataClassification',
    'egressAllowlist',
    'enabled',
    'metadata',
    'createdAt',
    'updatedAt',
  ],
  properties: {
    id: opaqueId,
    tenantId: tenantIdSchema,
    name: { type: 'string', minLength: 1, maxLength: 256 },
    version: { type: 'integer', minimum: 1 },
    endpoint: { type: 'string', minLength: 1, maxLength: 2048 },
    authMode: { type: 'string', enum: ['api_key', 'oauth2', 'hmac', 'mtls', 'none'] },
    requiredScopes: { type: 'array', items: { type: 'string' } },
    dataClassification: {
      type: 'string',
      enum: ['public', 'internal', 'pii', 'phi', 'confidential'],
    },
    egressAllowlist: { type: 'array', items: { type: 'string' } },
    enabled: { type: 'boolean' },
    metadata: metadataSchema,
    createdAt: isoTimestamp,
    updatedAt: isoTimestamp,
  },
  additionalProperties: false,
};

// ---------------------------------------------------------------------------
// Event envelope schema
// ---------------------------------------------------------------------------

export const kernelEventSchema = {
  $id: `${BASE}/kernel-event.json`,
  type: 'object',
  required: [
    'eventId',
    'aggregateType',
    'aggregateId',
    'sequence',
    'type',
    'tenantId',
    'runId',
    'actor',
    'schemaVersion',
    'payload',
    'occurredAt',
  ],
  properties: {
    eventId: { type: 'string', format: 'uuid' },
    aggregateType: {
      type: 'string',
      enum: ['run', 'step', 'effect', 'interaction', 'worker', 'tenant'],
    },
    aggregateId: opaqueId,
    sequence: { type: 'integer', minimum: 0 },
    type: { type: 'string', minLength: 1, maxLength: 128 },
    tenantId: tenantIdSchema,
    runId: opaqueId,
    stepId: opaqueId,
    causationId: { type: 'string' },
    correlationId: { type: 'string' },
    actor: { type: 'string', minLength: 1, maxLength: 256 },
    schemaVersion: { type: 'string', minLength: 1, maxLength: 32 },
    payload: { type: 'object', additionalProperties: true },
    occurredAt: isoTimestamp,
  },
  additionalProperties: false,
};

// ---------------------------------------------------------------------------
// Error schema
// ---------------------------------------------------------------------------

export const kernelErrorSchema = {
  $id: `${BASE}/kernel-error.json`,
  type: 'object',
  required: ['code', 'message', 'retryable'],
  properties: {
    code: { type: 'string', enum: [...KERNEL_ERROR_CODES] },
    message: { type: 'string' },
    retryable: { type: 'boolean' },
    details: { type: 'object', additionalProperties: true },
  },
  additionalProperties: false,
};

// ---------------------------------------------------------------------------
// Governed Action Gateway V1 schemas
// ---------------------------------------------------------------------------

const actionDigestSchema = { type: 'string', pattern: '^[a-f0-9]{64}$' };
const actionIdentifierSchema = { type: 'string', minLength: 1, maxLength: 256 };

const actionDecisionProperties = {
  effect: { type: 'string', enum: ['allow', 'deny', 'require_approval'] },
  decisionId: actionIdentifierSchema,
  reason: { type: 'string' },
  policySnapshotId: actionIdentifierSchema,
};

const actionSimulationProperties = {
  ...actionDecisionProperties,
  simulationId: actionIdentifierSchema,
  actionDigest: actionDigestSchema,
};

export const actionProposeRequestSchema = {
  $id: `${ACTION_BASE}/action-propose-request.json`,
  type: 'object',
  required: [
    'source',
    'package',
    'model',
    'tool',
    'destination',
    'effectType',
    'args',
    'idempotencyKey',
  ],
  properties: {
    source: { type: 'string', minLength: 1, maxLength: 128 },
    package: { type: 'string', minLength: 1, maxLength: 128 },
    model: { type: 'string', minLength: 1, maxLength: 128 },
    tool: { type: 'string', minLength: 1, maxLength: 128 },
    destination: { type: 'string', minLength: 1, maxLength: 512 },
    effectType: { type: 'string', pattern: '^[a-zA-Z0-9._:-]{1,128}$' },
    args: { type: 'object', additionalProperties: true },
    idempotencyKey: {
      type: 'string',
      pattern: '^[A-Za-z0-9._:-]{8,256}$',
    },
  },
  additionalProperties: false,
};

export const actionDecisionSchema = {
  $id: `${ACTION_BASE}/action-decision.json`,
  type: 'object',
  required: ['effect', 'decisionId', 'reason', 'policySnapshotId'],
  properties: actionDecisionProperties,
  additionalProperties: false,
};

export const actionSimulationSchema = {
  $id: `${ACTION_BASE}/action-simulation.json`,
  type: 'object',
  required: ['effect', 'decisionId', 'reason', 'policySnapshotId', 'simulationId', 'actionDigest'],
  properties: actionSimulationProperties,
  additionalProperties: false,
};

export const governedActionSchema = {
  $id: `${ACTION_BASE}/governed-action.json`,
  type: 'object',
  required: [
    'runId',
    'stepId',
    'effectId',
    'state',
    'decision',
    'simulation',
    'actionDigest',
    'policySnapshotId',
    'createdAt',
    'updatedAt',
  ],
  properties: {
    runId: actionIdentifierSchema,
    stepId: actionIdentifierSchema,
    effectId: actionIdentifierSchema,
    state: { type: 'string', enum: [...ACTION_STATES_V1] },
    decision: {
      type: 'object',
      required: ['effect', 'decisionId', 'reason', 'policySnapshotId'],
      properties: actionDecisionProperties,
      additionalProperties: false,
    },
    simulation: {
      type: 'object',
      required: [
        'effect',
        'decisionId',
        'reason',
        'policySnapshotId',
        'simulationId',
        'actionDigest',
      ],
      properties: actionSimulationProperties,
      additionalProperties: false,
    },
    actionDigest: actionDigestSchema,
    policySnapshotId: actionIdentifierSchema,
    createdAt: isoTimestamp,
    updatedAt: isoTimestamp,
  },
  additionalProperties: false,
};

export const actionApprovalRequestSchema = {
  $id: `${ACTION_BASE}/action-approval-request.json`,
  type: 'object',
  required: ['actionDigest', 'simulationId', 'policySnapshotId'],
  properties: {
    actionDigest: actionDigestSchema,
    simulationId: actionIdentifierSchema,
    policySnapshotId: actionIdentifierSchema,
  },
  additionalProperties: false,
};

export const actionCompensationRequestSchema = {
  $id: `${ACTION_BASE}/action-compensation-request.json`,
  type: 'object',
  required: [
    'originalEffectId',
    'adapterVersion',
    'compensationEffectType',
    'compensationPatch',
    'forwardReceiptHash',
  ],
  properties: {
    originalEffectId: actionIdentifierSchema,
    adapterVersion: actionIdentifierSchema,
    compensationEffectType: { type: 'string', pattern: '^compensate\\.[a-zA-Z0-9._:-]{1,117}$' },
    compensationPatch: { type: 'object', additionalProperties: true },
    forwardReceiptHash: actionDigestSchema,
  },
  additionalProperties: false,
};

export const actionCompensationApprovalRequestSchema = {
  $id: `${ACTION_BASE}/action-compensation-approval-request.json`,
  type: 'object',
  required: ['actionDigest', 'policySnapshotId'],
  properties: {
    actionDigest: actionDigestSchema,
    policySnapshotId: actionIdentifierSchema,
  },
  additionalProperties: false,
};

export const actionRejectionRequestSchema = {
  $id: `${ACTION_BASE}/action-rejection-request.json`,
  type: 'object',
  required: [],
  properties: {
    reason: { type: 'string', minLength: 1, maxLength: 2_000 },
  },
  additionalProperties: false,
};

export const actionSimulationResponseSchema = {
  $id: `${ACTION_BASE}/action-simulation-response.json`,
  type: 'object',
  required: ['simulation'],
  properties: {
    simulation: {
      type: 'object',
      required: [
        'effect',
        'decisionId',
        'reason',
        'policySnapshotId',
        'simulationId',
        'actionDigest',
      ],
      properties: actionSimulationProperties,
      additionalProperties: false,
    },
  },
  additionalProperties: false,
};

export const actionResponseSchema = {
  $id: `${ACTION_BASE}/action-response.json`,
  type: 'object',
  required: ['action'],
  properties: {
    action: {
      type: 'object',
      required: governedActionSchema.required,
      properties: governedActionSchema.properties,
      additionalProperties: false,
    },
  },
  additionalProperties: false,
};

export const actionProposeResponseSchema = {
  $id: `${ACTION_BASE}/action-propose-response.json`,
  type: 'object',
  required: ['action', 'idempotentReplay'],
  properties: {
    action: actionResponseSchema.properties.action,
    idempotentReplay: { type: 'boolean' },
  },
  additionalProperties: false,
};

export const actionReconcileAcceptedSchema = {
  $id: `${ACTION_BASE}/action-reconcile-accepted.json`,
  type: 'object',
  required: ['scheduled', 'effectId', 'state', 'reconcileAfter', 'alreadyScheduled'],
  properties: {
    scheduled: { type: 'boolean', const: true },
    effectId: actionIdentifierSchema,
    state: { type: 'string', const: 'COMPLETION_UNKNOWN' },
    reconcileAfter: isoTimestamp,
    alreadyScheduled: { type: 'boolean' },
  },
  additionalProperties: false,
};

const evidenceHashSchema = { type: 'string', pattern: '^[a-f0-9]{64}$' };

const actionEvidenceSignatureSchema = {
  type: 'object',
  required: ['algorithm', 'keyId', 'signedAt', 'value'],
  properties: {
    algorithm: { type: 'string', const: 'Ed25519' },
    keyId: actionIdentifierSchema,
    signedAt: isoTimestamp,
    value: { type: 'string', minLength: 1 },
  },
  additionalProperties: false,
};

const actionEvidenceEffectSchema = {
  type: 'object',
  required: [
    'effectId',
    'stepId',
    'type',
    'state',
    'policyDecisionId',
    'requestHash',
    'createdAt',
    'entryHash',
    'prevEntryHash',
  ],
  properties: {
    effectId: actionIdentifierSchema,
    stepId: actionIdentifierSchema,
    type: { type: 'string', minLength: 1 },
    state: { type: 'string', minLength: 1 },
    policyDecisionId: actionIdentifierSchema,
    requestHash: evidenceHashSchema,
    approvalInteractionId: actionIdentifierSchema,
    responseSummary: { type: 'object', additionalProperties: true },
    createdAt: isoTimestamp,
    completedAt: isoTimestamp,
    entryHash: evidenceHashSchema,
    prevEntryHash: evidenceHashSchema,
  },
  additionalProperties: false,
};

const actionEvidenceAuditEventSchema = {
  type: 'object',
  required: ['type', 'at', 'severity', 'details', 'entryHash', 'prevEntryHash'],
  properties: {
    type: { type: 'string', minLength: 1 },
    at: isoTimestamp,
    severity: { type: 'string', minLength: 1 },
    stepId: actionIdentifierSchema,
    details: { type: 'object', additionalProperties: true },
    entryHash: evidenceHashSchema,
    prevEntryHash: evidenceHashSchema,
  },
  additionalProperties: false,
};

export const actionEvidenceSchema = {
  $id: `${ACTION_BASE}/action-evidence.json`,
  type: 'object',
  required: ['receipt', 'verification'],
  properties: {
    receipt: {
      type: 'object',
      required: [
        'schemaVersion',
        'bodyVersion',
        'bundleId',
        'exportedAt',
        'actionDigest',
        'terminalDisposition',
        'scope',
        'identity',
        'versions',
        'effects',
        'auditEvents',
        'contentHash',
        'signature',
      ],
      properties: {
        schemaVersion: { type: 'string', const: 'l3-11.v0' },
        bodyVersion: { type: 'string', const: 'commander.evidence-body/v1' },
        bundleId: actionIdentifierSchema,
        exportedAt: isoTimestamp,
        actionDigest: actionDigestSchema,
        terminalDisposition: {
          type: 'string',
          enum: ['SUCCEEDED', 'FAILED', 'ESCALATED'],
        },
        scope: {
          type: 'object',
          required: ['tenantId', 'runId'],
          properties: {
            tenantId: tenantIdSchema,
            runId: actionIdentifierSchema,
            effectId: actionIdentifierSchema,
          },
          additionalProperties: false,
        },
        identity: {
          type: 'object',
          required: [],
          properties: {
            intentHash: evidenceHashSchema,
            workGraphHash: evidenceHashSchema,
            capabilityGrant: {
              type: 'object',
              required: ['jti'],
              properties: {
                jti: actionIdentifierSchema,
                issuer: { type: 'string' },
                audience: { type: 'string' },
                requestHash: evidenceHashSchema,
                policySnapshotId: actionIdentifierSchema,
              },
              additionalProperties: false,
            },
          },
          additionalProperties: false,
        },
        versions: {
          type: 'object',
          required: ['policySnapshotId'],
          properties: {
            policySnapshotId: actionIdentifierSchema,
            workGraphVersion: { type: 'string' },
            kernelApiVersion: { type: 'string' },
          },
          additionalProperties: false,
        },
        effects: { type: 'array', items: actionEvidenceEffectSchema },
        auditEvents: { type: 'array', items: actionEvidenceAuditEventSchema },
        contentHash: evidenceHashSchema,
        signature: actionEvidenceSignatureSchema,
      },
      additionalProperties: false,
    },
    verification: {
      type: 'object',
      required: ['ok'],
      properties: {
        ok: { type: 'boolean' },
        reason: { type: 'string' },
        brokenAt: {
          type: 'string',
          enum: ['effects', 'auditEvents', 'contentHash', 'dlp'],
        },
        index: { type: 'integer', minimum: 0 },
      },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
};

export const actionErrorSchema = {
  $id: `${ACTION_BASE}/action-error.json`,
  type: 'object',
  required: ['error'],
  properties: {
    error: {
      type: 'object',
      required: ['code'],
      properties: {
        code: { type: 'string', minLength: 1, maxLength: 128 },
        message: { type: 'string' },
        details: {},
      },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
};

export const actionKillSwitchSchema = {
  $id: `${ACTION_BASE}/action-kill-switch.json`,
  type: 'object',
  required: ['tenantId', 'scope', 'value', 'enabled', 'actor', 'updatedAt'],
  properties: {
    tenantId: tenantIdSchema,
    scope: { type: 'string', enum: [...ACTION_KILL_SWITCH_SCOPES_V1] },
    value: { type: 'string', minLength: 1, maxLength: 512 },
    enabled: { type: 'boolean' },
    reason: { type: 'string', minLength: 1, maxLength: 2_000 },
    actor: actionIdentifierSchema,
    updatedAt: isoTimestamp,
  },
  additionalProperties: false,
};

export const actionKillSwitchUpdateSchema = {
  $id: `${ACTION_BASE}/action-kill-switch-update.json`,
  type: 'object',
  required: ['enabled'],
  properties: {
    enabled: { type: 'boolean' },
    reason: { type: 'string', minLength: 1, maxLength: 2_000 },
  },
  additionalProperties: false,
};

export const actionKillSwitchListResponseSchema = {
  $id: `${ACTION_BASE}/action-kill-switch-list-response.json`,
  type: 'object',
  required: ['killSwitches'],
  properties: {
    killSwitches: { type: 'array', items: actionKillSwitchSchema },
  },
  additionalProperties: false,
};

export const actionKillSwitchResponseSchema = {
  $id: `${ACTION_BASE}/action-kill-switch-response.json`,
  type: 'object',
  required: ['killSwitch'],
  properties: {
    killSwitch: actionKillSwitchSchema,
  },
  additionalProperties: false,
};

// ---------------------------------------------------------------------------
// Schema registry
// ---------------------------------------------------------------------------

export const CONTRACT_SCHEMAS = {
  organization: organizationSchema,
  project: projectSchema,
  environment: environmentSchema,
  principal: principalSchema,
  run: runSchema,
  step: stepSchema,
  workGraph: workGraphSchema,
  interaction: interactionSchema,
  artifact: artifactSchema,
  policyBundle: policyBundleSchema,
  worker: workerSchema,
  effect: effectSchema,
  agentDefinition: agentDefinitionSchema,
  toolDefinition: toolDefinitionSchema,
  connectorDefinition: connectorDefinitionSchema,
  kernelEvent: kernelEventSchema,
  kernelError: kernelErrorSchema,
  actionProposeRequest: actionProposeRequestSchema,
  actionDecision: actionDecisionSchema,
  actionSimulation: actionSimulationSchema,
  governedAction: governedActionSchema,
  actionApprovalRequest: actionApprovalRequestSchema,
  actionCompensationRequest: actionCompensationRequestSchema,
  actionCompensationApprovalRequest: actionCompensationApprovalRequestSchema,
  actionRejectionRequest: actionRejectionRequestSchema,
  actionSimulationResponse: actionSimulationResponseSchema,
  actionResponse: actionResponseSchema,
  actionProposeResponse: actionProposeResponseSchema,
  actionReconcileAccepted: actionReconcileAcceptedSchema,
  actionEvidence: actionEvidenceSchema,
  actionError: actionErrorSchema,
  actionKillSwitch: actionKillSwitchSchema,
  actionKillSwitchUpdate: actionKillSwitchUpdateSchema,
  actionKillSwitchListResponse: actionKillSwitchListResponseSchema,
  actionKillSwitchResponse: actionKillSwitchResponseSchema,
} as const;

export type ContractSchemaName = keyof typeof CONTRACT_SCHEMAS;
