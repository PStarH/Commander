/**
 * Regression: read failures must be *diagnosable*, and must not silently pass.
 *
 * `readSource` originally collapsed every failure to `undefined`, so an
 * unreadable file was indistinguishable from a missing one. Two consequences
 * were observed in this repository (2026-09-16):
 *
 * 1. `test-inventory.mjs` reported `could not read <file>` with no reason, so an
 *    environment/ACL block (`CODEBUDDY_BROKER_DENY` from the local sandbox) was
 *    indistinguishable from a genuinely missing file.
 * 2. `run-node-tests.mjs` *filtered* unreadable candidates out of a directory
 *    selection, so a blocked file silently skipped the run while the suite still
 *    reported success — a fail-open in a test gate.
 *
 * These tests pin the distinction and the back-compat wrapper.
 */
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  isEnvironmentReadFailure,
  readSource,
  readSourceDetailed,
} from '../../scripts/test-manifest.mjs';

test('readSourceDetailed reports ENOENT for a missing file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'readsrc-missing-'));
  try {
    const result = readSourceDetailed('does-not-exist.ts', dir);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'ENOENT');
    assert.ok(result.message.includes('ENOENT'), `message should name the code: ${result.message}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readSourceDetailed reports a non-ENOENT code for an unreadable file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'readsrc-perm-'));
  const file = join(dir, 'blocked.ts');
  try {
    writeFileSync(file, 'export const x = 1;\n', 'utf8');
    chmodSync(file, 0o000);

    const result = readSourceDetailed('blocked.ts', dir);
    assert.equal(result.ok, false, 'a mode-000 file must not be readable');
    // The exact code differs by platform (EACCES on POSIX, EPERM on some
    // sandboxes); what matters is that it is NOT reported as a missing file.
    assert.notEqual(result.code, 'ENOENT');
    assert.equal(
      isEnvironmentReadFailure(result.code),
      true,
      `expected ${result.code} to classify as an environment block`,
    );
  } finally {
    try {
      chmodSync(file, 0o600);
    } catch {
      /* best effort — the dir is removed next */
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readSourceDetailed returns the source when the file is readable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'readsrc-ok-'));
  try {
    writeFileSync(join(dir, 'ok.ts'), 'export const marker = 42;\n', 'utf8');
    const result = readSourceDetailed('ok.ts', dir);
    assert.equal(result.ok, true);
    assert.ok(result.source.includes('marker = 42'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readSource still collapses every failure to undefined (back-compat)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'readsrc-compat-'));
  const file = join(dir, 'blocked.ts');
  try {
    assert.equal(readSource('missing.ts', dir), undefined);

    writeFileSync(file, 'x\n', 'utf8');
    chmodSync(file, 0o000);
    assert.equal(readSource('blocked.ts', dir), undefined);
  } finally {
    try {
      chmodSync(file, 0o600);
    } catch {
      /* best effort */
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test('isEnvironmentReadFailure separates missing paths from blocked reads', () => {
  // Missing path → a repository defect, not an environment problem.
  assert.equal(isEnvironmentReadFailure('ENOENT'), false);
  assert.equal(isEnvironmentReadFailure('ENOTDIR'), false);

  // Everything else → something outside the repo is blocking the read.
  for (const code of ['EACCES', 'EPERM', 'EBUSY', 'EMFILE', 'CODEBUDDY_BROKER_DENY', 'UNKNOWN']) {
    assert.equal(isEnvironmentReadFailure(code), true, `${code} should be an environment failure`);
  }
});
