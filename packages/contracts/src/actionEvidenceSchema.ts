const ACTION_BASE = 'https://commander.dev/contracts/actions/v1';
const identifierSchema = { type: 'string', minLength: 1, maxLength: 256 };
const hashSchema = { type: 'string', pattern: '^[a-f0-9]{64}$' };
const timestampSchema = { type: 'string', format: 'date-time' };

const signatureSchema = {
  type: 'object',
  required: ['algorithm', 'keyId', 'signedAt', 'value'],
  properties: {
    algorithm: { type: 'string', const: 'Ed25519' },
    keyId: identifierSchema,
    signedAt: timestampSchema,
    value: { type: 'string', minLength: 1 },
  },
  additionalProperties: false,
};

const effectSchema = {
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
    effectId: identifierSchema,
    stepId: identifierSchema,
    type: { type: 'string', minLength: 1 },
    state: { type: 'string', minLength: 1 },
    policyDecisionId: identifierSchema,
    requestHash: hashSchema,
    approvalInteractionId: identifierSchema,
    responseSummary: { type: 'object', additionalProperties: true },
    createdAt: timestampSchema,
    completedAt: timestampSchema,
    entryHash: hashSchema,
    prevEntryHash: hashSchema,
  },
  additionalProperties: false,
};

const auditEventSchema = {
  type: 'object',
  required: ['type', 'at', 'severity', 'details', 'entryHash', 'prevEntryHash'],
  properties: {
    type: { type: 'string', minLength: 1 },
    at: timestampSchema,
    severity: { type: 'string', minLength: 1 },
    stepId: identifierSchema,
    details: { type: 'object', additionalProperties: true },
    entryHash: hashSchema,
    prevEntryHash: hashSchema,
  },
  additionalProperties: false,
};

export const actionEvidenceSchema = {
  $id: ACTION_BASE + '/action-evidence.json',
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
        bundleId: identifierSchema,
        exportedAt: timestampSchema,
        actionDigest: hashSchema,
        terminalDisposition: {
          type: 'string',
          enum: ['SUCCEEDED', 'FAILED', 'ESCALATED'],
        },
        scope: {
          type: 'object',
          required: ['tenantId', 'runId'],
          properties: {
            tenantId: identifierSchema,
            runId: identifierSchema,
            effectId: identifierSchema,
          },
          additionalProperties: false,
        },
        identity: {
          type: 'object',
          required: [],
          properties: {
            intentHash: hashSchema,
            workGraphHash: hashSchema,
            capabilityGrant: {
              type: 'object',
              required: ['jti'],
              properties: {
                jti: identifierSchema,
                issuer: { type: 'string' },
                audience: { type: 'string' },
                requestHash: hashSchema,
                policySnapshotId: identifierSchema,
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
            policySnapshotId: identifierSchema,
            workGraphVersion: { type: 'string' },
            kernelApiVersion: { type: 'string' },
          },
          additionalProperties: false,
        },
        effects: { type: 'array', items: effectSchema },
        auditEvents: { type: 'array', items: auditEventSchema },
        contentHash: hashSchema,
        signature: signatureSchema,
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
} as const;
