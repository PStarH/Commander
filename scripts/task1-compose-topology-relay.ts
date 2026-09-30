import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, lstat, mkdir, unlink } from 'node:fs/promises';
import {
  createServer,
  request,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { join } from 'node:path';
import { canonicalBootstrapJson } from '../packages/kernel/src/canonicalBootstrap.js';

export interface ComposeTopologyRelayCommandPort {
  run(request: {
    program: string;
    args: readonly string[];
    environment: Readonly<Record<string, string>>;
  }): Promise<{ stdout: string }>;
}

export function createDockerCliTopologyAuthority(
  command: ComposeTopologyRelayCommandPort,
  environment: Readonly<Record<string, string>> = {},
): DockerTopologyAuthority {
  const runJson = async (args: readonly string[]): Promise<unknown> => {
    const result = await command.run({ program: 'docker', args, environment });
    try {
      return JSON.parse(result.stdout);
    } catch {
      throw new Error('TENANT_CUTOVER_DOCKER_ENGINE_READ_FAILED');
    }
  };
  const inspect = async (containerIds: readonly string[]): Promise<Record<string, unknown>[]> => {
    if (containerIds.length === 0) return [];
    if (containerIds.some((containerId) => !CONTAINER_ID_PATTERN.test(containerId))) {
      throw new Error('TENANT_CUTOVER_DOCKER_ENGINE_READ_FAILED');
    }
    const parsed = await runJson(['container', 'inspect', ...containerIds]);
    if (!Array.isArray(parsed) || parsed.length !== containerIds.length) {
      throw new Error('TENANT_CUTOVER_DOCKER_ENGINE_READ_FAILED');
    }
    return parsed.map(object);
  };
  return {
    version: () => runJson(['version', '--format', '{{json .Server}}']),
    async listContainers() {
      const result = await command.run({
        program: 'docker',
        args: ['container', 'ls', '--all', '--no-trunc', '--format', '{{.ID}}'],
        environment,
      });
      const containerIds = result.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      return (await inspect(containerIds)).map((container) => ({
        Id: container.Id,
        Labels: object(container.Config).Labels,
      }));
    },
    async inspectContainer(containerId) {
      return (await inspect([containerId]))[0]!;
    },
  };
}

export interface ComposeTopologyRelay {
  read(expectedApiImage: string): Promise<ComposeTopologyRelayV1>;
}

export interface ComposeTopologyRelayV1 {
  schema: 'compose-topology-relay/v1';
  projectName: string;
  api: {
    service: 'api';
    containerId: string;
    image: string;
  };
}

export interface DockerTopologyAuthority {
  version(): Promise<unknown>;
  listContainers(): Promise<unknown>;
  inspectContainer(containerId: string): Promise<unknown>;
}

export interface ComposeTopologyRelayDescriptor {
  socketPath: string;
  attemptId: string;
  token: string;
}

export interface ComposeTopologyRelayContainer {
  containerId: string;
  projectLabel: string;
  serviceLabel: string;
  imageDigest: string;
  createdAt: string;
  state: 'running';
  health: 'healthy';
  restartCount: number;
  networkAttachmentIds: Record<string, string>;
}

export interface ComposeTopologyRelayContainerDetail extends ComposeTopologyRelayContainer {
  containerName: string;
  imageId: string;
}

export interface ComposeTopologyRelaySession {
  descriptor: ComposeTopologyRelayDescriptor;
  close(): Promise<void>;
}

export interface ComposeTopologyRelayStartInput {
  directory: string;
  attemptId: string;
  projectName: string;
  serviceImages: Readonly<Record<string, string>>;
  namedNetworks: readonly string[];
  authority: DockerTopologyAuthority;
}

const API_IMAGE_PATTERN = /^[^\s]+@sha256:[0-9a-f]{64}$/;
const CONTAINER_ID_PATTERN = /^[0-9a-f]{64}$/;
const IMAGE_ID_PATTERN = /^sha256:[0-9a-f]{64}$/;
const ATTEMPT_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const DOCKER_API_VERSION_PATTERN = /^[0-9]+\.[0-9]+$/;
const MAX_REQUEST_BODY_BYTES = 0;

function fail(): never {
  throw new Error('TENANT_CUTOVER_TOPOLOGY_RELAY_INVALID');
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  return value as Record<string, unknown>;
}

function string(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) fail();
  return value;
}

