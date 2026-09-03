import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('proof Job metadata does not repeat the standard labels', () => {
  const template = readFileSync(
    resolve(root, 'deploy/helm/commander/templates/tenant-cutover-prove-job.yaml'),
    'utf8',
  );
  const labels = template.match(/metadata:\n[\s\S]*?  labels:\n([\s\S]*?)  annotations:/)?.[1];

  assert.ok(labels);
  assert.match(labels, /include "commander\.labels"/);
  assert.doesNotMatch(labels, /include "commander\.proofReaderLabels"/);
  assert.match(labels, /commander\.io\/tenant-authority-proof-reader: "true"/);
  assert.match(labels, /commander\.io\/tenant-authority-proof-release:/);
});
