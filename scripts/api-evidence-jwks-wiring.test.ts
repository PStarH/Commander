import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const root = process.cwd();
const read = (file: string) => readFileSync(`${root}/${file}`, 'utf8');

test('API receives only the public evidence JWKS and Compose fails closed when it is absent', () => {
  const helm = read('deploy/helm/commander/templates/deployment.yaml');
  const values = read('deploy/helm/commander/values.yaml');
  assert.match(values, /evidenceVerification:/);
  assert.match(helm, /name: COMMANDER_EVIDENCE_JWKS_JSON/);
  assert.match(helm, /secretKeyRef:/);
  assert.doesNotMatch(helm, /COMMANDER_EVIDENCE_SIGNING_PRIVATE_KEY_PEM/);
  for (const file of ['docker-compose.yml', 'deploy/docker/v2-compose.yml']) {
    const compose = read(file);
    assert.match(compose, /COMMANDER_EVIDENCE_JWKS_JSON.*:\?/);
  }
});
