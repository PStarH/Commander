import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createComposeTopologyRelay,
  createDockerCliTopologyAuthority,
  type ComposeTopologyRelayCommandPort,
} from './task1-compose-topology-relay.js';

const apiImage =
  'registry.example/commander@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

describe('Compose topology relay', () => {
  it('uses the active Docker CLI endpoint for parent-only topology reads', async () => {
    const containerId = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    const calls: Array<{ args: readonly string[]; environment: Readonly<Record<string, string>> }> =
      [];
    const inspected = {
      Id: containerId,
      Config: {
        Labels: {
          'com.docker.compose.project': 'commander-prod',
          'com.docker.compose.service': 'api',
        },
        Env: ['DATABASE_URL=postgres://must-not-relay'],
      },
    };
    const authority = createDockerCliTopologyAuthority(
      {
        async run(request) {
          calls.push({ args: request.args, environment: request.environment });
          if (request.args[0] === 'version')
            return { stdout: JSON.stringify({ ApiVersion: '1.44' }) };
          if (request.args.includes('ls')) return { stdout: `${containerId}\n` };
          return { stdout: JSON.stringify([inspected]) };
        },
      },
      { DOCKER_HOST: 'unix:///isolated/docker.sock' },
    );

    assert.deepEqual(await authority.version(), { ApiVersion: '1.44' });
    assert.deepEqual(await authority.listContainers(), [
      { Id: containerId, Labels: inspected.Config.Labels },
    ]);
    assert.deepEqual(await authority.inspectContainer(containerId), inspected);
    assert.ok(
      calls.every((call) => call.environment.DOCKER_HOST === 'unix:///isolated/docker.sock'),
    );
    assert.ok(calls.every((call) => call.args[0] !== '--host'));
  });

  it('relays only the closed API identity DTO to a proof child', async () => {
    const calls: Array<{ program: string; args: readonly string[] }> = [];
    const command: ComposeTopologyRelayCommandPort = {
      async run(request) {
        calls.push({ program: request.program, args: request.args });
        return {
          stdout: JSON.stringify([
            {
              ID: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
              Service: 'api',
              Image: apiImage,
              State: 'running',
              Command: 'node /app/server.js --token=must-not-relay',
              Env: ['DATABASE_URL=postgres://must-not-relay'],
              Mounts: [{ Source: '/host/must-not-relay', Destination: '/run/secrets' }],
              Secrets: [{ SecretName: 'must-not-relay' }],
              Labels: {
                'com.docker.compose.project': 'commander-prod',
                'private.label': 'must-not-relay',
              },
            },
          ]),
        };
      },
    };
    const relay = createComposeTopologyRelay({
      projectName: 'commander-prod',
      composeFiles: ['/repo/docker-compose.prod.yml'],
      command,
    });

    const topology = await relay.read(apiImage);

    assert.deepEqual(topology, {
      schema: 'compose-topology-relay/v1',
      projectName: 'commander-prod',
      api: {
        service: 'api',
        containerId: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        image: apiImage,
      },
    });
    assert.deepEqual(calls, [
      {
        program: 'docker',
        args: [
          'compose',
          '--project-name',
          'commander-prod',
          '-f',
          '/repo/docker-compose.prod.yml',
          'ps',
          '--all',
          '--format',
          'json',
        ],
      },
    ]);
    assert.doesNotMatch(
      JSON.stringify(topology),
      /must-not-relay|DATABASE_URL|Mounts|Secrets|Command|Labels/,
    );
  });

  it('rejects a missing, duplicated, stopped, or image-drifted API identity', async () => {
    const cases = [
      [],
      [
        { ID: '0123456789ab', Service: 'api', Image: apiImage, State: 'running' },
        { ID: 'abcdef012345', Service: 'api', Image: apiImage, State: 'running' },
      ],
      [{ ID: '0123456789ab', Service: 'api', Image: apiImage, State: 'exited' }],
      [
        {
          ID: '0123456789ab',
          Service: 'api',
          Image:
            'registry.example/commander@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          State: 'running',
        },
      ],
    ];

    for (const topology of cases) {
      const relay = createComposeTopologyRelay({
        projectName: 'commander-prod',
        composeFiles: ['/repo/docker-compose.prod.yml'],
        command: {
          async run() {
            return { stdout: JSON.stringify(topology) };
          },
        },
      });
      await assert.rejects(() => relay.read(apiImage), /TENANT_CUTOVER_TOPOLOGY_RELAY_INVALID/);
    }
  });
});
