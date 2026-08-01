import { createHash, createPublicKey, verify } from 'node:crypto';

export type DesignPartnerVerdict = 'NOT_READY' | 'PROVEN' | 'FIELD-PROVEN';

export const MANDATORY_DATABASE_ROLES = [
  'commander_owner',
  'commander_app',
  'commander_tenant_authority',
  'commander_scheduler',
  'commander_worker',
  'commander_adapter_ops',
] as const;

export interface TechnicalProofAttestation {
  tenantId: string;
  source: {
    commit: string;
    dirty: boolean;
    dependencyLockSha256: string;
  };
  versions: {
    images: Record<string, string>;
    protocol: string;
    contract: string;
    policy: string;
    adapter: string;
  };
  topology: {
    backend: string;
    processIdentities: Record<string, string>;
    databaseRoles: string[];
    externalSystem: {
      mode: 'real' | 'emulated' | 'recorded' | 'mocked';
      identitySha256: string;
    };
    standardClientPath: boolean;
  };
  campaign: {
    driverBoundary: 'external-process' | 'same-process';
    matrixComplete: boolean;
    allFaultPointsObserved: boolean;
    invariantsPassed: boolean;
    artifactsVerified: boolean;
  };
  gates: {
    disasterRecovery: {
      passed: boolean;
      honestyLevel: string;
      reportSha256: string;
      evidenceReceiptsRestored: boolean;
      evidenceAnchorsRestored: boolean;
      identityOutcomeAccountingPreserved: boolean;
    };
    signingRotation: {
      passed: boolean;
      status: string;
      reportSha256: string;
      retainedJwksSha256: string;
      preRotationReceiptsVerified: boolean;
      postRotationReceiptsVerified: boolean;
      revokedSignerRejected: boolean;
    };
  };
}

export interface TechnicalVerdictResult {
  verdict: 'NOT_READY' | 'PROVEN';
  failures: string[];
}

export interface CustomerAcceptance {
  schema: 'commander-design-partner-acceptance/v1';
  technicalManifestSha256: string;
  workflowId: string;
  decision: 'accepted' | 'rejected';
  reviewer: {
    organization: string;
    role: string;
    subject: string;
  };
  observationWindow: {
    startedAt: string;
    endedAt: string;
  };
  workflowCount: number;
  criticalBypasses: number;
  acceptedAt: string;
  signature: {
    algorithm: 'ed25519';
    keyId: string;
    value: string;
  };
}

export function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(',')}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error('PROOF_METADATA_UNDEFINED_VALUE');
  return encoded;
}

export function stableJson(value: unknown): string {
  return canonical(value);
}

function validSha256(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}

