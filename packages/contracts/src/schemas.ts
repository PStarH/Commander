/**
 * JSON Schema definitions for all V2 contract resources, events, and errors.
 *
 * These schemas are the machine-readable counterpart to the TypeScript types
 * in `resources.ts`, `events.ts`, `states.ts`, and `errors.ts`. They enable
 * runtime validation, consumer-driven contract testing, and CI compatibility
 * checks without requiring a heavy validation library at import time.
 *
 * Each schema uses Draft 2020-12. The `$id` follows the pattern
 * `https://commander.dev/contracts/{version}/{name}.json`.
 */

import { RUN_STATES, STEP_STATES } from './states.js';
import { KERNEL_ERROR_CODES } from './errors.js';

const BASE = 'https://commander.dev/contracts/v2';

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
  required: ['id', 'tenantId', 'state', 'version', 'intentHash', 'workGraphHash', 'workGraphVersion', 'policySnapshotId', 'createdAt', 'updatedAt', 'metadata'],
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
  required: ['id', 'runId', 'tenantId', 'kind', 'state', 'version', 'attempt', 'maxAttempts', 'priority', 'dependencies', 'input', 'scheduledAt', 'createdAt', 'updatedAt'],
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
  required: ['id', 'tenantId', 'profile', 'goal', 'hash', 'schemaVersion', 'nodeCount', 'nodes', 'createdAt'],
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
  required: ['id', 'kind', 'version', 'capabilities', 'status', 'tenantIds', 'registeredAt', 'lastHeartbeatAt'],
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
  required: ['id', 'runId', 'stepId', 'tenantId', 'kind', 'status', 'idempotencyKey', 'policyDecisionId', 'arguments', 'fencingEpoch', 'createdAt'],
  properties: {
    id: opaqueId,
    runId: opaqueId,
    stepId: opaqueId,
    tenantId: tenantIdSchema,
    kind: { type: 'string', minLength: 1, maxLength: 128 },
    status: { type: 'string', enum: ['ADMITTED', 'COMPLETION_UNKNOWN', 'COMPLETED', 'FAILED'] },
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
  required: ['id', 'tenantId', 'name', 'version', 'model', 'systemPrompt', 'toolAllowlist', 'requiredCapabilities', 'maxConcurrency', 'timeoutMs', 'metadata', 'createdAt', 'updatedAt'],
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
  required: ['id', 'tenantId', 'name', 'version', 'description', 'riskLevel', 'inputSchema', 'requiredCapabilities', 'hasExternalEffects', 'timeoutMs', 'metadata', 'createdAt', 'updatedAt'],
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
  required: ['id', 'tenantId', 'name', 'version', 'endpoint', 'authMode', 'requiredScopes', 'dataClassification', 'egressAllowlist', 'enabled', 'metadata', 'createdAt', 'updatedAt'],
  properties: {
    id: opaqueId,
    tenantId: tenantIdSchema,
    name: { type: 'string', minLength: 1, maxLength: 256 },
    version: { type: 'integer', minimum: 1 },
    endpoint: { type: 'string', minLength: 1, maxLength: 2048 },
    authMode: { type: 'string', enum: ['api_key', 'oauth2', 'hmac', 'mtls', 'none'] },
    requiredScopes: { type: 'array', items: { type: 'string' } },
    dataClassification: { type: 'string', enum: ['public', 'internal', 'pii', 'phi', 'confidential'] },
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
  required: ['eventId', 'aggregateType', 'aggregateId', 'sequence', 'type', 'tenantId', 'runId', 'actor', 'schemaVersion', 'payload', 'occurredAt'],
  properties: {
    eventId: { type: 'string', format: 'uuid' },
    aggregateType: { type: 'string', enum: ['run', 'step', 'effect', 'interaction', 'worker', 'tenant'] },
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
} as const;

export type ContractSchemaName = keyof typeof CONTRACT_SCHEMAS;