function relayError(response: ServerResponse, statusCode: number): void {
  response.statusCode = statusCode;
  response.setHeader('content-type', 'application/json');
  response.end(canonicalBootstrapJson({ error: 'TENANT_CUTOVER_TOPOLOGY_RELAY_REJECTED' }));
}

function authenticated(
  request: IncomingMessage,
  descriptor: ComposeTopologyRelayDescriptor,
): boolean {
  const attempt = request.headers['x-commander-relay-attempt'];
  const token = request.headers['x-commander-relay-token'];
  if (typeof attempt !== 'string' || typeof token !== 'string') return false;
  const expectedAttempt = Buffer.from(descriptor.attemptId, 'utf8');
  const actualAttempt = Buffer.from(attempt, 'utf8');
  const expectedToken = Buffer.from(descriptor.token, 'utf8');
  const actualToken = Buffer.from(token, 'utf8');
  return (
    actualAttempt.length === expectedAttempt.length &&
    actualToken.length === expectedToken.length &&
    timingSafeEqual(actualAttempt, expectedAttempt) &&
    timingSafeEqual(actualToken, expectedToken)
  );
}

function dockerLabels(value: Record<string, unknown>): { project: string; service: string } {
  const labels = object(value.Labels);
  return {
    project: string(labels['com.docker.compose.project']),
    service: string(labels['com.docker.compose.service']),
  };
}

function composeProjectLabel(value: Record<string, unknown>): string | undefined {
  const labels = value.Labels;
  if (!labels || typeof labels !== 'object' || Array.isArray(labels)) return undefined;
  const project = (labels as Record<string, unknown>)['com.docker.compose.project'];
  return typeof project === 'string' ? project : undefined;
}

function sortedNetworkAttachmentIds(
  value: Record<string, unknown>,
  namedNetworks: readonly string[],
): Record<string, string> {
  const networks = object(object(value.NetworkSettings).Networks);
  if (JSON.stringify(Object.keys(networks).sort()) !== JSON.stringify([...namedNetworks].sort())) {
    fail();
  }
  return Object.fromEntries(
    [...namedNetworks].sort().map((name) => [name, string(object(networks[name]).NetworkID)]),
  );
}

function parseComposePs(value: string): Array<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    fail();
  }
  if (!Array.isArray(parsed)) fail();
  return parsed.map(object);
}

/**
 * Compatibility adapter for the already-wired cutover path. New contained proof
 * launchers must use startComposeTopologyRelay instead.
 */
export function createComposeTopologyRelay(input: {
  projectName: string;
  composeFiles: readonly string[];
  command: ComposeTopologyRelayCommandPort;
  baseEnvironment?: Readonly<Record<string, string>>;
}): ComposeTopologyRelay {
  return {
    async read(expectedApiImage) {
      if (!API_IMAGE_PATTERN.test(expectedApiImage)) fail();
      const result = await input.command.run({
        program: 'docker',
        args: [
          'compose',
          '--project-name',
          input.projectName,
          ...input.composeFiles.flatMap((composeFile) => ['-f', composeFile]),
          'ps',
          '--all',
          '--format',
          'json',
        ],
        environment: input.baseEnvironment ?? {},
      });
      const apiEntries = parseComposePs(result.stdout).filter((entry) => entry.Service === 'api');
      if (apiEntries.length !== 1) fail();
      const api = apiEntries[0]!;
      const containerId = api.ID;
      const image = api.Image;
      if (
        typeof containerId !== 'string' ||
        !/^[0-9a-f]{12,64}$/.test(containerId) ||
        typeof image !== 'string' ||
        image !== expectedApiImage ||
        api.State !== 'running'
      ) {
        fail();
      }
      return {
        schema: 'compose-topology-relay/v1',
        projectName: input.projectName,
        api: { service: 'api', containerId, image },
      };
    },
  };
}

