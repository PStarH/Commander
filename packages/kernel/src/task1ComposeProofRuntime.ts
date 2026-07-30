import { request } from 'node:http';
import { readFile } from 'node:fs/promises';
import { canonicalBootstrapJson, canonicalBootstrapSha256 } from './canonicalBootstrap.js';
import type { Task1LifecycleOperation } from './task1LifecycleLedger.js';
import type { Task1AuthoritativePlatformFacts } from './task1RolloutProof.js';

export interface Task1ComposeRelayContainer {
  containerId: string; projectLabel: string; serviceLabel: string; imageDigest: string;
  createdAt: string; state: 'running'; health: 'healthy'; restartCount: number;
  networkAttachmentIds: Record<string, string>;
}
export interface Task1ComposeRelayContainerDetail extends Task1ComposeRelayContainer {
  containerName: string; imageId: string;
}
export interface Task1ComposeRelayClient {
  version(): Promise<{ schema: 'compose-topology-relay/v1'; dockerApiVersion: string }>;
  containers(): Promise<Task1ComposeRelayContainer[]>;
  container(containerId: string): Promise<Task1ComposeRelayContainerDetail>;
}

type JsonRecord = Record<string, unknown>;
const IMAGE = /^[^\s]+@sha256:[0-9a-f]{64}$/;
const CONTAINER_ID = /^[0-9a-f]{64}$/;
const IMAGE_ID = /^sha256:[0-9a-f]{64}$/;
const RELAY_ATTEMPT = /^[A-Za-z0-9_-]{1,128}$/;
const RELAY_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const MAX_RELAY_RESPONSE_BYTES = 1024 * 1024;
const CONTAINER_KEYS = [
  'containerId', 'projectLabel', 'serviceLabel', 'imageDigest', 'createdAt',
  'state', 'health', 'restartCount', 'networkAttachmentIds',
] as const;
const CONTAINER_DETAIL_KEYS = [...CONTAINER_KEYS, 'containerName', 'imageId'] as const;

function fail(code = 'TENANT_CUTOVER_PROOF_PLATFORM_MISMATCH'): never { throw new Error(code); }
function object(value: unknown): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  return value as JsonRecord;
}

function exactKeys(value: JsonRecord, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  if (actual.length !== required.length || actual.some((key, index) => key !== required[index])) {
    fail('TENANT_CUTOVER_PROOF_RELAY_RESPONSE_INVALID');
  }
}

function relayString(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || /[\u0000-\u001f\u007f]/.test(value)) {
    fail('TENANT_CUTOVER_PROOF_RELAY_RESPONSE_INVALID');
  }
  return value;
}

