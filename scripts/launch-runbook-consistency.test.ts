import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const projectRoot = resolve(import.meta.dirname, '..');

test('launch verification wording matches command availability', () => {
  const packageJson = JSON.parse(
    readFileSync(resolve(projectRoot, 'package.json'), 'utf8'),
  ) as { scripts?: Record<string, unknown> };
  const runbook = readFileSync(
    resolve(projectRoot, 'docs/runbooks/design-partner-launch-readiness.md'),
    'utf8',
  );

  const command = String.fromCharCode(96) + 'launch:verify' + String.fromCharCode(96);
  assert.equal(typeof packageJson.scripts?.['launch:verify'], 'string');
  assert.doesNotMatch(runbook, new RegExp(command + ' does not exist yet\\.'));
});
