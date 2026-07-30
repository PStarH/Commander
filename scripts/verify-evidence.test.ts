import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import {
  buildRunEvidenceBundle,
  canonicalEvidenceBody,
  canonicalEvidenceJson,
  createEvidenceSigner,
  type EvidenceBundle,
} from '../packages/effect-broker/src/index.js';

async function resign(
  receipt: EvidenceBundle,
  signer: ReturnType<typeof createEvidenceSigner>,
): Promise<EvidenceBundle> {
  const { contentHash: _contentHash, signature: _signature, ...body } = receipt;
  const contentHash = createHash('sha256').update(canonicalEvidenceJson(body)).digest('hex');
  const resigned = { ...receipt, contentHash };
  resigned.signature = await signer.sign(canonicalEvidenceBody(resigned));
  return resigned;
}

describe('verify-evidence CLI', () => {
  it('returns 0 only for a valid signed terminal receipt', async () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    const signer = createEvidenceSigner({
      privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      keyId: 'cell-cli-1',
    });
    const receipt = buildRunEvidenceBundle({
      tenantId: 'tenant-a',
      runId: 'run-1',
      actionDigest: 'a'.repeat(64),
      policySnapshotId: 'ps-1',
      effects: [
        {
          id: 'effect-1',
          runId: 'run-1',
          stepId: 'step-1',
          tenantId: 'tenant-a',
          type: 'http.write',
          state: 'COMPLETED',
          policyDecisionId: 'pd-1',
          requestHash: 'b'.repeat(64),
          createdAt: '2026-07-17T00:00:00.000Z',
          completedAt: '2026-07-17T00:00:01.000Z',
        },
      ],
      bundleId: 'bundle-cli-1',
      exportedAt: '2026-07-17T00:00:02.000Z',
    });
    receipt.signature = await signer.sign(canonicalEvidenceBody(receipt));
    const dir = mkdtempSync(join(tmpdir(), 'commander-evidence-cli-'));
    try {
      const receiptPath = join(dir, 'receipt.json');
      const jwksPath = join(dir, 'jwks.json');
      writeFileSync(receiptPath, JSON.stringify(receipt));
      writeFileSync(jwksPath, JSON.stringify(signer.jwks));
      const stdout = execFileSync(
        process.execPath,
        ['--import', 'tsx', resolve('scripts/verify-evidence.ts'), receiptPath, '--jwks', jwksPath],
        { encoding: 'utf8' },
      );
      assert.equal(JSON.parse(stdout).ok, true);
      writeFileSync(receiptPath, JSON.stringify({ ...receipt, actionDigest: 'b'.repeat(64) }));
      const invalid = spawnSync(
        process.execPath,
        ['--import', 'tsx', resolve('scripts/verify-evidence.ts'), receiptPath, '--jwks', jwksPath],
        { encoding: 'utf8' },
      );
      assert.equal(invalid.status, 1);
      assert.equal(JSON.parse(invalid.stdout).ok, false);

      const { requestHash: _requestHash, ...effectWithoutRequestHash } = receipt.effects[0];
      const malformedReceipts = [
        await resign(
          {
            ...receipt,
            bodyVersion: 'commander.evidence-body/v2' as EvidenceBundle['bodyVersion'],
          },
          signer,
        ),
        await resign(
          { ...receipt, effects: [effectWithoutRequestHash] as EvidenceBundle['effects'] },
          signer,
        ),
        await resign({ ...receipt, unexpected: true } as EvidenceBundle, signer),
      ];
      for (const malformedReceipt of malformedReceipts) {
        writeFileSync(receiptPath, JSON.stringify(malformedReceipt));
        const malformed = spawnSync(
          process.execPath,
          [
            '--import',
            'tsx',
            resolve('scripts/verify-evidence.ts'),
            receiptPath,
            '--jwks',
            jwksPath,
          ],
          { encoding: 'utf8' },
        );
        assert.equal(malformed.status, 2);
        assert.equal(JSON.parse(malformed.stdout).reason, 'EVIDENCE_INPUT_MALFORMED');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
