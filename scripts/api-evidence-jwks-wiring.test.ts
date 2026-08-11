import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const root = process.cwd();
const read = (file: string) => readFileSync(`${root}/${file}`, 'utf8');

test('API receives only the public evidence JWKS and Compose fails closed when it is absent', () => {
  const helm = read('deploy/helm/commander/templates/deployment.yaml');
  const values = read('deploy/helm/commander/values.yaml');
  assert.match(values, /evidenceVerification:/);
  assert.match(helm, /name: COMMANDER_EVIDENCE_JWKS_JSON[\s\S]*name: \{\{ \.Values\.evidenceVerification\.existingSecret/);
  assert.doesNotMatch(helm, /COMMANDER_EVIDENCE_SIGNING_PRIVATE_KEY_PEM/);
  for (const file of ['docker-compose.yml', 'deploy/docker/v2-compose.yml']) {
    const compose = read(file);
    assert.match(compose, /COMMANDER_EVIDENCE_JWKS_JSON.*:\?/);
  }
});

test('enterprise Helm fails without public JWKS Secret and demo remains renderable', () => {
  assert.throws(() => execFileSync('helm', ['template', 'x', 'deploy/helm/commander', '-f', 'deploy/helm/commander/values-enterprise.yaml', '--set', 'image.tag=test', '--set', 'evidenceVerification.existingSecret='], { cwd: root, encoding: 'utf8' }), /evidenceVerification\.existingSecret/);
  assert.doesNotThrow(() => execFileSync('helm', ['template', 'x', 'deploy/helm/commander', '-f', 'deploy/helm/commander/values-demo.yaml', '--set', 'image.tag=test'], { cwd: root }));
});
