import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  buildSignedEvidenceBundle,
  canonicalEvidenceBody,
} from '../packages/effect-broker/src/signedEvidence.js';
import { createEvidenceSigner } from '../packages/effect-broker/src/evidenceSigner.js';
import { runGatewayCampaign, type GatewayCampaignOptions } from './g3-gateway-campaign.js';

const digest = 'a'.repeat(64);

async function receipt() {
  const { privateKey } = generateKeyPairSync('ed25519');
  const signer = createEvidenceSigner({
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    keyId: 'g3-test-evidence',
  });
  const bundle = buildSignedEvidenceBundle({
    tenantId: 'tenant-a',
    runId: 'run-g3-1',
    effectId: 'effect-g3-1',
    actionDigest: digest,
    policySnapshotId: 'policy-g3',
    bundleId: 'bundle-g3-1',
    exportedAt: '2026-08-14T00:00:00.000Z',
    effects: [
      {
        id: 'effect-g3-1',
        tenantId: 'tenant-a',
        runId: 'run-g3-1',
        stepId: 'step-g3-1',
        type: 'mutate.kubernetes.deployment.rollback',
        state: 'COMPLETED',
        policyDecisionId: 'policy-g3',
        requestHash: 'b'.repeat(64),
        createdAt: '2026-08-14T00:00:00.000Z',
        completedAt: '2026-08-14T00:00:01.000Z',
      },
    ],
  });
  bundle.signature = await signer.sign(canonicalEvidenceBody(bundle));
  return { bundle, jwks: signer.jwks };
}

