import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { createPublicKey } from 'node:crypto';
import {
  parseShadowManifest,
  parseShadowObservation,
} from '../packages/shadow-plane/src/contracts.ts';
import { verifyShadowReport } from '../packages/shadow-plane/src/report.ts';

const root = resolve(import.meta.dirname, '..');
const pack = resolve(root, 'docs/pilot/shadow');
const requiredFiles = [
  'README.md',
  'invitation.md',
  'pilot-charter.md',
  'data-boundary.md',
  'historical-evaluation.md',
  'security-architecture.md',
  'retention-withdrawal-teardown.md',
] as const;
const requiredCommands = [
  'manifest register --file',
  'import --file',
  'batch close --campaign --batch',
  'report export --campaign --output',
  'report verify --bundle --public-key',
  'campaign withdraw --campaign --confirm',
  'retention run',
  'status',
] as const;

async function text(name: string): Promise<string> {
  return readFile(resolve(pack, name), 'utf8');
}

describe('Shadow Pilot customer delivery pack', () => {
  it('documents the strict Phase A boundary and delivery requirements', async () => {
    const documents = await Promise.all(requiredFiles.map(text));
    const combined = documents.join('\n').toLowerCase();

    for (const phrase of [
      'historical',
      'kubernetes.deployment.rollback',
      'postgresql',
      'require_approval',
      'insufficient_evidence',
      'legal/dpa',
      'external review',
      'named owners',
      'policy digest',
      'declared sample',
      'observation window',
      'retention',
      'deletion',
      'export',
      'usefulness',
      'mismatch adjudication',
      'stop conditions',
    ])
      assert.match(combined, new RegExp(phrase));

    for (const forbidden of ['proven', 'production-ready', 'live-write', 'customer-accepted']) {
      assert.equal(combined.includes(forbidden), false, `unsupported claim: ${forbidden}`);
    }
  });

  it('documents every persisted field and every CLI command without requesting credentials', async () => {
    const [boundary, evaluation, readme, invitation] = await Promise.all([
      text('data-boundary.md'),
      text('historical-evaluation.md'),
      text('README.md'),
      text('invitation.md'),
    ]);
    const documented = `${boundary}\n${evaluation}`;
    for (const field of [
      'schema',
      'campaignId',
      'tenantId',
      'producerId',
      'policyId',
      'policyDigest',
      'batchId',
      'closesAt',
      'index',
      'observationId',
      'digest',
      'keyId',
      'signature',
      'occurredAt',
      'workflow',
      'effectType',
      'tool',
      'destination',
      'productionDecision',
      'productionReasonCode',
    ])
      assert.match(documented, new RegExp(`\\b${field}\\b`));
    for (const command of requiredCommands)
      assert.ok(readme.includes(command), `missing command: ${command}`);
    assert.equal(
      /(?:provide|send|share|include).{0,40}(?:password|token|secret|credential)/i.test(invitation),
      false,
    );
  });

  it('ships a schema-valid, independently verifiable 100-record evidence example', async () => {
    const example = JSON.parse(await text('example-report.json')) as Record<string, unknown>;
    assert.equal(example.schema, 'commander.shadow-report/v1');
    assert.equal((example.counts as Record<string, unknown>).expected, 100);
    assert.deepEqual(example.counts, {
      expected: 100,
      missing: 5,
      rejected: 3,
      failed: 2,
      uncomparable: 10,
      compared: 80,
      matches: 60,
      mismatches: 20,
    });
    const manifests = example.manifests as unknown[];
    for (const manifest of manifests) parseShadowManifest(manifest);
    for (const record of example.records as Array<Record<string, unknown>>) {
      if (record.facts !== undefined) parseShadowObservation(record.facts);
    }
    const trustRecord = JSON.parse(await text('example-report-trust.json')) as Record<
      string,
      string
    >;
    const publicKey = createPublicKey(trustRecord.publicKeyPem!);
    assert.deepEqual(
      verifyShadowReport(example, {
        algorithm: 'Ed25519',
        keyId: trustRecord.keyId!,
        status: trustRecord.status as 'active' | 'revoked',
        publicKey,
      }),
      {
        valid: true,
        code: 'SHADOW_REPORT_VALID',
      },
    );
  });
});
