import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { canonicalBootstrapJson, canonicalBootstrapSha256 } from './canonicalBootstrap.js';
import {
  createTask1ComposePlatformObserver,
  createTask1ComposeRelayClientFromEnvironment,
  type Task1ComposeRelayClient,
} from './task1ComposeProofRuntime.js';
import type { Task1LifecycleOperation } from './task1LifecycleLedger.js';

const digest = (value: string): string => value.repeat(64).slice(0, 64);
const binding = {
  kind: 'compose',
  projectName: 'commander',
  composeVariant: 'prod',
  composeCredentialInventory: 'runtime-v1',
  composeSourceSha256: digest('a'),
  composeCliVersion: '5.3.1',
  composeContentSha256: digest('b'),
  phase: 'enforce',
  apiImageDigest: `registry.example/commander@sha256:${digest('c')}`,
  apiProofUrl: 'https://api:9443/ready/tenant-authority/v1',
};

function operation(): Task1LifecycleOperation {
  return {
    installationUuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    operationVersion: '7',
    predecessorStateVersion: '6',
    resultingStateVersion: '7',
    predecessorState: 'expanded',
    resultingState: 'enforced',
    operationKind: 'enforce',
    runtimePhase: 'enforce',
    platformKind: 'compose',
    previousBindingJcs: null,
    previousBindingSha256: null,
    requestedBindingJcs: canonicalBootstrapJson(binding),
    requestedBindingSha256: canonicalBootstrapSha256(binding),
    previousConfigurationJcs: null,
    previousConfigurationSha256: null,
    requestedConfigurationJcs: canonicalBootstrapJson({ operationAuditNonce: 'n'.repeat(43) }),
    requestedConfigurationSha256: digest('d'),
    previousBusinessConfigurationSha256: null,
    requestedBusinessConfigurationSha256: digest('e'),
    originBindingSha256: digest('f'),
    databasePeerBindingSha256: digest('1'),
    proofKeySha256: digest('2'),
    descriptorSet: [],
    predecessorEvidenceJcs: canonicalBootstrapJson({ kind: 'fresh-no-predecessor/v1' }),
    predecessorEvidenceSha256: digest('3'),
    predecessorProof: 'fresh-no-predecessor',
    result: 'committed',
  };
}

const relayAttempt = 'attempt-1';
const relayToken = 't'.repeat(43);
const relayContainer = {
  containerId: 'a'.repeat(64),
  projectLabel: 'commander',
  serviceLabel: 'api',
  imageDigest: binding.apiImageDigest,
  createdAt: '2026-07-28T00:00:00.000Z',
  state: 'running',
  health: 'healthy',
  restartCount: 0,
  networkAttachmentIds: { default: 'b'.repeat(64) },
};

async function withRelayResponse(
  responseBody: string,
  run: (client: Task1ComposeRelayClient) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'commander-proof-relay-'));
  const socketPath = join(directory, 'relay.sock');
  const server = createServer((request, response) => {
    assert.equal(request.headers['x-commander-relay-attempt'], relayAttempt);
    assert.equal(request.headers['x-commander-relay-token'], relayToken);
    response.statusCode = 200;
    response.setHeader('content-type', 'application/json');
    response.end(responseBody);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  try {
    await run(
      createTask1ComposeRelayClientFromEnvironment({
        COMMANDER_COMPOSE_TOPOLOGY_RELAY_SOCKET: socketPath,
        COMMANDER_COMPOSE_TOPOLOGY_RELAY_ATTEMPT: relayAttempt,
        COMMANDER_COMPOSE_TOPOLOGY_RELAY_TOKEN: relayToken,
      }),
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(directory, { recursive: true, force: true });
  }
}

describe('Task 1 Compose proof runtime', () => {
  it('projects only the authoritative api container from the relay', async () => {
    const client: Task1ComposeRelayClient = {
      version: async () => ({ schema: 'compose-topology-relay/v1', dockerApiVersion: '1.45' }),
      containers: async () => [
        {
          containerId: 'a'.repeat(64),
          projectLabel: 'commander',
          serviceLabel: 'api',
          imageDigest: binding.apiImageDigest,
          createdAt: '2026-07-28T00:00:00.000Z',
          state: 'running',
          health: 'healthy',
          restartCount: 0,
          networkAttachmentIds: { default: 'n'.repeat(64) },
        },
      ],
      container: async () => ({
        containerId: 'a'.repeat(64),
        projectLabel: 'commander',
        serviceLabel: 'api',
        imageDigest: binding.apiImageDigest,
        createdAt: '2026-07-28T00:00:00.000Z',
        state: 'running',
        health: 'healthy',
        restartCount: 0,
        networkAttachmentIds: { default: 'n'.repeat(64) },
        containerName: 'commander-api-1',
        imageId: `sha256:${digest('9')}`,
      }),
    };
    const facts = await createTask1ComposePlatformObserver(client)(operation());
    assert.equal(facts.topology, 'compose');
    assert.equal(facts.apiProofUrl, binding.apiProofUrl);
    assert.equal(facts.workload.uid, 'a'.repeat(64));
    assert.deepEqual(facts.workload.ready, ['api']);
    assert.equal(facts.metadata.evidenceLevel, 'live');
  });

  it('parses only exact canonical relay DTOs', async () => {
    await withRelayResponse(canonicalBootstrapJson([relayContainer]), async (client) => {
      assert.deepEqual(await client.containers(), [relayContainer]);
    });

    await withRelayResponse(
      canonicalBootstrapJson([
        {
          ...relayContainer,
          Config: { Env: ['COMMANDER_OWNER_DATABASE_URL=must-not-cross-boundary'] },
        },
      ]),
      async (client) => {
        await assert.rejects(
          () => client.containers(),
          /TENANT_CUTOVER_PROOF_RELAY_RESPONSE_INVALID/,
        );
      },
    );

    await withRelayResponse(`${canonicalBootstrapJson([relayContainer])}\n`, async (client) => {
      await assert.rejects(
        () => client.containers(),
        /TENANT_CUTOVER_PROOF_RELAY_RESPONSE_INVALID/,
      );
    });
  });

  it('rejects oversized relay responses before parsing', async () => {
    await withRelayResponse(`"${'x'.repeat(1024 * 1024)}"`, async (client) => {
      await assert.rejects(
        () => client.containers(),
        /TENANT_CUTOVER_PROOF_RELAY_RESPONSE_INVALID/,
      );
    });
  });
});
