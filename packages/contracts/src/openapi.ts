/**
 * OpenAPI 3.1 specification for Commander V1 resource API.
 *
 * This is the canonical API contract — `apps/api` must implement every path
 * defined here, and SDK code generators consume this spec to produce typed
 * clients. The spec is exported as a plain JS object so it can be serialized
 * to JSON or YAML without additional dependencies.
 *
 * Design rules:
 * - All V1 paths are under `/v1`.
 * - Accepted action proposals and reconciliations return 202; reviews are synchronous.
 * - All operations require `Idempotency-Key` for writes.
 * - Authentication is API-key based; tenant is derived from the key, never
 *   from a raw header.
 * - Resource shapes reference the JSON Schemas in `schemas.ts`.
 */

import { RUN_STATES, STEP_STATES } from './states.js';
import { KERNEL_ERROR_CODES } from './errors.js';
import {
  actionApprovalRequestSchema,
  actionCompensationRequestSchema,
  actionCompensationApprovalRequestSchema,
  actionDecisionSchema,
  actionErrorSchema,
  actionEvidenceSchema,
  actionKillSwitchListResponseSchema,
  actionKillSwitchResponseSchema,
  actionKillSwitchSchema,
  actionKillSwitchUpdateSchema,
  actionProposeRequestSchema,
  actionProposeResponseSchema,
  actionReconcileAcceptedSchema,
  actionRejectionRequestSchema,
  actionResponseSchema,
  actionSimulationResponseSchema,
  actionSimulationSchema,
  governedActionSchema,
} from './schemas.js';