function validIsoTimestamp(value: string): boolean {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function nonEmpty(value: string): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

export function deriveTechnicalVerdict(
  attestation: TechnicalProofAttestation,
): TechnicalVerdictResult {
  const failures: string[] = [];
  if (!nonEmpty(attestation.tenantId)) failures.push('TENANT_ID_REQUIRED');
  if (!/^[a-f0-9]{40,64}$/.test(attestation.source.commit)) failures.push('SOURCE_COMMIT_INVALID');
  if (attestation.source.dirty) failures.push('SOURCE_DIRTY');
  if (!validSha256(attestation.source.dependencyLockSha256)) {
    failures.push('DEPENDENCY_LOCK_HASH_INVALID');
  }

  const imageValues = Object.values(attestation.versions.images);
  if (
    imageValues.length === 0 ||
    imageValues.some((image) => !/@sha256:[a-f0-9]{64}$/.test(image))
  ) {
    failures.push('IMAGE_DIGEST_ATTESTATION_INCOMPLETE');
  }
  for (const [name, value] of Object.entries({
    protocol: attestation.versions.protocol,
    contract: attestation.versions.contract,
    policy: attestation.versions.policy,
    adapter: attestation.versions.adapter,
  })) {
    if (!nonEmpty(value)) failures.push(`VERSION_REQUIRED:${name}`);
  }

  if (attestation.topology.backend !== 'postgresql') {
    failures.push('POSTGRESQL_BACKEND_REQUIRED');
  }
  const identities = Object.values(attestation.topology.processIdentities).filter(nonEmpty);
  if (identities.length < 5 || new Set(identities).size !== identities.length) {
    failures.push('DISTINCT_PROCESS_IDENTITIES_REQUIRED');
  }
  const roles = new Set(attestation.topology.databaseRoles);
  if (MANDATORY_DATABASE_ROLES.some((role) => !roles.has(role))) {
    failures.push('DATABASE_ROLE_ATTESTATION_INCOMPLETE');
  }
  if (
    attestation.topology.externalSystem.mode !== 'real' ||
    !validSha256(attestation.topology.externalSystem.identitySha256)
  ) {
    failures.push('REAL_EXTERNAL_SYSTEM_REQUIRED');
  }
  if (!attestation.topology.standardClientPath) failures.push('STANDARD_CLIENT_PATH_REQUIRED');

  if (attestation.campaign.driverBoundary !== 'external-process') {
    failures.push('EXTERNAL_FAULT_DRIVER_REQUIRED');
  }
  if (!attestation.campaign.matrixComplete) failures.push('FAULT_MATRIX_INCOMPLETE');
  if (!attestation.campaign.allFaultPointsObserved) failures.push('FAULT_POINTS_INCOMPLETE');
  if (!attestation.campaign.invariantsPassed) failures.push('CAMPAIGN_INVARIANTS_FAILED');
  if (!attestation.campaign.artifactsVerified) failures.push('CAMPAIGN_ARTIFACTS_UNVERIFIED');

  if (
    !attestation.gates.disasterRecovery.passed ||
    attestation.gates.disasterRecovery.honestyLevel !== 'PROVEN' ||
    !validSha256(attestation.gates.disasterRecovery.reportSha256)
  ) {
    failures.push('DISASTER_RECOVERY_GATE_REQUIRED');
  }
  if (
    !attestation.gates.disasterRecovery.evidenceReceiptsRestored ||
    !attestation.gates.disasterRecovery.evidenceAnchorsRestored ||
    !attestation.gates.disasterRecovery.identityOutcomeAccountingPreserved
  ) {
    failures.push('DISASTER_RECOVERY_EVIDENCE_INCOMPLETE');
  }
  if (
    !attestation.gates.signingRotation.passed ||
    attestation.gates.signingRotation.status !== 'GREEN' ||
    !validSha256(attestation.gates.signingRotation.reportSha256)
  ) {
    failures.push('SIGNING_ROTATION_GATE_REQUIRED');
  }
  if (
    !validSha256(attestation.gates.signingRotation.retainedJwksSha256) ||
    !attestation.gates.signingRotation.preRotationReceiptsVerified ||
    !attestation.gates.signingRotation.postRotationReceiptsVerified ||
    !attestation.gates.signingRotation.revokedSignerRejected
  ) {
    failures.push('SIGNING_ROTATION_EVIDENCE_INCOMPLETE');
  }

  return failures.length === 0
    ? { verdict: 'PROVEN', failures }
    : { verdict: 'NOT_READY', failures };
}

export function customerAcceptanceSigningPayload(
  acceptance: Omit<CustomerAcceptance, 'signature'>,
): string {
  return stableJson(acceptance);
}

export function verifyCustomerAcceptance(input: {
  technicalManifest: string;
  expectedWorkflowId: string;
  acceptance: CustomerAcceptance;
  publicKeyPem: string;
}): { verdict: 'NOT_READY' | 'FIELD-PROVEN'; failures: string[] } {
  const failures: string[] = [];
  let technical: Record<string, unknown> | undefined;
  try {
    technical = JSON.parse(input.technicalManifest) as Record<string, unknown>;
  } catch {
    failures.push('TECHNICAL_MANIFEST_INVALID');
  }
  if (technical?.verdict !== 'PROVEN') failures.push('TECHNICAL_PROOF_REQUIRED');
  if (technical?.workflowId !== input.expectedWorkflowId) {
    failures.push('TECHNICAL_WORKFLOW_ID_MISMATCH');
  }

  const acceptance = input.acceptance;
  if (acceptance.schema !== 'commander-design-partner-acceptance/v1') {
    failures.push('CUSTOMER_ACCEPTANCE_SCHEMA_INVALID');
  }
  if (acceptance.technicalManifestSha256 !== sha256(input.technicalManifest)) {
    failures.push('CUSTOMER_ACCEPTANCE_PROOF_HASH_MISMATCH');
  }
  if (acceptance.workflowId !== input.expectedWorkflowId) {
    failures.push('CUSTOMER_ACCEPTANCE_WORKFLOW_ID_MISMATCH');
  }
  if (acceptance.decision !== 'accepted') failures.push('CUSTOMER_ACCEPTANCE_REJECTED');
  if (
    !nonEmpty(acceptance.reviewer.organization) ||
    !nonEmpty(acceptance.reviewer.role) ||
    !nonEmpty(acceptance.reviewer.subject)
  ) {
    failures.push('CUSTOMER_REVIEWER_IDENTITY_REQUIRED');
  }
  const startedAt = Date.parse(acceptance.observationWindow.startedAt);
  const endedAt = Date.parse(acceptance.observationWindow.endedAt);
  if (
    !validIsoTimestamp(acceptance.observationWindow.startedAt) ||
    !validIsoTimestamp(acceptance.observationWindow.endedAt) ||
    endedAt <= startedAt
  ) {
    failures.push('CUSTOMER_OBSERVATION_WINDOW_INVALID');
  }
  if (!Number.isInteger(acceptance.workflowCount) || acceptance.workflowCount <= 0) {
    failures.push('CUSTOMER_WORKFLOW_COUNT_REQUIRED');
  }
  if (acceptance.criticalBypasses !== 0) failures.push('CUSTOMER_CRITICAL_BYPASS_OPEN');
  if (!validIsoTimestamp(acceptance.acceptedAt)) failures.push('CUSTOMER_ACCEPTED_AT_INVALID');
  if (
    acceptance.signature.algorithm !== 'ed25519' ||
    !nonEmpty(acceptance.signature.keyId) ||
    !nonEmpty(acceptance.signature.value)
  ) {
    failures.push('CUSTOMER_SIGNATURE_INVALID');
  } else {
    try {
      const { signature: _signature, ...unsigned } = acceptance;
      const verified = verify(
        null,
        Buffer.from(customerAcceptanceSigningPayload(unsigned)),
        createPublicKey(input.publicKeyPem),
        Buffer.from(acceptance.signature.value, 'base64'),
      );
      if (!verified) failures.push('CUSTOMER_SIGNATURE_INVALID');
    } catch {
      failures.push('CUSTOMER_SIGNATURE_INVALID');
    }
  }

  return failures.length === 0
    ? { verdict: 'FIELD-PROVEN', failures }
    : { verdict: 'NOT_READY', failures: [...new Set(failures)] };
}