function relayNetworks(value: unknown): Record<string, string> {
  const networks = object(value);
  const entries = Object.entries(networks);
  if (entries.length === 0) fail('TENANT_CUTOVER_PROOF_RELAY_RESPONSE_INVALID');
  let previous = '';
  for (const [name, id] of entries) {
    if (!name || name <= previous || !CONTAINER_ID.test(relayString(id))) {
      fail('TENANT_CUTOVER_PROOF_RELAY_RESPONSE_INVALID');
    }
    previous = name;
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

function relayContainer(value: unknown, detail: false): Task1ComposeRelayContainer;
function relayContainer(value: unknown, detail: true): Task1ComposeRelayContainerDetail;
function relayContainer(
  value: unknown,
  detail: boolean,
): Task1ComposeRelayContainer | Task1ComposeRelayContainerDetail {
  const entry = object(value);
  exactKeys(entry, detail ? CONTAINER_DETAIL_KEYS : CONTAINER_KEYS);
  const containerId = relayString(entry.containerId);
  const imageDigest = relayString(entry.imageDigest);
  const createdAt = relayString(entry.createdAt);
  const restartCount = entry.restartCount;
  if (
    !CONTAINER_ID.test(containerId) || !IMAGE.test(imageDigest) ||
    !Number.isFinite(Date.parse(createdAt)) || entry.state !== 'running' ||
    entry.health !== 'healthy' || typeof restartCount !== 'number' ||
    !Number.isSafeInteger(restartCount) || restartCount < 0
  ) {
    fail('TENANT_CUTOVER_PROOF_RELAY_RESPONSE_INVALID');
  }
  const projection: Task1ComposeRelayContainer = {
    containerId,
    projectLabel: relayString(entry.projectLabel),
    serviceLabel: relayString(entry.serviceLabel),
    imageDigest,
    createdAt,
    state: 'running',
    health: 'healthy',
    restartCount,
    networkAttachmentIds: relayNetworks(entry.networkAttachmentIds),
  };
  if (!detail) return projection;
  const imageId = relayString(entry.imageId);
  if (!IMAGE_ID.test(imageId)) fail('TENANT_CUTOVER_PROOF_RELAY_RESPONSE_INVALID');
  return { ...projection, containerName: relayString(entry.containerName), imageId };
}

function relayContainers(value: unknown): Task1ComposeRelayContainer[] {
  if (!Array.isArray(value) || value.length > 256) {
    fail('TENANT_CUTOVER_PROOF_RELAY_RESPONSE_INVALID');
  }
  const containers = value.map((entry) => relayContainer(entry, false));
  for (let index = 1; index < containers.length; index += 1) {
    if (containers[index - 1]!.containerId >= containers[index]!.containerId) {
      fail('TENANT_CUTOVER_PROOF_RELAY_RESPONSE_INVALID');
    }
  }
  return containers;
}

function composeBinding(operation: Task1LifecycleOperation): JsonRecord & {
  projectName: string;
  apiImageDigest: string;
  apiProofUrl: string;
} {
  let parsed: unknown;
  try { parsed = JSON.parse(operation.requestedBindingJcs); } catch { return fail(); }
  const binding = object(parsed);
  if (
    operation.platformKind !== 'compose' || binding.kind !== 'compose' || binding.phase !== operation.runtimePhase
    || typeof binding.projectName !== 'string' || typeof binding.apiImageDigest !== 'string'
    || !IMAGE.test(binding.apiImageDigest) || typeof binding.apiProofUrl !== 'string'
    || canonicalBootstrapJson(binding) !== operation.requestedBindingJcs
    || canonicalBootstrapSha256(binding) !== operation.requestedBindingSha256
  ) return fail();
  return binding as JsonRecord & {
    projectName: string;
    apiImageDigest: string;
    apiProofUrl: string;
  };
}

export function createTask1ComposePlatformObserver(
  client: Task1ComposeRelayClient,
): (operation: Task1LifecycleOperation) => Promise<Task1AuthoritativePlatformFacts> {
  return async (operation) => {
    const binding = composeBinding(operation);
    const version = await client.version();
    if (version.schema !== 'compose-topology-relay/v1' || !/^\d+\.\d+$/.test(version.dockerApiVersion)) fail();
    const containers = await client.containers();
    const api = containers.filter((entry) =>
      entry.projectLabel === binding.projectName && entry.serviceLabel === 'api'
      && entry.imageDigest === binding.apiImageDigest,
    );
    if (api.length !== 1) fail();
    const detail = await client.container(api[0]!.containerId);
    if (
      detail.containerId !== api[0]!.containerId || detail.projectLabel !== binding.projectName
      || detail.serviceLabel !== 'api' || detail.imageDigest !== binding.apiImageDigest
      || detail.state !== 'running' || detail.health !== 'healthy' || detail.restartCount !== 0
      || detail.createdAt !== api[0]!.createdAt
      || canonicalBootstrapJson(detail.networkAttachmentIds) !== canonicalBootstrapJson(api[0]!.networkAttachmentIds)
    ) fail();
    const artifact: JsonRecord = {
      format: 'compose-runtime-projection/v1', projectName: binding.projectName,
      api: {
        service: 'api', containerId: detail.containerId, imageDigest: detail.imageDigest,
        containerName: detail.containerName, imageId: detail.imageId,
        createdAt: detail.createdAt, networkAttachmentIds: detail.networkAttachmentIds,
      },
    };
    const artifactSha256 = canonicalBootstrapSha256(artifact);
    const generation = String(Date.parse(detail.createdAt));
    if (!/^\d+$/.test(generation) || Number(generation) <= 0) fail();
    return {
      topology: 'compose', apiProofUrl: binding.apiProofUrl,
      platformArtifact: artifact, platformArtifactSha256: artifactSha256,
      workload: { uid: detail.containerId, generation, observedGeneration: generation,
        templateSha256: canonicalBootstrapSha256({ imageDigest: detail.imageDigest, networkAttachmentIds: detail.networkAttachmentIds }), ready: ['api'] },
      pinned: { schema: version.schema, dockerApiVersion: version.dockerApiVersion, projectName: binding.projectName },
      metadata: { specRevision: 27, evidenceLevel: 'live', writeOwner: 'commander_owner', publicationPoint: 'commander_tenant_cutover_rollout_proofs' },
    };
  };
}

export function createTask1ComposeRelayClientFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): Task1ComposeRelayClient {
  const socketPath = env.COMMANDER_COMPOSE_TOPOLOGY_RELAY_SOCKET;
  const attemptId = env.COMMANDER_COMPOSE_TOPOLOGY_RELAY_ATTEMPT;
  const token = env.COMMANDER_COMPOSE_TOPOLOGY_RELAY_TOKEN;
  if (
    !socketPath || !attemptId || !token || !RELAY_ATTEMPT.test(attemptId) ||
    !RELAY_TOKEN.test(token)
  ) {
    throw new Error('TENANT_CUTOVER_PROOF_RELAY_REQUIRED');
  }
  const get = async (path: string): Promise<unknown> => new Promise((resolve, reject) => {
    const call = request({ socketPath, path, method: 'GET', headers: {
      'x-commander-relay-attempt': attemptId, 'x-commander-relay-token': token,
    } }, (response) => {
      const chunks: Buffer[] = [];
      let responseBytes = 0;
      response.on('data', (chunk: Buffer) => {
        responseBytes += chunk.byteLength;
        if (responseBytes > MAX_RELAY_RESPONSE_BYTES) {
          response.destroy();
          reject(new Error('TENANT_CUTOVER_PROOF_RELAY_RESPONSE_INVALID'));
          return;
        }
        chunks.push(chunk);
      });
      response.once('end', () => {
        if (response.statusCode !== 200) return reject(new Error('TENANT_CUTOVER_PROOF_RELAY_REJECTED'));
        try {
          const body = Buffer.concat(chunks).toString('utf8');
          const parsed = JSON.parse(body) as unknown;
          if (canonicalBootstrapJson(parsed) !== body) {
            reject(new Error('TENANT_CUTOVER_PROOF_RELAY_RESPONSE_INVALID'));
            return;
          }
          resolve(parsed);
        } catch {
          reject(new Error('TENANT_CUTOVER_PROOF_RELAY_RESPONSE_INVALID'));
        }
      });
    });
    call.once('error', reject); call.end();
  });
  return {
    version: async () => {
      const value = object(await get('/version'));
      exactKeys(value, ['schema', 'dockerApiVersion']);
      if (value.schema !== 'compose-topology-relay/v1' || typeof value.dockerApiVersion !== 'string') {
        fail('TENANT_CUTOVER_PROOF_RELAY_RESPONSE_INVALID');
      }
      return { schema: value.schema, dockerApiVersion: value.dockerApiVersion };
    },
    containers: async () => relayContainers(await get('/containers/json')),
    container: async (id) => {
      if (!CONTAINER_ID.test(id)) fail('TENANT_CUTOVER_PROOF_RELAY_RESPONSE_INVALID');
      return relayContainer(await get(`/containers/${id}/json`), true);
    },
  };
}

export async function readTask1ProofCa(path: string): Promise<Buffer> {
  return readFile(path);
}