const COMPONENTS = {
  securitySchemes: {
    ApiKeyAuth: {
      type: 'apiKey',
      in: 'header',
      name: 'Authorization',
      description: 'Bearer token containing a tenant-bound API key.',
    },
  },
  schemas: {
    // --- Core resources ---
    Run: {
      type: 'object',
      required: ['id', 'tenantId', 'state', 'version', 'intentHash', 'workGraphHash', 'workGraphVersion', 'policySnapshotId', 'createdAt', 'updatedAt', 'metadata'],
      properties: {
        id: { type: 'string', description: 'Opaque run identifier.' },
        tenantId: { type: 'string' },
        state: { type: 'string', enum: [...RUN_STATES], description: 'Canonical run state (uppercase).' },
        version: { type: 'integer', minimum: 0 },
        intentHash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
        workGraphHash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
        workGraphVersion: { type: 'string' },
        policySnapshotId: { type: 'string' },
        createdAt: { type: 'string', format: 'date-time' },
        updatedAt: { type: 'string', format: 'date-time' },
        pausedAt: { type: 'string', format: 'date-time' },
        terminalAt: { type: 'string', format: 'date-time' },
        metadata: { type: 'object', additionalProperties: true },
      },
    },
    Step: {
      type: 'object',
      required: ['id', 'runId', 'tenantId', 'kind', 'state', 'version', 'attempt', 'maxAttempts', 'priority', 'dependencies', 'input', 'scheduledAt', 'createdAt', 'updatedAt'],
      properties: {
        id: { type: 'string' },
        runId: { type: 'string' },
        tenantId: { type: 'string' },
        kind: { type: 'string' },
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
          properties: {
            code: { type: 'string' },
            message: { type: 'string' },
            retryable: { type: 'boolean' },
            details: { type: 'object', additionalProperties: true },
          },
        },
        scheduledAt: { type: 'string', format: 'date-time' },
        createdAt: { type: 'string', format: 'date-time' },
        updatedAt: { type: 'string', format: 'date-time' },
      },
    },
    WorkGraph: {
      type: 'object',
      required: ['id', 'tenantId', 'profile', 'goal', 'hash', 'schemaVersion', 'nodeCount', 'nodes', 'createdAt'],
      properties: {
        id: { type: 'string' },
        tenantId: { type: 'string' },
        profile: { type: 'string', enum: ['run', 'swarm', 'drive', 'goal', 'company'] },
        goal: { type: 'string', maxLength: 20000 },
        hash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
        schemaVersion: { type: 'string' },
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
        createdAt: { type: 'string', format: 'date-time' },
      },
    },
    Interaction: {
      type: 'object',
      required: ['id', 'runId', 'tenantId', 'status', 'prompt', 'createdAt'],
      properties: {
        id: { type: 'string' },
        runId: { type: 'string' },
        stepId: { type: 'string' },
        tenantId: { type: 'string' },
        status: { type: 'string', enum: ['pending', 'answered', 'expired', 'cancelled'] },
        prompt: { type: 'string' },
        response: {},
        createdAt: { type: 'string', format: 'date-time' },
        expiresAt: { type: 'string', format: 'date-time' },
      },
    },
    Artifact: {
      type: 'object',
      required: ['id', 'runId', 'tenantId', 'name', 'contentType', 'createdAt'],
      properties: {
        id: { type: 'string' },
        runId: { type: 'string' },
        tenantId: { type: 'string' },
        name: { type: 'string' },
        contentType: { type: 'string' },
        uri: { type: 'string' },
        digest: { type: 'string' },
        createdAt: { type: 'string', format: 'date-time' },
      },
    },
    PolicyBundle: {
      type: 'object',
      required: ['name', 'version', 'snapshotId', 'effectDefaults'],
      properties: {
        name: { type: 'string' },
        version: { type: 'integer', minimum: 0 },
        snapshotId: { type: 'string' },
        effectDefaults: {
          type: 'object',
          required: ['allow', 'requireApproval'],
          properties: {
            allow: { type: 'boolean' },
            requireApproval: { type: 'boolean' },
          },
        },
      },
    },
    Effect: {
      type: 'object',
      required: ['id', 'runId', 'stepId', 'tenantId', 'kind', 'status', 'idempotencyKey', 'policyDecisionId', 'arguments', 'fencingEpoch', 'createdAt'],
      properties: {
        id: { type: 'string' },
        runId: { type: 'string' },
        stepId: { type: 'string' },
        tenantId: { type: 'string' },
        kind: { type: 'string' },
        status: { type: 'string', enum: ['ADMITTED', 'EXECUTING', 'COMPLETION_UNKNOWN', 'COMPLETED', 'FAILED', 'COMPENSATED', 'REJECTED'] },
        idempotencyKey: { type: 'string' },
        policyDecisionId: { type: 'string' },
        arguments: { type: 'object', additionalProperties: true },
        result: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            data: { type: 'object', additionalProperties: true },
            error: {
              type: 'object',
              properties: { code: { type: 'string' }, message: { type: 'string' } },
            },
          },
        },
        fencingEpoch: { type: 'integer', minimum: 0 },
        createdAt: { type: 'string', format: 'date-time' },
        completedAt: { type: 'string', format: 'date-time' },
      },
    },
    AgentDefinition: {
      type: 'object',
      required: ['id', 'tenantId', 'name', 'version', 'model', 'systemPrompt', 'toolAllowlist', 'requiredCapabilities', 'maxConcurrency', 'timeoutMs', 'metadata', 'createdAt', 'updatedAt'],
      properties: {
        id: { type: 'string' },
        tenantId: { type: 'string' },
        name: { type: 'string' },
        version: { type: 'integer', minimum: 1 },
        model: { type: 'string' },
        systemPrompt: { type: 'string', maxLength: 100000 },
        toolAllowlist: { type: 'array', items: { type: 'string' } },
        requiredCapabilities: { type: 'array', items: { type: 'string' } },
        maxConcurrency: { type: 'integer', minimum: 1, maximum: 100 },
        timeoutMs: { type: 'integer', minimum: 1000, maximum: 3600000 },
        metadata: { type: 'object', additionalProperties: true },
        createdAt: { type: 'string', format: 'date-time' },
        updatedAt: { type: 'string', format: 'date-time' },
      },
    },
    ToolDefinition: {
      type: 'object',
      required: ['id', 'tenantId', 'name', 'version', 'description', 'riskLevel', 'inputSchema', 'requiredCapabilities', 'hasExternalEffects', 'timeoutMs', 'metadata', 'createdAt', 'updatedAt'],
      properties: {
        id: { type: 'string' },
        tenantId: { type: 'string' },
        name: { type: 'string' },
        version: { type: 'integer', minimum: 1 },
        description: { type: 'string', maxLength: 10000 },
        riskLevel: { type: 'string', enum: ['safe', 'elevated', 'irreversible'] },
        inputSchema: { type: 'object', additionalProperties: true },
        requiredCapabilities: { type: 'array', items: { type: 'string' } },
        hasExternalEffects: { type: 'boolean' },
        timeoutMs: { type: 'integer', minimum: 1000, maximum: 3600000 },
        metadata: { type: 'object', additionalProperties: true },
        createdAt: { type: 'string', format: 'date-time' },
        updatedAt: { type: 'string', format: 'date-time' },
      },
    },
    ConnectorDefinition: {
      type: 'object',
      required: ['id', 'tenantId', 'name', 'version', 'endpoint', 'authMode', 'requiredScopes', 'dataClassification', 'egressAllowlist', 'enabled', 'metadata', 'createdAt', 'updatedAt'],
      properties: {
        id: { type: 'string' },
        tenantId: { type: 'string' },
        name: { type: 'string' },
        version: { type: 'integer', minimum: 1 },
        endpoint: { type: 'string' },
        authMode: { type: 'string', enum: ['api_key', 'oauth2', 'hmac', 'mtls', 'none'] },
        requiredScopes: { type: 'array', items: { type: 'string' } },
        dataClassification: { type: 'string', enum: ['public', 'internal', 'pii', 'phi', 'confidential'] },
        egressAllowlist: { type: 'array', items: { type: 'string' } },
        enabled: { type: 'boolean' },
        metadata: { type: 'object', additionalProperties: true },
        createdAt: { type: 'string', format: 'date-time' },
        updatedAt: { type: 'string', format: 'date-time' },
      },
    },
    KernelEvent: {
      type: 'object',
      required: ['eventId', 'aggregateType', 'aggregateId', 'sequence', 'type', 'tenantId', 'runId', 'actor', 'schemaVersion', 'payload', 'occurredAt'],
      properties: {
        eventId: { type: 'string', format: 'uuid' },
        aggregateType: { type: 'string', enum: ['run', 'step', 'effect', 'interaction', 'worker', 'tenant'] },
        aggregateId: { type: 'string' },
        sequence: { type: 'integer', minimum: 0 },
        type: { type: 'string' },
        tenantId: { type: 'string' },
        runId: { type: 'string' },
        stepId: { type: 'string' },
        causationId: { type: 'string' },
        correlationId: { type: 'string' },
        actor: { type: 'string' },
        schemaVersion: { type: 'string' },
        payload: { type: 'object', additionalProperties: true },
        occurredAt: { type: 'string', format: 'date-time' },
      },
    },
    Error: {
      type: 'object',
      required: ['code', 'message', 'retryable'],
      properties: {
        code: { type: 'string', enum: [...KERNEL_ERROR_CODES] },
        message: { type: 'string' },
        retryable: { type: 'boolean' },
        details: { type: 'object', additionalProperties: true },
      },
    },
    CreateRunRequest: {
      type: 'object',
      required: ['goal'],
      properties: {
        goal: { type: 'string', minLength: 1, maxLength: 20000 },
        steps: {
          type: 'array',
          maxItems: 100,
          items: {
            type: 'object',
            required: ['kind'],
            properties: {
              id: { type: 'string', pattern: '^[a-zA-Z0-9._:-]{1,128}$' },
              kind: { type: 'string', pattern: '^[a-zA-Z0-9._:-]{1,128}$' },
              input: { type: 'object', additionalProperties: true },
              dependencies: { type: 'array', items: { type: 'string' }, maxItems: 100 },
              priority: { type: 'integer', minimum: -1000, maximum: 1000 },
              maxAttempts: { type: 'integer', minimum: 1, maximum: 20 },
            },
          },
        },
        workGraphVersion: { type: 'string', default: 'v1' },
        policySnapshotId: { type: 'string' },
        metadata: { type: 'object', additionalProperties: true },
      },
    },
    CreateInteractionResponseRequest: {
      type: 'object',
      required: ['response'],
      properties: {
        response: { description: 'The interaction response payload.' },
      },
    },
    // --- Governed Action Gateway V1 ---
    ActionProposeRequest: actionProposeRequestSchema,
    ActionDecision: actionDecisionSchema,
    ActionSimulation: actionSimulationSchema,
    GovernedAction: governedActionSchema,
    ActionApprovalRequest: actionApprovalRequestSchema,
    ActionCompensationRequest: actionCompensationRequestSchema,
    ActionCompensationApprovalRequest: actionCompensationApprovalRequestSchema,
    ActionRejectionRequest: actionRejectionRequestSchema,
    ActionSimulationResponse: actionSimulationResponseSchema,
    ActionResponse: actionResponseSchema,
    ActionProposeResponse: actionProposeResponseSchema,
    ActionReconcileAccepted: actionReconcileAcceptedSchema,
    ActionEvidence: actionEvidenceSchema,
    ActionError: actionErrorSchema,
    ActionKillSwitch: actionKillSwitchSchema,
    ActionKillSwitchUpdate: actionKillSwitchUpdateSchema,
    ActionKillSwitchListResponse: actionKillSwitchListResponseSchema,
    ActionKillSwitchResponse: actionKillSwitchResponseSchema,
  },
  parameters: {
    RunId: { name: 'runId', in: 'path', required: true, schema: { type: 'string' } },
    StepId: { name: 'stepId', in: 'path', required: true, schema: { type: 'string' } },
    InteractionId: { name: 'interactionId', in: 'path', required: true, schema: { type: 'string' } },
    ArtifactId: { name: 'artifactId', in: 'path', required: true, schema: { type: 'string' } },
    EffectId: { name: 'effectId', in: 'path', required: true, schema: { type: 'string' } },
    AgentId: { name: 'agentId', in: 'path', required: true, schema: { type: 'string' } },
    ToolId: { name: 'toolId', in: 'path', required: true, schema: { type: 'string' } },
    ConnectorId: { name: 'connectorId', in: 'path', required: true, schema: { type: 'string' } },
    KillSwitchScope: {
      name: 'scope',
      in: 'path',
      required: true,
      schema: {
        type: 'string',
        enum: ['tenant', 'package', 'model', 'tool', 'destination', 'effect-type'],
      },
    },
    KillSwitchValue: {
      name: 'value',
      in: 'path',
      required: true,
      schema: { type: 'string', minLength: 1, maxLength: 512 },
    },
    IdempotencyKey: {
      name: 'Idempotency-Key',
      in: 'header',
      required: true,
      schema: { type: 'string', pattern: '^[A-Za-z0-9._:-]{8,256}$' },
      description: 'Client-generated idempotency key. Required for all write operations.',
    },
  },
  responses: {
    Accepted: {
      description: 'Request accepted. The resource is being processed asynchronously.',
      headers: {
        Location: { schema: { type: 'string' }, description: 'URL to poll for resource status.' },
      },
    },
    NotFound: {
      description: 'Resource not found.',
      content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
    },
    Forbidden: {
      description: 'Tenant identity does not match the resource tenant.',
      content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
    },
    BadRequest: {
      description: 'Request validation failed.',
      content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
    },
    Conflict: {
      description: 'Idempotency key conflict.',
      content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
    },
    ServiceUnavailable: {
      description: 'Execution kernel is not configured.',
      content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
    },
    ActionBadRequest: {
      description: 'Action request validation failed.',
      content: { 'application/json': { schema: { $ref: '#/components/schemas/ActionError' } } },
    },
    ActionUnauthorized: {
      description: 'An authenticated, tenant-bound principal is required.',
      content: { 'application/json': { schema: { $ref: '#/components/schemas/ActionError' } } },
    },
    ActionForbidden: {
      description: 'The action was denied by policy or the principal lacks authority.',
      content: { 'application/json': { schema: { $ref: '#/components/schemas/ActionError' } } },
    },
    ActionNotFound: {
      description: 'The governed action was not found.',
      content: { 'application/json': { schema: { $ref: '#/components/schemas/ActionError' } } },
    },
    ActionConflict: {
      description: 'The action state, approval binding, or idempotency key conflicts.',
      content: { 'application/json': { schema: { $ref: '#/components/schemas/ActionError' } } },
    },
    ActionGone: {
      description: 'The reconciliation deadline has expired.',
      content: { 'application/json': { schema: { $ref: '#/components/schemas/ActionError' } } },
    },
    ActionServiceUnavailable: {
      description: 'The action gateway dependency or requested evidence is unavailable.',
      content: { 'application/json': { schema: { $ref: '#/components/schemas/ActionError' } } },
    },
    ActionSimulationOk: {
      description: 'The action simulation completed.',
      content: {
        'application/json': {
          schema: { $ref: '#/components/schemas/ActionSimulationResponse' },
        },
      },
    },
    ActionProposalAccepted: {
      description: 'The governed action was accepted.',
      headers: {
        Location: {
          schema: { type: 'string' },
          description: 'URL of the governed action.',
        },
      },
      content: {
        'application/json': {
          schema: { $ref: '#/components/schemas/ActionProposeResponse' },
        },
      },
    },
    ActionProposalReplay: {
      description: 'The existing governed action was returned for an idempotent replay.',
      content: {
        'application/json': {
          schema: { $ref: '#/components/schemas/ActionProposeResponse' },
        },
      },
    },
    ActionOk: {
      description: 'The governed action was returned.',
      content: { 'application/json': { schema: { $ref: '#/components/schemas/ActionResponse' } } },
    },
    ActionReconcileAcceptedResponse: {
      description: 'Reconciliation was scheduled or expedited.',
      content: {
        'application/json': {
          schema: { $ref: '#/components/schemas/ActionReconcileAccepted' },
        },
      },
    },
    ActionEvidenceOk: {
      description: 'Signed action evidence and its integrity result.',
      content: { 'application/json': { schema: { $ref: '#/components/schemas/ActionEvidence' } } },
    },
    ActionKillSwitchListOk: {
      description: 'The tenant kill switches were returned.',
      content: {
        'application/json': {
          schema: { $ref: '#/components/schemas/ActionKillSwitchListResponse' },
        },
      },
    },
    ActionKillSwitchOk: {
      description: 'The kill switch was updated.',
      content: {
        'application/json': {
          schema: { $ref: '#/components/schemas/ActionKillSwitchResponse' },
        },
      },
    },
  },
};

