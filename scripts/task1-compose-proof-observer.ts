import { request } from 'node:http';
import type {
  ComposeTopologyRelayContainer,
  ComposeTopologyRelayContainerDetail,
  ComposeTopologyRelayDescriptor,
} from './task1-compose-topology-relay.js';

const CONTAINER_ID_PATTERN = /^[0-9a-f]{64}$/;
const RESPONSE_LIMIT_BYTES = 1024 * 1024;

function fail(code = 'TENANT_CUTOVER_PROOF_OBSERVER_RESPONSE_INVALID'): never {
  throw new Error(code);
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) fail();
}

function string(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) fail();
  return value;
}

function container(value: unknown, detail: boolean): ComposeTopologyRelayContainer | ComposeTopologyRelayContainerDetail {
  const record = object(value);
  const baseKeys = [
    'containerId',
    'projectLabel',
    'serviceLabel',
    'imageDigest',
    'createdAt',
    'state',
    'health',
    'restartCount',
    'networkAttachmentIds',
  ];
  exactKeys(record, detail ? [...baseKeys, 'containerName', 'imageId'] : baseKeys);
  const containerId = string(record.containerId);
  if (!CONTAINER_ID_PATTERN.test(containerId) || record.state !== 'running' || record.health !== 'healthy') {
    fail();
  }
  if (!Number.isSafeInteger(record.restartCount) || record.restartCount !== 0) fail();
  const networkAttachmentIds = object(record.networkAttachmentIds);
  for (const [name, id] of Object.entries(networkAttachmentIds)) {
    if (!name || typeof id !== 'string' || id.length === 0) fail();
  }
  const projection: ComposeTopologyRelayContainer = {
    containerId,
    projectLabel: string(record.projectLabel),
    serviceLabel: string(record.serviceLabel),
    imageDigest: string(record.imageDigest),
    createdAt: string(record.createdAt),
    state: 'running',
    health: 'healthy',
    restartCount: record.restartCount,
    networkAttachmentIds: Object.fromEntries(
      Object.entries(networkAttachmentIds).sort(([left], [right]) => left.localeCompare(right)),
    ) as Record<string, string>,
  };
  return detail
    ? { ...projection, containerName: string(record.containerName), imageId: string(record.imageId) }
    : projection;
}

export interface ComposeProofObserver {
  version(): Promise<{ schema: 'compose-topology-relay/v1'; dockerApiVersion: string }>;
  containers(): Promise<ComposeTopologyRelayContainer[]>;
  container(containerId: string): Promise<ComposeTopologyRelayContainerDetail>;
}

export function createComposeProofObserver(
  descriptor: Readonly<ComposeTopologyRelayDescriptor>,
): ComposeProofObserver {
  const get = async (path: string): Promise<unknown> => {
    let responseBody = '';
    await new Promise<void>((resolve, reject) => {
      const req = request(
        {
          socketPath: descriptor.socketPath,
          path,
          method: 'GET',
          headers: {
            'x-commander-relay-attempt': descriptor.attemptId,
            'x-commander-relay-token': descriptor.token,
          },
        },
        (response) => {
          let bytes = 0;
          response.setEncoding('utf8');
          response.on('data', (chunk: string) => {
            bytes += Buffer.byteLength(chunk, 'utf8');
            if (bytes > RESPONSE_LIMIT_BYTES) req.destroy(new Error('TENANT_CUTOVER_PROOF_OBSERVER_RESPONSE_INVALID'));
            else responseBody += chunk;
          });
          response.once('end', () => {
            if (response.statusCode !== 200) reject(new Error('TENANT_CUTOVER_PROOF_OBSERVER_REQUEST_REJECTED'));
            else resolve();
          });
        },
      );
      req.once('error', reject);
      req.end();
    });
    try {
      return JSON.parse(responseBody);
    } catch {
      fail();
    }
  };

  return {
    async version() {
      const projection = object(await get('/version'));
      exactKeys(projection, ['schema', 'dockerApiVersion']);
      if (projection.schema !== 'compose-topology-relay/v1') fail();
      return {
        schema: 'compose-topology-relay/v1',
        dockerApiVersion: string(projection.dockerApiVersion),
      };
    },
    async containers() {
      const projection = await get('/containers/json');
      if (!Array.isArray(projection)) fail();
      const containers = projection.map((entry) => container(entry, false) as ComposeTopologyRelayContainer);
      const sorted = [...containers].sort((left, right) => left.containerId.localeCompare(right.containerId));
      if (JSON.stringify(containers) !== JSON.stringify(sorted)) fail();
      return containers;
    },
    async container(containerId) {
      if (!CONTAINER_ID_PATTERN.test(containerId)) fail('TENANT_CUTOVER_PROOF_OBSERVER_REQUEST_INVALID');
      return container(await get(`/containers/${containerId}/json`), true) as ComposeTopologyRelayContainerDetail;
    },
  };
}