async function withGateway(
  handler: (
    request: import('node:http').IncomingMessage,
    response: import('node:http').ServerResponse,
  ) => void,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

describe('G3 Gateway HTTP campaign', () => {
  it('rejects an incomplete action envelope before any Gateway request', async () => {
    await assert.rejects(
      () =>
        runGatewayCampaign({
          gatewayUrl: 'http://127.0.0.1:1',
          submitBearerToken: 'submit-secret',
          approverBearerToken: 'approver-secret',
          tenantId: 'tenant-a',
          source: 'g3-campaign',
          packageName: 'commander',
          model: 'operator',
          tool: '',
          destination: 'k8s://fresh-g3/tenant-a/deployments/nginx',
          effectType: 'mutate.kubernetes.deployment.rollback',
          args: {},
          idempotencyKey: 'g3-campaign-key-0001',
          evidenceJwks: { keys: [] },
          sourceSha: 'b9512df8997580550e3d662823e4167b6f5d9741',
          imageDigest: `sha256:${'c'.repeat(64)}`,
          outputDir: join(tmpdir(), 'g3-campaign'),
        }),
      /G3_TOOL_REQUIRED/,
    );
  });

  it('rejects unusable evidence JWKS before any Gateway request', async () => {
    const { jwks } = await receipt();
    let requests = 0;

    await withGateway(
      (_request, response) => {
        requests += 1;
        response.statusCode = 500;
        response.end();
      },
      async (gatewayUrl) => {
        await assert.rejects(
          () =>
            runGatewayCampaign({
              gatewayUrl,
              submitBearerToken: 'submit-secret',
              approverBearerToken: 'approver-secret',
              tenantId: 'tenant-a',
              source: 'g3-campaign',
              packageName: 'commander',
              model: 'operator',
              tool: 'kubernetes.deployment.rollback',
              destination: 'k8s://fresh-g3/tenant-a/deployments/nginx',
              effectType: 'mutate.kubernetes.deployment.rollback',
              args: {},
              idempotencyKey: 'g3-campaign-key-0001',
              evidenceJwks: { keys: [] },
              sourceSha: 'b9512df8997580550e3d662823e4167b6f5d9741',
              imageDigest: `sha256:${'c'.repeat(64)}`,
              outputDir: join(tmpdir(), 'g3-campaign'),
            }),
          /G3_EVIDENCE_JWKS_INVALID/,
        );
        await assert.rejects(
          () =>
            runGatewayCampaign({
              gatewayUrl,
              submitBearerToken: 'submit-secret',
              approverBearerToken: 'approver-secret',
              tenantId: 'tenant-a',
              source: 'g3-campaign',
              packageName: 'commander',
              model: 'operator',
              tool: 'kubernetes.deployment.rollback',
              destination: 'k8s://fresh-g3/tenant-a/deployments/nginx',
              effectType: 'mutate.kubernetes.deployment.rollback',
              args: {},
              idempotencyKey: 'g3-campaign-key-0001',
              evidenceJwks: { keys: [{ ...jwks.keys[0], x: 'not-a-valid-jwk' }] },
              sourceSha: 'b9512df8997580550e3d662823e4167b6f5d9741',
              imageDigest: `sha256:${'c'.repeat(64)}`,
              outputDir: join(tmpdir(), 'g3-campaign'),
            }),
          /G3_EVIDENCE_JWKS_INVALID/,
        );
      },
    );

    assert.equal(requests, 0);
  });

  it('uses Gateway submit, approval, observation, recovery, and evidence endpoints without persisting secrets', async () => {
    const outputDir = await mkdtemp(join(tmpdir(), 'g3-campaign-'));
    const { bundle, jwks } = await receipt();
    const seen: Array<{ method?: string; url?: string; authorization?: string }> = [];
    let gets = 0;
    let reconciled = false;

    await withGateway(
      (request, response) => {
        seen.push({
          method: request.method,
          url: request.url,
          authorization: request.headers.authorization,
        });
        response.setHeader('content-type', 'application/json');
        if (request.method === 'POST' && request.url === '/v1/actions') {
          response.end(
            JSON.stringify({
              action: {
                runId: 'run-g3-1',
                actionDigest: digest,
                policySnapshotId: 'policy-g3',
                simulation: { simulationId: 'sim-g3-1' },
              },
            }),
          );
          return;
        }
        if (request.method === 'POST' && request.url === '/v1/actions/run-g3-1/approve') {
          response.end(JSON.stringify({ action: { runId: 'run-g3-1', state: 'APPROVED' } }));
          return;
        }
        if (request.method === 'GET' && request.url === '/v1/actions/run-g3-1') {
          gets += 1;
          response.end(
            JSON.stringify({
              action: {
                runId: 'run-g3-1',
                effectId: 'effect-g3-1',
                actionDigest: digest,
                state: gets === 1 || !reconciled ? 'COMPLETION_UNKNOWN' : 'SUCCEEDED',
              },
            }),
          );
          return;
        }
        if (request.method === 'POST' && request.url === '/v1/actions/run-g3-1/reconcile') {
          reconciled = true;
          response.end(JSON.stringify({ accepted: true }));
          return;
        }
        if (request.method === 'GET' && request.url === '/v1/actions/run-g3-1/evidence') {
          response.end(JSON.stringify({ receipt: bundle, verification: { ok: true } }));
          return;
        }
        response.statusCode = 404;
        response.end(JSON.stringify({ error: 'not_found' }));
      },
      async (gatewayUrl) => {
        const options: GatewayCampaignOptions = {
          gatewayUrl,
          submitBearerToken: 'submit-secret',
          approverBearerToken: 'approver-secret',
          tenantId: 'tenant-a',
          source: 'g3-campaign',
          packageName: 'commander',
          model: 'operator',
          tool: 'kubernetes.deployment.rollback',
          destination: 'k8s://fresh-g3/tenant-a/deployments/nginx',
          effectType: 'mutate.kubernetes.deployment.rollback',
          args: { revision: '1', secret: 'must-not-persist' },
          idempotencyKey: 'g3-campaign-key-0001',
          evidenceJwks: jwks,
          sourceSha: 'b9512df8997580550e3d662823e4167b6f5d9741',
          imageDigest: `sha256:${'c'.repeat(64)}`,
          outputDir,
          pollIntervalMs: 1,
          timeoutMs: 1_000,
        };
        const result = await runGatewayCampaign(options);
        assert.equal(result.verdict, 'PASS');
        assert.equal(result.artifact.action.runId, 'run-g3-1');
        assert.equal(result.artifact.recovery.observedCompletionUnknown, true);
        assert.equal(result.artifact.receipt.sha256.length, 64);
        const body = await readFile(result.artifactPath, 'utf8');
        assert.doesNotMatch(body, /submit-secret|approver-secret|must-not-persist/);
        assert.deepEqual(
          seen.map((entry) => `${entry.method} ${entry.url}`),
          [
            'POST /v1/actions',
            'POST /v1/actions/run-g3-1/approve',
            'GET /v1/actions/run-g3-1',
            'POST /v1/actions/run-g3-1/reconcile',
            'GET /v1/actions/run-g3-1',
            'GET /v1/actions/run-g3-1/evidence',
          ],
        );
      },
    );

    await rm(outputDir, { recursive: true, force: true });
  });
});
