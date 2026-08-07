import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isActionLearningRecordExportable,
  validateActionLearningRecordV1,
} from './actionLearning.js';

const validRecord = {
  schemaVersion: 'commander.action-learning/v1',
  recordId: 'record-1',
  createdAt: '2026-08-07T00:00:00.000Z',
  actionClass: 'kubernetes.deployment.rollback',
  sourceRuntime: 'openai-agents-mcp',
  modelFamily: 'gpt-5',
  toolClass: 'kubernetes.rollback',
  resourceScopeClass: 'deployment.namespace',
  policyOutcome: 'allow',
  approvalOutcome: 'approved',
  actionDigest: 'sha256:action',
  policySnapshotId: 'policy-1',
  contractVersion: 'l3-11.v0',
  remoteOutcome: 'applied',
  reconciliationPath: 'none',
  retryCount: 0,
  compensationCount: 0,
  operatorInterventionMinutes: 0,
  recoveryLatencyMs: 1200,
  evidenceVerified: true,
  consent: {
    tenantScopeHash: 'sha256:tenant',
    consentId: 'consent-1',
    purpose: 'model-training',
    trainingOptIn: true,
    grantedAt: '2026-08-07T00:00:00.000Z',
    retentionExpiresAt: '2026-09-07T00:00:00.000Z',
  },
  deletionStatus: 'active',
} as const;

test('validates and exports an explicitly opted-in record', () => {
  const record = validateActionLearningRecordV1(validRecord);

  assert.equal(record.schemaVersion, 'commander.action-learning/v1');
  assert.equal(
    isActionLearningRecordExportable(record, new Date('2026-08-08T00:00:00.000Z')),
    true,
  );
});

test('rejects forbidden raw or identifying fields anywhere in the input', () => {
  const forbiddenKeys = [
    'prompt',
    'args',
    'rawResponse',
    'credential',
    'token',
    'pii',
    'customerPayload',
    'internalUrl',
  ];

  for (const key of forbiddenKeys) {
    assert.throws(
      () =>
        validateActionLearningRecordV1({
          ...validRecord,
          consent: { ...validRecord.consent, [key]: 'blocked' },
        }),
      /ACTION_LEARNING_INVALID_RECORD/,
      key,
    );
  }
});

test('rejects missing or disabled training consent and invalid outcomes', () => {
  const { consent: _consent, ...withoutConsent } = validRecord;
  assert.throws(
    () => validateActionLearningRecordV1(withoutConsent),
    /ACTION_LEARNING_INVALID_RECORD/,
  );
  assert.throws(
    () =>
      validateActionLearningRecordV1({
        ...validRecord,
        consent: { ...validRecord.consent, trainingOptIn: false },
      }),
    /ACTION_LEARNING_INVALID_RECORD/,
  );
  assert.throws(
    () => validateActionLearningRecordV1({ ...validRecord, remoteOutcome: 'maybe' }),
    /ACTION_LEARNING_INVALID_RECORD/,
  );
  assert.throws(
    () => validateActionLearningRecordV1({ ...validRecord, retryCount: -1 }),
    /ACTION_LEARNING_INVALID_RECORD/,
  );
  assert.throws(
    () => validateActionLearningRecordV1({ ...validRecord, evidenceVerified: 'yes' }),
    /ACTION_LEARNING_INVALID_RECORD/,
  );
});

test('does not export withdrawn, expired, deleted, or unverified records', () => {
  const record = validateActionLearningRecordV1(validRecord);
  assert.equal(
    isActionLearningRecordExportable(
      validateActionLearningRecordV1({
        ...validRecord,
        consent: { ...validRecord.consent, withdrawnAt: '2026-08-08T00:00:00.000Z' },
      }),
      new Date('2026-08-08T00:00:00.000Z'),
    ),
    false,
  );
  assert.equal(
    isActionLearningRecordExportable(record, new Date('2026-10-01T00:00:00.000Z')),
    false,
  );
  assert.equal(
    isActionLearningRecordExportable(
      validateActionLearningRecordV1({ ...validRecord, deletionStatus: 'deletion_requested' }),
      new Date('2026-08-08T00:00:00.000Z'),
    ),
    false,
  );
  assert.equal(
    isActionLearningRecordExportable(
      validateActionLearningRecordV1({ ...validRecord, evidenceVerified: false }),
      new Date('2026-08-08T00:00:00.000Z'),
    ),
    false,
  );
});