const SECURITY = [{ ApiKeyAuth: [] }];

const TAGS = [
  { name: 'Actions', description: 'Governed enterprise action lifecycle and evidence.' },
  { name: 'Runs', description: 'Durable run lifecycle management.' },
  { name: 'Steps', description: 'Step-level execution state and effects.' },
  { name: 'WorkGraphs', description: 'Canonical work graph inspection.' },
  { name: 'Interactions', description: 'Human-agent interaction lifecycle.' },
  { name: 'Artifacts', description: 'Run artifacts and evidence.' },
  { name: 'Effects', description: 'External side-effect ledger.' },
  { name: 'Policy', description: 'Policy bundle management.' },
  { name: 'Agents', description: 'Agent definition management.' },
  { name: 'Tools', description: 'Tool definition management.' },
  { name: 'Connectors', description: 'Connector definition management.' },
  { name: 'Events', description: 'Event stream and audit.' },
];

export const OPENAPI_V1_SPEC = {
  openapi: '3.1.0',
  info: {
    title: 'Commander V1 Resource API',
    version: '1.0.0',
    description: 'Versioned control-plane API for Commander Architecture V2. Accepted action proposals and reconciliations return 202; synchronous action reviews return 200. Tenant identity is derived from authenticated API keys, never from raw headers.',
    contact: { name: 'Commander', url: 'https://commander.dev' },
    license: { name: 'MIT' },
  },
  servers: [
    { url: '/v1', description: 'Default API root.' },
  ],
  tags: TAGS,
  security: SECURITY,
  paths: {
    // --- Governed Action Gateway ---
    '/actions/simulate': {
      post: {
        tags: ['Actions'],
        summary: 'Simulate a governed action',
        operationId: 'simulateAction',
        security: SECURITY,
        parameters: [{ $ref: '#/components/parameters/IdempotencyKey' }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ActionProposeRequest' },
            },
          },
        },
        responses: {
          200: { $ref: '#/components/responses/ActionSimulationOk' },
          400: { $ref: '#/components/responses/ActionBadRequest' },
          401: { $ref: '#/components/responses/ActionUnauthorized' },
          403: { $ref: '#/components/responses/ActionForbidden' },
          503: { $ref: '#/components/responses/ActionServiceUnavailable' },
        },
      },
    },
    '/actions': {
      post: {
        tags: ['Actions'],
        summary: 'Propose a governed action',
        operationId: 'proposeAction',
        security: SECURITY,
        parameters: [{ $ref: '#/components/parameters/IdempotencyKey' }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ActionProposeRequest' },
            },
          },
        },
        responses: {
          200: { $ref: '#/components/responses/ActionProposalReplay' },
          202: { $ref: '#/components/responses/ActionProposalAccepted' },
          400: { $ref: '#/components/responses/ActionBadRequest' },
          401: { $ref: '#/components/responses/ActionUnauthorized' },
          403: { $ref: '#/components/responses/ActionForbidden' },
          409: { $ref: '#/components/responses/ActionConflict' },
          503: { $ref: '#/components/responses/ActionServiceUnavailable' },
        },
      },
    },
    '/actions/{runId}': {
      parameters: [{ $ref: '#/components/parameters/RunId' }],
      get: {
        tags: ['Actions'],
        summary: 'Get a governed action',
        operationId: 'getAction',
        security: SECURITY,
        responses: {
          200: { $ref: '#/components/responses/ActionOk' },
          401: { $ref: '#/components/responses/ActionUnauthorized' },
          404: { $ref: '#/components/responses/ActionNotFound' },
          503: { $ref: '#/components/responses/ActionServiceUnavailable' },
        },
      },
    },
    '/actions/{runId}/approve': {
      parameters: [{ $ref: '#/components/parameters/RunId' }],
      post: {
        tags: ['Actions'],
        summary: 'Approve a governed action',
        operationId: 'approveAction',
        security: SECURITY,
        parameters: [{ $ref: '#/components/parameters/IdempotencyKey' }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ActionApprovalRequest' },
            },
          },
        },
        responses: {
          200: { $ref: '#/components/responses/ActionOk' },
          400: { $ref: '#/components/responses/ActionBadRequest' },
          401: { $ref: '#/components/responses/ActionUnauthorized' },
          403: { $ref: '#/components/responses/ActionForbidden' },
          404: { $ref: '#/components/responses/ActionNotFound' },
          409: { $ref: '#/components/responses/ActionConflict' },
          503: { $ref: '#/components/responses/ActionServiceUnavailable' },
        },
      },
    },
    '/actions/{runId}/reject': {
      parameters: [{ $ref: '#/components/parameters/RunId' }],
      post: {
        tags: ['Actions'],
        summary: 'Reject a governed action',
        operationId: 'rejectAction',
        security: SECURITY,
        parameters: [{ $ref: '#/components/parameters/IdempotencyKey' }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ActionRejectionRequest' },
            },
          },
        },
        responses: {
          200: { $ref: '#/components/responses/ActionOk' },
          400: { $ref: '#/components/responses/ActionBadRequest' },
          401: { $ref: '#/components/responses/ActionUnauthorized' },
          403: { $ref: '#/components/responses/ActionForbidden' },
          404: { $ref: '#/components/responses/ActionNotFound' },
          409: { $ref: '#/components/responses/ActionConflict' },
          503: { $ref: '#/components/responses/ActionServiceUnavailable' },
        },
      },
    },
    '/actions/{runId}/compensations': {
      parameters: [{ $ref: '#/components/parameters/RunId' }],
      post: {
        tags: ['Actions'],
        summary: 'Authorize and request compensation',
        operationId: 'requestActionCompensation',
        security: SECURITY,
        parameters: [{ $ref: '#/components/parameters/IdempotencyKey' }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ActionCompensationRequest' } } },
        },
        responses: {
          202: { description: 'Compensation was authorized or is awaiting bound approval.' },
          400: { $ref: '#/components/responses/ActionBadRequest' },
          401: { $ref: '#/components/responses/ActionUnauthorized' },
          403: { $ref: '#/components/responses/ActionForbidden' },
          404: { $ref: '#/components/responses/ActionNotFound' },
          409: { $ref: '#/components/responses/ActionConflict' },
          503: { $ref: '#/components/responses/ActionServiceUnavailable' },
        },
      },
    },
    '/actions/{runId}/compensations/{authorizationId}/approve': {
      parameters: [
        { $ref: '#/components/parameters/RunId' },
        { name: 'authorizationId', in: 'path', required: true, schema: { type: 'string' } },
      ],
      post: {
        tags: ['Actions'],
        summary: 'Approve a bound compensation authorization',
        operationId: 'approveActionCompensation',
        security: SECURITY,
        parameters: [{ $ref: '#/components/parameters/IdempotencyKey' }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ActionCompensationApprovalRequest' } } },
        },
        responses: {
          202: { description: 'The approved compensation request was accepted.' },
          400: { $ref: '#/components/responses/ActionBadRequest' },
          401: { $ref: '#/components/responses/ActionUnauthorized' },
          403: { $ref: '#/components/responses/ActionForbidden' },
          404: { $ref: '#/components/responses/ActionNotFound' },
          409: { $ref: '#/components/responses/ActionConflict' },
          503: { $ref: '#/components/responses/ActionServiceUnavailable' },
        },
      },
    },
    '/actions/{runId}/reconcile': {
      parameters: [{ $ref: '#/components/parameters/RunId' }],
      post: {
        tags: ['Actions'],
        summary: 'Request action reconciliation',
        operationId: 'reconcileAction',
        security: SECURITY,
        parameters: [{ $ref: '#/components/parameters/IdempotencyKey' }],
        responses: {
          202: { $ref: '#/components/responses/ActionReconcileAcceptedResponse' },
          401: { $ref: '#/components/responses/ActionUnauthorized' },
          403: { $ref: '#/components/responses/ActionForbidden' },
          404: { $ref: '#/components/responses/ActionNotFound' },
          409: { $ref: '#/components/responses/ActionConflict' },
          410: { $ref: '#/components/responses/ActionGone' },
          503: { $ref: '#/components/responses/ActionServiceUnavailable' },
        },
      },
    },
    '/actions/{runId}/evidence': {
      parameters: [{ $ref: '#/components/parameters/RunId' }],
      get: {
        tags: ['Actions'],
        summary: 'Get signed action evidence',
        operationId: 'getActionEvidence',
        security: SECURITY,
        responses: {
          200: { $ref: '#/components/responses/ActionEvidenceOk' },
          401: { $ref: '#/components/responses/ActionUnauthorized' },
          404: { $ref: '#/components/responses/ActionNotFound' },
          503: { $ref: '#/components/responses/ActionServiceUnavailable' },
        },
      },
    },
    '/actions/kill-switches': {
      get: {
        tags: ['Actions'],
        summary: 'List action kill switches',
        operationId: 'listActionKillSwitches',
        security: SECURITY,
        responses: {
          200: { $ref: '#/components/responses/ActionKillSwitchListOk' },
          401: { $ref: '#/components/responses/ActionUnauthorized' },
          403: { $ref: '#/components/responses/ActionForbidden' },
          503: { $ref: '#/components/responses/ActionServiceUnavailable' },
        },
      },
    },
    '/actions/kill-switches/{scope}/{value}': {
      parameters: [
        { $ref: '#/components/parameters/KillSwitchScope' },
        { $ref: '#/components/parameters/KillSwitchValue' },
      ],
      put: {
        tags: ['Actions'],
        summary: 'Create or update an action kill switch',
        operationId: 'putActionKillSwitch',
        security: SECURITY,
        parameters: [{ $ref: '#/components/parameters/IdempotencyKey' }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ActionKillSwitchUpdate' },
            },
          },
        },
        responses: {
          200: { $ref: '#/components/responses/ActionKillSwitchOk' },
          400: { $ref: '#/components/responses/ActionBadRequest' },
          401: { $ref: '#/components/responses/ActionUnauthorized' },
          403: { $ref: '#/components/responses/ActionForbidden' },
          503: { $ref: '#/components/responses/ActionServiceUnavailable' },
        },
      },
      delete: {
        tags: ['Actions'],
        summary: 'Delete an action kill switch',
        operationId: 'deleteActionKillSwitch',
        security: SECURITY,
        parameters: [{ $ref: '#/components/parameters/IdempotencyKey' }],
        responses: {
          204: { description: 'The kill switch was deleted.' },
          400: { $ref: '#/components/responses/ActionBadRequest' },
          401: { $ref: '#/components/responses/ActionUnauthorized' },
          403: { $ref: '#/components/responses/ActionForbidden' },
          503: { $ref: '#/components/responses/ActionServiceUnavailable' },
        },
      },
    },
    // --- Runs ---
    '/runs': {
      post: {
        tags: ['Runs'],
        summary: 'Submit a new run',
        description: 'Creates a durable run. Returns 202 with Location header for async polling.',
        security: SECURITY,
        parameters: [{ $ref: '#/components/parameters/IdempotencyKey' }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/CreateRunRequest' } } },
        },
        responses: {
          202: { $ref: '#/components/responses/Accepted', content: { 'application/json': { schema: { type: 'object', properties: { run: { $ref: '#/components/schemas/Run' }, idempotentReplay: { type: 'boolean' } } } } } },
          400: { $ref: '#/components/responses/BadRequest' },
          409: { $ref: '#/components/responses/Conflict' },
          503: { $ref: '#/components/responses/ServiceUnavailable' },
        },
      },
    },
    '/runs/{runId}': {
      get: {
        tags: ['Runs'],
        summary: 'Get run status',
        security: SECURITY,
        parameters: [{ $ref: '#/components/parameters/RunId' }],
        responses: {
          200: { content: { 'application/json': { schema: { type: 'object', properties: { run: { $ref: '#/components/schemas/Run' } } } } } },
          404: { $ref: '#/components/responses/NotFound' },
        },
      },
    },
    '/runs/{runId}/events': {
      get: {
        tags: ['Events', 'Runs'],
        summary: 'List run events',
        description: 'Returns the ordered event journal for a run.',
        security: SECURITY,
        parameters: [{ $ref: '#/components/parameters/RunId' }],
        responses: {
          200: { content: { 'application/json': { schema: { type: 'object', properties: { events: { type: 'array', items: { $ref: '#/components/schemas/KernelEvent' } } } } } } },
          404: { $ref: '#/components/responses/NotFound' },
        },
      },
    },
    '/runs/{runId}/steps': {
      get: {
        tags: ['Steps', 'Runs'],
        summary: 'List run steps',
        security: SECURITY,
        parameters: [{ $ref: '#/components/parameters/RunId' }],
        responses: {
          200: { content: { 'application/json': { schema: { type: 'object', properties: { steps: { type: 'array', items: { $ref: '#/components/schemas/Step' } } } } } } },
          404: { $ref: '#/components/responses/NotFound' },
        },
      },
    },
    '/runs/{runId}/steps/{stepId}': {
      get: {
        tags: ['Steps'],
        summary: 'Get step status',
        security: SECURITY,
        parameters: [{ $ref: '#/components/parameters/RunId' }, { $ref: '#/components/parameters/StepId' }],
        responses: {
          200: { content: { 'application/json': { schema: { type: 'object', properties: { step: { $ref: '#/components/schemas/Step' } } } } } },
          404: { $ref: '#/components/responses/NotFound' },
        },
      },
    },
    '/runs/{runId}/workgraph': {
      get: {
        tags: ['WorkGraphs', 'Runs'],
        summary: 'Get run work graph',
        security: SECURITY,
        parameters: [{ $ref: '#/components/parameters/RunId' }],
        responses: {
          200: { content: { 'application/json': { schema: { type: 'object', properties: { workGraph: { $ref: '#/components/schemas/WorkGraph' } } } } } },
          404: { $ref: '#/components/responses/NotFound' },
        },
      },
    },
    // --- Interactions ---
    '/runs/{runId}/interactions': {
      get: {
        tags: ['Interactions', 'Runs'],
        summary: 'List run interactions',
        security: SECURITY,
        parameters: [{ $ref: '#/components/parameters/RunId' }],
        responses: {
          200: { content: { 'application/json': { schema: { type: 'object', properties: { interactions: { type: 'array', items: { $ref: '#/components/schemas/Interaction' } } } } } } },
          404: { $ref: '#/components/responses/NotFound' },
        },
      },
    },
    '/runs/{runId}/interactions/{interactionId}': {
      get: {
        tags: ['Interactions'],
        summary: 'Get interaction',
        security: SECURITY,
        parameters: [{ $ref: '#/components/parameters/RunId' }, { $ref: '#/components/parameters/InteractionId' }],
        responses: {
          200: { content: { 'application/json': { schema: { type: 'object', properties: { interaction: { $ref: '#/components/schemas/Interaction' } } } } } },
          404: { $ref: '#/components/responses/NotFound' },
        },
      },
      post: {
        tags: ['Interactions'],
        summary: 'Submit interaction response',
        security: SECURITY,
        parameters: [{ $ref: '#/components/parameters/RunId' }, { $ref: '#/components/parameters/InteractionId' }, { $ref: '#/components/parameters/IdempotencyKey' }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/CreateInteractionResponseRequest' } } },
        },
        responses: {
          202: { $ref: '#/components/responses/Accepted' },
          404: { $ref: '#/components/responses/NotFound' },
          409: { $ref: '#/components/responses/Conflict' },
        },
      },
    },
    // --- Artifacts ---
    '/runs/{runId}/artifacts': {
      get: {
        tags: ['Artifacts', 'Runs'],
        summary: 'List run artifacts',
        security: SECURITY,
        parameters: [{ $ref: '#/components/parameters/RunId' }],
        responses: {
          200: { content: { 'application/json': { schema: { type: 'object', properties: { artifacts: { type: 'array', items: { $ref: '#/components/schemas/Artifact' } } } } } } },
          404: { $ref: '#/components/responses/NotFound' },
        },
      },
    },
    '/runs/{runId}/artifacts/{artifactId}': {
      get: {
        tags: ['Artifacts'],
        summary: 'Get artifact',
        security: SECURITY,
        parameters: [{ $ref: '#/components/parameters/RunId' }, { $ref: '#/components/parameters/ArtifactId' }],
        responses: {
          200: { content: { 'application/json': { schema: { type: 'object', properties: { artifact: { $ref: '#/components/schemas/Artifact' } } } } } },
          404: { $ref: '#/components/responses/NotFound' },
        },
      },
    },
    // --- Effects ---
    '/runs/{runId}/effects': {
      get: {
        tags: ['Effects', 'Runs'],
        summary: 'List run effects',
        security: SECURITY,
        parameters: [{ $ref: '#/components/parameters/RunId' }],
        responses: {
          200: { content: { 'application/json': { schema: { type: 'object', properties: { effects: { type: 'array', items: { $ref: '#/components/schemas/Effect' } } } } } } },
          404: { $ref: '#/components/responses/NotFound' },
        },
      },
    },
    '/runs/{runId}/effects/{effectId}': {
      get: {
        tags: ['Effects'],
        summary: 'Get effect',
        security: SECURITY,
        parameters: [{ $ref: '#/components/parameters/RunId' }, { $ref: '#/components/parameters/EffectId' }],
        responses: {
          200: { content: { 'application/json': { schema: { type: 'object', properties: { effect: { $ref: '#/components/schemas/Effect' } } } } } },
          404: { $ref: '#/components/responses/NotFound' },
        },
      },
    },
    // --- Policy Bundles ---
    '/policy-bundles': {
      get: {
        tags: ['Policy'],
        summary: 'List policy bundles',
        security: SECURITY,
        responses: {
          200: { content: { 'application/json': { schema: { type: 'object', properties: { bundles: { type: 'array', items: { $ref: '#/components/schemas/PolicyBundle' } } } } } } },
        },
      },
    },
    '/policy-bundles/{snapshotId}': {
      get: {
        tags: ['Policy'],
        summary: 'Get policy bundle by snapshot ID',
        security: SECURITY,
        parameters: [{ name: 'snapshotId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: { content: { 'application/json': { schema: { type: 'object', properties: { bundle: { $ref: '#/components/schemas/PolicyBundle' } } } } } },
          404: { $ref: '#/components/responses/NotFound' },
        },
      },
    },
    // --- Agent Definitions ---
    '/agents': {
      get: {
        tags: ['Agents'],
        summary: 'List agent definitions',
        security: SECURITY,
        responses: {
          200: { content: { 'application/json': { schema: { type: 'object', properties: { agents: { type: 'array', items: { $ref: '#/components/schemas/AgentDefinition' } } } } } } },
        },
      },
      post: {
        tags: ['Agents'],
        summary: 'Create agent definition',
        security: SECURITY,
        parameters: [{ $ref: '#/components/parameters/IdempotencyKey' }],
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/AgentDefinition' } } } },
        responses: {
          202: { $ref: '#/components/responses/Accepted' },
          400: { $ref: '#/components/responses/BadRequest' },
          409: { $ref: '#/components/responses/Conflict' },
        },
      },
    },
    '/agents/{agentId}': {
      get: {
        tags: ['Agents'],
        summary: 'Get agent definition',
        security: SECURITY,
        parameters: [{ $ref: '#/components/parameters/AgentId' }],
        responses: {
          200: { content: { 'application/json': { schema: { type: 'object', properties: { agent: { $ref: '#/components/schemas/AgentDefinition' } } } } } },
          404: { $ref: '#/components/responses/NotFound' },
        },
      },
    },
    // --- Tool Definitions ---
    '/tools': {
      get: {
        tags: ['Tools'],
        summary: 'List tool definitions',
        security: SECURITY,
        responses: {
          200: { content: { 'application/json': { schema: { type: 'object', properties: { tools: { type: 'array', items: { $ref: '#/components/schemas/ToolDefinition' } } } } } } },
        },
      },
      post: {
        tags: ['Tools'],
        summary: 'Create tool definition',
        security: SECURITY,
        parameters: [{ $ref: '#/components/parameters/IdempotencyKey' }],
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/ToolDefinition' } } } },
        responses: {
          202: { $ref: '#/components/responses/Accepted' },
          400: { $ref: '#/components/responses/BadRequest' },
          409: { $ref: '#/components/responses/Conflict' },
        },
      },
    },
    '/tools/{toolId}': {
      get: {
        tags: ['Tools'],
        summary: 'Get tool definition',
        security: SECURITY,
        parameters: [{ $ref: '#/components/parameters/ToolId' }],
        responses: {
          200: { content: { 'application/json': { schema: { type: 'object', properties: { tool: { $ref: '#/components/schemas/ToolDefinition' } } } } } },
          404: { $ref: '#/components/responses/NotFound' },
        },
      },
    },
    // --- Connector Definitions ---
    '/connectors': {
      get: {
        tags: ['Connectors'],
        summary: 'List connector definitions',
        security: SECURITY,
        responses: {
          200: { content: { 'application/json': { schema: { type: 'object', properties: { connectors: { type: 'array', items: { $ref: '#/components/schemas/ConnectorDefinition' } } } } } } },
        },
      },
      post: {
        tags: ['Connectors'],
        summary: 'Create connector definition',
        security: SECURITY,
        parameters: [{ $ref: '#/components/parameters/IdempotencyKey' }],
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/ConnectorDefinition' } } } },
        responses: {
          202: { $ref: '#/components/responses/Accepted' },
          400: { $ref: '#/components/responses/BadRequest' },
          409: { $ref: '#/components/responses/Conflict' },
        },
      },
    },
    '/connectors/{connectorId}': {
      get: {
        tags: ['Connectors'],
        summary: 'Get connector definition',
        security: SECURITY,
        parameters: [{ $ref: '#/components/parameters/ConnectorId' }],
        responses: {
          200: { content: { 'application/json': { schema: { type: 'object', properties: { connector: { $ref: '#/components/schemas/ConnectorDefinition' } } } } } },
          404: { $ref: '#/components/responses/NotFound' },
        },
      },
    },
  },
  components: COMPONENTS,
};

export type OpenApiV1Spec = typeof OPENAPI_V1_SPEC;
