import assert from 'node:assert/strict';
import { mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { request } from 'node:http';
import {
  startComposeTopologyRelay,
  withComposeTopologyRelay,
  type DockerTopologyAuthority,
} from './task1-compose-topology-relay.js';
import { createComposeProofObserver } from './task1-compose-proof-observer.js';

const apiImage =
  'registry.example/commander@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const workerImage =
  'registry.example/worker@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function authorityFixture(): DockerTopologyAuthority {
  return {
    async version() {
      return { ApiVersion: '1.47', Env: ['must-not-cross'] };
    },
    async listContainers() {
      return [
        { Id: 'e'.repeat(64), Image: 'unrelated:latest' },
        { Id: 'b'.repeat(64), Labels: { 'com.docker.compose.project': 'commander-prod', 'com.docker.compose.service': 'worker' } },
        { Id: 'a'.repeat(64), Labels: { 'com.docker.compose.project': 'commander-prod', 'com.docker.compose.service': 'api' } },
      ];
    },
    async inspectContainer(id) {
      const api = id === 'a'.repeat(64);
      return {
        Id: id,
        Name: api ? '/commander-prod-api-1' : '/commander-prod-worker-1',
        Created: '2026-07-28T01:02:03.000000000Z',
        Image: `sha256:${api ? 'c'.repeat(64) : 'd'.repeat(64)}`,
        Config: {
          Image: api ? apiImage : workerImage,
          Env: ['DATABASE_URL=postgres://must-not-cross'],
          Cmd: ['must-not-cross'],
          Labels: {
            'com.docker.compose.project': 'commander-prod',
            'com.docker.compose.service': api ? 'api' : 'worker',
            'private.label': 'must-not-cross',
          },
        },
        State: { Status: 'running', Health: { Status: 'healthy' }, RestartCount: 0 },
        HostConfig: { Binds: ['/host/must-not-cross:/container/must-not-cross'] },
        Mounts: [{ Source: '/host/must-not-cross' }],
        NetworkSettings: {
          Networks: {
            'commander-prod_default': {
              NetworkID: 'network-1',
              IPAddress: '10.0.0.2',
              Aliases: ['must-not-cross'],
            },
          },
        },
      };
    },
  };
}

describe('Compose proof observer', () => {
  it('uses an attempt-authenticated 0600 Unix relay and receives only closed projections', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'commander-compose-relay-'));
    const relay = await startComposeTopologyRelay({
      directory,
      attemptId: 'attempt-1',
      projectName: 'commander-prod',
      serviceImages: { api: apiImage, worker: workerImage },
      namedNetworks: ['commander-prod_default'],
      authority: authorityFixture(),
    });
    try {
      assert.equal((await stat(relay.descriptor.socketPath)).mode & 0o777, 0o600);
      const observer = createComposeProofObserver(relay.descriptor);

      assert.deepEqual(await observer.version(), {
        schema: 'compose-topology-relay/v1',
        dockerApiVersion: '1.47',
      });
      const containers = await observer.containers();
      assert.deepEqual(containers.map((container) => container.serviceLabel), ['api', 'worker']);
      assert.deepEqual(containers[0], {
        containerId: 'a'.repeat(64),
        projectLabel: 'commander-prod',
        serviceLabel: 'api',
        imageDigest: apiImage,
        createdAt: '2026-07-28T01:02:03.000000000Z',
        state: 'running',
        health: 'healthy',
        restartCount: 0,
        networkAttachmentIds: { 'commander-prod_default': 'network-1' },
      });
      assert.deepEqual(await observer.container('a'.repeat(64)), {
        ...containers[0],
        containerName: '/commander-prod-api-1',
        imageId: `sha256:${'c'.repeat(64)}`,
      });
      assert.doesNotMatch(JSON.stringify({ containers, detail: await observer.container('a'.repeat(64)) }), /must-not-cross|DATABASE_URL|HostConfig|Mounts|Aliases|IPAddress|private\.label/);
    } finally {
      await relay.close();
    }
    await assert.rejects(() => stat(relay.descriptor.socketPath));
  });

  it('rejects an unauthenticated, reused, or unallowlisted relay request', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'commander-compose-relay-'));
    const relay = await startComposeTopologyRelay({
      directory,
      attemptId: 'attempt-2',
      projectName: 'commander-prod',
      serviceImages: { api: apiImage },
      namedNetworks: ['commander-prod_default'],
      authority: authorityFixture(),
    });
    try {
      await assert.rejects(() => rawRequest(relay.descriptor.socketPath, '/containers/json', {}), /403/);
      await assert.rejects(
        () => rawRequest(relay.descriptor.socketPath, '/containers/json?all=1', relay.descriptor),
        /403/,
      );
      await assert.rejects(
        () => rawRequest(relay.descriptor.socketPath, '/containers/' + 'f'.repeat(64) + '/json', relay.descriptor),
        /403/,
      );
    } finally {
      await relay.close();
    }
    await assert.rejects(
      () => rawRequest(relay.descriptor.socketPath, '/version', relay.descriptor),
    );
  });

  it('projects only services registered for the proof attempt', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'commander-compose-relay-'));
    const relay = await startComposeTopologyRelay({
      directory,
      attemptId: 'attempt-registered-services',
      projectName: 'commander-prod',
      serviceImages: { api: apiImage },
      namedNetworks: ['commander-prod_default'],
      authority: authorityFixture(),
    });
    try {
      assert.deepEqual(
        (await createComposeProofObserver(relay.descriptor).containers()).map(
          (container) => container.serviceLabel,
        ),
        ['api'],
      );
    } finally {
      await relay.close();
    }
  });

  it('closes and removes the relay even when the observer attempt fails', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'commander-compose-relay-'));
    let socketPath = '';
    await assert.rejects(
      () =>
        withComposeTopologyRelay(
          {
            directory,
            attemptId: 'attempt-3',
            projectName: 'commander-prod',
            serviceImages: { api: apiImage },
            namedNetworks: ['commander-prod_default'],
            authority: authorityFixture(),
          },
          async (descriptor) => {
            socketPath = descriptor.socketPath;
            await createComposeProofObserver(descriptor).version();
            throw new Error('observer-failed');
          },
        ),
      /observer-failed/,
    );
    assert.ok(socketPath);
    await assert.rejects(() => stat(socketPath));
  });
});

function rawRequest(
  socketPath: string,
  path: string,
  descriptor: Partial<{ attemptId: string; token: string }>,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = request({
      socketPath,
      path,
      method: 'GET',
      headers: {
        ...(descriptor.attemptId === undefined ? {} : { 'x-commander-relay-attempt': descriptor.attemptId }),
        ...(descriptor.token === undefined ? {} : { 'x-commander-relay-token': descriptor.token }),
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => {
        if ((response.statusCode ?? 500) !== 200) {
          reject(new Error(String(response.statusCode)));
          return;
        }
        resolve(Buffer.concat(chunks).toString('utf8'));
      });
    });
    req.once('error', reject);
    req.end();
  });
}
