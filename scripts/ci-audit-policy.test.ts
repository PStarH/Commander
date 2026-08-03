import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { evaluateAuditOutput } from './ci-audit-policy.ts';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function createWebSourceTree(files: Record<string, string> = {}): string {
  const sourceRoot = mkdtempSync(join(tmpdir(), 'commander-ci-audit-policy-'));
  temporaryDirectories.push(sourceRoot);

  for (const [relativePath, source] of Object.entries(files)) {
    const filePath = join(sourceRoot, relativePath);
    mkdirSync(join(filePath, '..'), { recursive: true });
    writeFileSync(filePath, source);
  }

  return sourceRoot;
}

const knownAdvisory = JSON.stringify({
  advisories: {
    known: { github_advisory_id: 'GHSA-qwww-vcr4-c8h2' },
  },
});

describe('CI audit policy', () => {
  it('fails closed when valid audit JSON contains an unrelated advisory mentioning 410', () => {
    const audit = JSON.stringify({
      advisories: {
        known: { github_advisory_id: 'GHSA-qwww-vcr4-c8h2' },
        other: {
          github_advisory_id: 'GHSA-other-high',
          title: 'HTTP 410 appears in advisory text but is not a transport error',
        },
      },
    });

    assert.equal(evaluateAuditOutput(audit, createWebSourceTree()), 'fail');
  });

  it('allows only the recognized pnpm audit endpoint retirement error shape', () => {
    const pnpmEndpointRetirement =
      'ERR_PNPM_AUDIT_BAD_RESPONSE The audit endpoint returned unexpected response: 410';

    assert.equal(
      evaluateAuditOutput(pnpmEndpointRetirement, createWebSourceTree()),
      'transport-unavailable',
    );
  });

  it('fails closed when an unrecognized audit error only mentions status 410', () => {
    assert.equal(
      evaluateAuditOutput(
        'ERR_PNPM_AUDIT_BAD_RESPONSE advisory metadata mentions 410 but endpoint status is unknown',
        createWebSourceTree(),
      ),
      'fail',
    );
  });

  it('fails the exception when nested web source enables React Router RSC', () => {
    const sourceRoot = createWebSourceTree({
      'features/rsc/entry.tsx':
        "import { RSCHydratedRouter } from 'react-router/dom';\nvoid RSCHydratedRouter;\n",
    });

    assert.equal(evaluateAuditOutput(knownAdvisory, sourceRoot), 'fail');
  });

  it('allows the sole known advisory when the full source tree has no RSC wiring', () => {
    const sourceRoot = createWebSourceTree({
      'main.tsx': "import { BrowserRouter } from 'react-router-dom';\nvoid BrowserRouter;\n",
      'features/client.tsx': 'export const Client = () => null;\n',
    });

    assert.equal(evaluateAuditOutput(knownAdvisory, sourceRoot), 'known-rsc-exception');
  });
});