/** Parent-only Docker Engine adapter. Its Unix socket is never exposed to the proof observer. */
export function createDockerEngineTopologyAuthority(
  socketPath = '/var/run/docker.sock',
): DockerTopologyAuthority {
  const get = async (path: string): Promise<unknown> => {
    let body = '';
    await new Promise<void>((resolve, reject) => {
      const req = request({ socketPath, path, method: 'GET' }, (response) => {
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          body += chunk;
        });
        response.once('end', () => {
          if (response.statusCode !== 200)
            reject(new Error('TENANT_CUTOVER_DOCKER_ENGINE_READ_FAILED'));
          else resolve();
        });
      });
      req.once('error', reject);
      req.end();
    });
    try {
      return JSON.parse(body);
    } catch {
      throw new Error('TENANT_CUTOVER_DOCKER_ENGINE_READ_FAILED');
    }
  };
  return {
    version: () => get('/version'),
    listContainers: () => get('/containers/json?all=1'),
    inspectContainer: (containerId) =>
      CONTAINER_ID_PATTERN.test(containerId)
        ? get(`/containers/${containerId}/json`)
        : Promise.reject(new Error('TENANT_CUTOVER_DOCKER_ENGINE_READ_FAILED')),
  };
}

export async function startComposeTopologyRelay(
  input: ComposeTopologyRelayStartInput,
): Promise<ComposeTopologyRelaySession> {
  if (
    !ATTEMPT_ID_PATTERN.test(input.attemptId) ||
    !ATTEMPT_ID_PATTERN.test(input.projectName) ||
    Object.keys(input.serviceImages).length === 0 ||
    input.namedNetworks.length === 0 ||
    new Set(input.namedNetworks).size !== input.namedNetworks.length
  ) {
    fail();
  }
  for (const [service, image] of Object.entries(input.serviceImages)) {
    if (!ATTEMPT_ID_PATTERN.test(service) || !API_IMAGE_PATTERN.test(image)) fail();
  }

  await mkdir(input.directory, { recursive: true, mode: 0o700 });
  await chmod(input.directory, 0o700);
  const descriptor: ComposeTopologyRelayDescriptor = {
    socketPath: join(input.directory, `r-${randomBytes(8).toString('hex')}.sock`),
    attemptId: input.attemptId,
    token: randomBytes(32).toString('base64url'),
  };

  const projectContainers = async (): Promise<ComposeTopologyRelayContainer[]> => {
    const listed = await input.authority.listContainers();
    if (!Array.isArray(listed)) fail();
    const candidates = listed
      .map(object)
      .filter((entry) => composeProjectLabel(entry) === input.projectName)
      .filter((entry) => Object.hasOwn(input.serviceImages, dockerLabels(entry).service));
    const projections = await Promise.all(
      candidates.map(async (entry) => {
        const labels = dockerLabels(entry);
        const containerId = string(entry.Id);
        if (!CONTAINER_ID_PATTERN.test(containerId)) fail();
        return projectContainer(containerId, labels.service, false);
      }),
    );
    return projections.sort((left, right) => left.containerId.localeCompare(right.containerId));
  };

  const projectContainer = async (
    containerId: string,
    expectedService?: string,
    detail = false,
  ): Promise<ComposeTopologyRelayContainer | ComposeTopologyRelayContainerDetail> => {
    if (!CONTAINER_ID_PATTERN.test(containerId)) fail();
    const raw = object(await input.authority.inspectContainer(containerId));
    if (string(raw.Id) !== containerId) fail();
    const config = object(raw.Config);
    const labels = dockerLabels(config);
    if (
      labels.project !== input.projectName ||
      (expectedService !== undefined && labels.service !== expectedService) ||
      !Object.hasOwn(input.serviceImages, labels.service) ||
      config.Image !== input.serviceImages[labels.service]
    ) {
      fail();
    }
    const createdAt = string(raw.Created);
    if (!Number.isFinite(Date.parse(createdAt))) fail();
    const state = object(raw.State);
    if (state.Status !== 'running' || object(state.Health).Status !== 'healthy') fail();
    const restartCount = state.RestartCount;
    if (
      typeof restartCount !== 'number' ||
      !Number.isSafeInteger(restartCount) ||
      restartCount < 0 ||
      restartCount !== 0
    ) {
      fail();
    }
    const imageId = string(raw.Image);
    if (!IMAGE_ID_PATTERN.test(imageId)) fail();
    const projection: ComposeTopologyRelayContainer = {
      containerId,
      projectLabel: labels.project,
      serviceLabel: labels.service,
      imageDigest: string(config.Image),
      createdAt,
      state: 'running',
      health: 'healthy',
      restartCount,
      networkAttachmentIds: sortedNetworkAttachmentIds(raw, input.namedNetworks),
    };
    if (!detail) return projection;
    return { ...projection, containerName: string(raw.Name), imageId };
  };

  const route = async (path: string): Promise<unknown> => {
    if (path === '/version') {
      const version = object(await input.authority.version());
      const dockerApiVersion = string(version.ApiVersion);
      if (!DOCKER_API_VERSION_PATTERN.test(dockerApiVersion)) fail();
      return { schema: 'compose-topology-relay/v1', dockerApiVersion };
    }
    if (path === '/containers/json') return projectContainers();
    const match = path.match(/^\/containers\/([0-9a-f]{64})\/json$/);
    if (match) {
      const containers = await projectContainers();
      if (!containers.some((container) => container.containerId === match[1])) fail();
      return projectContainer(match[1]!, undefined, true);
    }
    fail();
  };

  let closed = false;
  const server = createServer((request, response) => {
    let bodyBytes = 0;
    request.on('data', (chunk: Buffer) => {
      bodyBytes += chunk.byteLength;
    });
    request.once('end', () => {
      void (async () => {
        if (
          closed ||
          request.method !== 'GET' ||
          bodyBytes !== MAX_REQUEST_BODY_BYTES ||
          !authenticated(request, descriptor) ||
          request.url === undefined ||
          request.url.includes('?') ||
          request.headers['content-length'] !== undefined
        ) {
          relayError(response, 403);
          return;
        }
        try {
          const projection = await route(request.url);
          response.statusCode = 200;
          response.setHeader('content-type', 'application/json');
          response.end(canonicalBootstrapJson(projection));
        } catch {
          relayError(response, 403);
        }
      })();
    });
    request.once('error', () => relayError(response, 403));
  });
  await listen(server, descriptor.socketPath);
  await chmod(descriptor.socketPath, 0o600);
  if (((await lstat(descriptor.socketPath)).mode & 0o777) !== 0o600) fail();

  return {
    descriptor,
    async close() {
      if (closed) return;
      closed = true;
      await closeServer(server);
      await unlink(descriptor.socketPath).catch(() => undefined);
    },
  };
}

/** Runs one observer attempt and guarantees that its inherited relay is destroyed afterward. */
export async function withComposeTopologyRelay<T>(
  input: ComposeTopologyRelayStartInput,
  observe: (descriptor: Readonly<ComposeTopologyRelayDescriptor>) => Promise<T>,
): Promise<T> {
  const relay = await startComposeTopologyRelay(input);
  try {
    return await observe(relay.descriptor);
  } finally {
    await relay.close();
  }
}

function listen(server: Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
