import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { load } from 'js-yaml';

const root = process.cwd();
const read = (file: string) => readFileSync(`${root}/${file}`, 'utf8');

test('API receives only the public evidence JWKS and Compose fails closed when it is absent', () => {
  const helm = read('deploy/helm/commander/templates/deployment.yaml');
  const values = read('deploy/helm/commander/values.yaml');
  assert.match(values, /evidenceVerification:/);
  assert.match(
    helm,
    /name: COMMANDER_EVIDENCE_JWKS_JSON[\s\S]*name: \{\{ \.Values\.evidenceVerification\.existingSecret/,
  );
  assert.doesNotMatch(helm, /COMMANDER_EVIDENCE_SIGNING_PRIVATE_KEY_PEM/);
  for (const file of ['docker-compose.yml', 'deploy/docker/v2-compose.yml']) {
    const compose = read(file);
    assert.match(compose, /COMMANDER_EVIDENCE_JWKS_JSON.*:\?/);
  }
});

test('enterprise Helm fails without public JWKS Secret and demo remains renderable', () => {
  assert.throws(
    () =>
      execFileSync(
        'helm',
        [
          'template',
          'x',
          'deploy/helm/commander',
          '-f',
          'deploy/helm/commander/values-enterprise.yaml',
          '--set',
          'image.tag=test',
          '--set',
          'evidenceVerification.existingSecret=',
        ],
        { cwd: root, encoding: 'utf8' },
      ),
    /evidenceVerification\.existingSecret/,
  );
  assert.doesNotThrow(() =>
    execFileSync(
      'helm',
      [
        'template',
        'x',
        'deploy/helm/commander',
        '-f',
        'deploy/helm/commander/values-demo.yaml',
        '--set',
        'image.tag=test',
      ],
      { cwd: root },
    ),
  );
});

test('Compose rejects a missing public JWKS and injects it only into API services', () => {
  const env = {
    ...process.env,
    COMMANDER_API_KEY: 'x',
    POSTGRES_PASSWORD: 'x',
    COMMANDER_MASTER_KEY: 'x',
    JWT_SECRET: 'x',
    COMMANDER_CAPABILITY_PRIVATE_KEY_PEM: 'x',
    COMMANDER_CAPABILITY_KEY_ID: 'x',
    COMMANDER_CAPABILITY_JWKS_JSON: '{"keys":[]}',
    COMMANDER_EVIDENCE_SIGNING_PRIVATE_KEY_PEM: 'x',
    COMMANDER_EVIDENCE_SIGNING_KEY_ID: 'x',
  };
  for (const [file, names] of [
    ['docker-compose.yml', ['api']],
    ['deploy/docker/v2-compose.yml', ['api-1', 'api-2']],
  ] as const) {
    const missing = spawnSync('docker', ['compose', '-f', file, 'config'], {
      cwd: root,
      env,
      encoding: 'utf8',
    });
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /COMMANDER_EVIDENCE_JWKS_JSON/);
    const value = '{"keys":[]}';
    const present = spawnSync('docker', ['compose', '-f', file, 'config'], {
      cwd: root,
      env: { ...env, COMMANDER_EVIDENCE_JWKS_JSON: value },
      encoding: 'utf8',
    });
    assert.equal(present.status, 0, present.stderr);
    const services = (
      load(present.stdout) as { services: Record<string, { environment?: Record<string, string> }> }
    ).services;
    for (const name of names) {
      const service = services[name];
      assert.equal(service.environment?.COMMANDER_EVIDENCE_JWKS_JSON, value);
      assert.equal(service.environment?.COMMANDER_EVIDENCE_SIGNING_PRIVATE_KEY_PEM, undefined);
      assert.equal(service.environment?.COMMANDER_CAPABILITY_PRIVATE_KEY_PEM, undefined);
    }
  }
});
