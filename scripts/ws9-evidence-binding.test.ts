#!/usr/bin/env tsx
/**
 * ws9-evidence-binding.test.ts — LM-16 / audit WS9-02 evidence-binding contract.
 *
 * The WS9 summary must only accept evidence that belongs to *this* execution:
 * a per-run owned output root, a random runId, the candidate git SHA, and
 * recursively hash-verified child artifacts whose paths stay inside the run.
 * Unknown SHA, duplicate case, a different run, an extra unlisted case, a
 * missing/corrupt file, or a path escape must never fill a required slot.
 *
 * Run from the repo root:
 *   node --import tsx --test scripts/ws9-evidence-binding.test.ts
 *
 * This suite exercises the real binding primitives against real temporary run
 * directories. It does NOT prove a live-fire PASS (mocked validation is not
 * live-fire evidence).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EXPECTED_CASES,
  MANIFEST_FILE,
  beginRun,
  describeChildArtifact,
  finalizeRun,
  resolveGitSha,
  verifyRun,
  writeCaseArtifact,
  writeJsonAtomic,
  type EvidenceArtifact,
  type RunManifest,
} from './ws9-livefire';

const HEAD = resolveGitSha();

const sandboxes: string[] = [];

function makeSandbox(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `ws9-binding-${label}-`));
  sandboxes.push(dir);
  return dir;
}

function readManifest(root: string): RunManifest {
  return JSON.parse(readFileSync(join(root, MANIFEST_FILE), 'utf-8')) as RunManifest;
}

/** Canned but structurally real case payloads for every expected case. */
function casePayload(caseId: string): Parameters<typeof writeCaseArtifact>[1] {
  return {
    testCaseId: caseId,
    verdict: 'PASS',
    evidenceLevel: 'live',
    breach: false,
    details: `fixture case ${caseId}`,
    artifacts: [],
  };
}

/** A fully valid, consumable run directory. */
function buildValidRun(label: string, runId?: string): { sandbox: string; root: string } {
  const sandbox = makeSandbox(label);
  const root = join(sandbox, 'run');
  const run = beginRun(root);
  if (runId) {
    const manifest = readManifest(root);
    manifest.runId = runId;
    writeJsonAtomic(join(root, MANIFEST_FILE), manifest);
  }
  for (const caseId of EXPECTED_CASES) {
    writeCaseArtifact(root, casePayload(caseId));
  }
  finalizeRun(root, 'complete');
  return { sandbox, root };
}

/** First rejection string mentioning `needle`, or a thrown assertion error. */
function rejectionFor(root: string, needle: string, expectedGitSha = HEAD): string {
  const result = verifyRun(root, { expectedGitSha });
  assert.equal(result.ok, false, 'verifyRun must fail closed');
  assert.ok(
    result.rejections.some((r) => r.includes(needle)),
    `expected a rejection containing "${needle}", got: ${JSON.stringify(result.rejections)}`,
  );
  return result.rejections.join(' | ');
}

const childScript = `
import { writeFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
// A dynamic specifier cannot appear in a static import; the module path is
// handed to the child through the environment. tsx may expose the module as
// CJS (named exports under .default) or as ESM, so accept both shapes.
const imported = await import(process.env.WS9_BINDING_MODULE);
const m = typeof imported.beginRun === 'function' ? imported : imported.default;
const root = join(process.env.CHILD_OUTPUT_BASE, 'run');
m.beginRun(root);
const blob = join(root, 'child.json');
writeFileSync(blob, '{"nonce":"' + process.env.CHILD_NONCE + '"}');
m.writeCaseArtifact(root, {
  testCaseId: 'DATA-1',
  verdict: 'PASS',
  evidenceLevel: 'live',
  breach: false,
  details: 'concurrent fixture ' + process.env.CHILD_NONCE,
  artifacts: [m.describeChildArtifact(blob, root)],
});
// Give the sibling run time to interleave before sealing this manifest.
const deadline = Date.now() + 700;
while (Date.now() < deadline) {}
m.finalizeRun(root, 'complete');
if (!existsSync(join(root, 'manifest.json'))) process.exit(9);
if (statSync(root).isDirectory() !== true) process.exit(9);
`;

function spawnChild(base: string, nonce: string): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '--eval', childScript],
      {
        cwd: join(__dirname, '..'),
        env: {
          ...process.env,
          CHILD_OUTPUT_BASE: base,
          CHILD_NONCE: nonce,
          WS9_BINDING_MODULE: join(__dirname, 'ws9-livefire.ts'),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', rejectPromise);
    child.on('close', (code) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`child run failed (exit ${code}): ${stderr.slice(0, 800)}`));
    });
  });
}

test.after(() => {
  for (const dir of sandboxes) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

// ─── Positive case ───────────────────────────────────────────────────────

test('all-valid run: every case bound to this run + SHA is accepted', () => {
  const { root } = buildValidRun('valid');
  const result = verifyRun(root, { expectedGitSha: HEAD });

  assert.deepEqual(result.rejections, []);
  assert.equal(result.ok, true);
  assert.equal(result.cases.length, EXPECTED_CASES.length);
  assert.deepEqual(
    result.cases.map((c) => c.testCaseId),
    [...EXPECTED_CASES],
  );
  assert.equal(result.missing.length, 0);

  const first: EvidenceArtifact = result.cases[0]!;
  assert.equal(first.runId, readManifest(root).runId);
  assert.equal(first.gitSha, HEAD);
  assert.equal(first.environment.length > 0, true);
  assert.equal(typeof first.startedAt, 'string');
  assert.equal(typeof first.endedAt, 'string');

  // A different candidate SHA must not consume this run even though it is valid.
  const otherSha = verifyRun(root, { expectedGitSha: '0'.repeat(40) });
  assert.equal(otherSha.ok, false);
  assert.deepEqual(otherSha.cases, []);
  assert.equal(otherSha.missing.length, EXPECTED_CASES.length);
});

test('a run that declares an unknown SHA cannot be consumed', () => {
  const { root } = buildValidRun('unknown-sha');
  const manifest = readManifest(root);
  manifest.gitSha = 'unknown';
  writeJsonAtomic(join(root, MANIFEST_FILE), manifest);
  rejectionFor(root, 'unknown/stale SHA');
});

// ─── Stale binding ───────────────────────────────────────────────────────

test('stale SHA: artifacts from a previous commit are rejected (live PASS cannot fill a slot)', () => {
  const { root } = buildValidRun('stale-sha');
  const target = join(root, 'DATA-1.json');
  const stale = JSON.parse(readFileSync(target, 'utf-8')) as EvidenceArtifact;
  stale.gitSha = 'f0746024c53ea343e3287d21c3ecd395e83467e1';
  stale.verdict = 'PASS';
  stale.evidenceLevel = 'live';
  writeFileSync(target, JSON.stringify(stale, null, 2));

  const detail = rejectionFor(root, 'not the candidate SHA');
  assert.match(detail, /DATA-1/);

  const result = verifyRun(root, { expectedGitSha: HEAD });
  assert.ok(
    !result.cases.some((c) => c.testCaseId === 'DATA-1'),
    'the stale case must not appear in accepted cases',
  );
});

test('stale run: an artifact carrying another runId is rejected', () => {
  const { root } = buildValidRun('stale-run');
  const target = join(root, 'DATA-2.json');
  const stale = JSON.parse(readFileSync(target, 'utf-8')) as EvidenceArtifact;
  stale.runId = 'previous-run-0000';
  writeFileSync(target, JSON.stringify(stale, null, 2));

  rejectionFor(root, 'does not belong to this run');

  // The manifest itself must also be tied to the expected run.
  const otherRun = verifyRun(root, { expectedGitSha: HEAD, expectedRunId: 'not-this-run' });
  assert.equal(otherRun.ok, false);
  assert.ok(otherRun.rejections.some((r) => r.includes('expected not-this-run')));
});

test('nested stale artifact: a tampered grandchild behind a fresh parent fails', () => {
  const sandbox = makeSandbox('nested');
  const root = join(sandbox, 'run');
  const runId = 'ws9-nested-run';
  beginRun(root);
  const manifest = readManifest(root);
  manifest.runId = runId;
  writeJsonAtomic(join(root, MANIFEST_FILE), manifest);

  const childDir = join(root, 'rate-3-run');
  mkdirSync(childDir, { recursive: true });
  const childPath = join(childDir, 'bench-tenant-concurrency.fixture.json');
  writeFileSync(
    childPath,
    JSON.stringify({
      summary: { passed: true, errors: 0 },
      artifacts: [{ path: 'result.json', sha256: 'deadbeef' }],
    }),
  );
  const child = describeChildArtifact(childPath, root);
  assert.equal(child.path, 'rate-3-run/bench-tenant-concurrency.fixture.json');
  assert.equal(child.external, undefined);

  writeCaseArtifact(root, { ...casePayload('RATE-3'), artifacts: [child] });
  finalizeRun(root, 'complete');

  const before = verifyRun(root, { expectedGitSha: HEAD, expectedRunId: runId });
  assert.equal(before.ok, true, JSON.stringify(before.rejections));
  assert.equal(before.cases.length, 1);

  // Rewrite the grandchild's bytes after the manifest bound the hash.
  writeFileSync(childPath, JSON.stringify({ summary: { passed: false, errors: 3 } }));
  const after = verifyRun(root, { expectedGitSha: HEAD, expectedRunId: runId });
  assert.equal(after.ok, false);
  assert.ok(
    after.rejections.some(
      (r) => r.includes('hash mismatch') && r.includes('bench-tenant-concurrency.fixture.json'),
    ),
    JSON.stringify(after.rejections),
  );
  assert.deepEqual(after.cases, []);
});

// ─── Tampering / missing files ───────────────────────────────────────────

test('hash tampering: a child artifact modified after binding is rejected', () => {
  const sandbox = makeSandbox('tamper');
  const root = join(sandbox, 'run');
  const runId = 'ws9-tamper-run';
  beginRun(root);
  const manifest = readManifest(root);
  manifest.runId = runId;
  writeJsonAtomic(join(root, MANIFEST_FILE), manifest);

  const childPath = join(root, 'scan-output.json');
  writeFileSync(childPath, JSON.stringify({ keys: 3 }));
  writeCaseArtifact(root, {
    ...casePayload('AUDIT-1'),
    artifacts: [describeChildArtifact(childPath, root)],
  });
  finalizeRun(root, 'complete');

  writeFileSync(childPath, JSON.stringify({ keys: 4 }));
  const result = verifyRun(root, { expectedGitSha: HEAD, expectedRunId: runId });
  assert.equal(result.ok, false);
  assert.ok(
    result.rejections.some((r) => r.includes('hash mismatch') && r.includes('scan-output.json')),
    JSON.stringify(result.rejections),
  );
  assert.deepEqual(result.cases, []);
});

test('missing file: a deleted child artifact fails the run', () => {
  const sandbox = makeSandbox('missing');
  const root = join(sandbox, 'run');
  const runId = 'ws9-missing-run';
  beginRun(root);
  const manifest = readManifest(root);
  manifest.runId = runId;
  writeJsonAtomic(join(root, MANIFEST_FILE), manifest);

  const childPath = join(root, 'vault-probe.json');
  writeFileSync(childPath, JSON.stringify({ ok: true }));
  writeCaseArtifact(root, {
    ...casePayload('KEY-1'),
    artifacts: [describeChildArtifact(childPath, root)],
  });
  finalizeRun(root, 'complete');

  unlinkSync(childPath);
  const result = verifyRun(root, { expectedGitSha: HEAD, expectedRunId: runId });
  assert.equal(result.ok, false);
  assert.ok(
    result.rejections.some((r) => r.includes('missing') && r.includes('vault-probe.json')),
    JSON.stringify(result.rejections),
  );
});

test('missing evidence: an expected case without an artifact can never fill a slot', () => {
  const { root } = buildValidRun('missing-case');
  unlinkSync(join(root, 'NET-2.json'));
  const manifest = readManifest(root);
  manifest.cases = manifest.cases.filter((c) => c !== 'NET-2');
  writeJsonAtomic(join(root, MANIFEST_FILE), manifest);

  const result = verifyRun(root, { expectedGitSha: HEAD });
  assert.equal(result.ok, false);
  assert.ok(result.missing.includes('NET-2'), JSON.stringify(result.missing));
  assert.equal(result.cases.length, EXPECTED_CASES.length - 1);
});

// ─── Uniqueness / schema ─────────────────────────────────────────────────

test('duplicate case: a second artifact for one case is rejected, not merged', () => {
  const { root } = buildValidRun('duplicate');
  const manifest = readManifest(root);
  // Spoof: the manifest lists the case twice, as a stale/duplicate writer would.
  manifest.cases.splice(1, 0, 'DATA-1');
  writeJsonAtomic(join(root, MANIFEST_FILE), manifest);

  const result = verifyRun(root, { expectedGitSha: HEAD });
  assert.equal(result.ok, false);
  assert.ok(
    result.rejections.some((r) => r.includes('duplicate case')),
    JSON.stringify(result.rejections),
  );

  // A duplicate artifact file that the manifest does not list must not pass either.
  writeFileSync(
    join(root, 'DATA-1.dup.json'),
    JSON.stringify({ ...casePayload('DATA-1'), testCaseId: 'DATA-1.dup' }),
  );
  const extra = verifyRun(root, { expectedGitSha: HEAD });
  assert.equal(extra.ok, false);
  assert.ok(
    extra.rejections.some((r) => r.includes('extra unlisted artifact')),
    JSON.stringify(extra.rejections),
  );
});

test('illegal status/schema: unknown verdict, evidence level, and missing fields fail', () => {
  const { root } = buildValidRun('schema');
  const target = join(root, 'EXEC-1.json');
  const broken = JSON.parse(readFileSync(target, 'utf-8')) as Record<string, unknown>;
  broken.verdict = 'MAYBE';
  delete broken.environment;
  writeFileSync(target, JSON.stringify(broken, null, 2));

  const detail = rejectionFor(root, 'illegal verdict');
  assert.match(detail, /environment fingerprint missing/);

  const level = JSON.parse(readFileSync(join(root, 'EXEC-2.json'), 'utf-8')) as Record<
    string,
    unknown
  >;
  level.evidenceLevel = 'trust-me';
  writeFileSync(join(root, 'EXEC-2.json'), JSON.stringify(level, null, 2));
  rejectionFor(root, 'illegal evidenceLevel');
});

test('case spoofing: an artifact whose testCaseId differs from its file name is rejected', () => {
  const { root } = buildValidRun('spoof');
  const target = join(root, 'AUDIT-3.json');
  const spoofed = JSON.parse(readFileSync(target, 'utf-8')) as EvidenceArtifact;
  spoofed.testCaseId = 'AUDIT-4';
  writeFileSync(target, JSON.stringify(spoofed, null, 2));

  rejectionFor(root, 'testCaseId AUDIT-4');
});

// ─── Path containment ────────────────────────────────────────────────────

test('path escape: absolute, .., and symlink child paths are rejected', () => {
  const sandbox = makeSandbox('escape');
  const root = join(sandbox, 'run');
  const runId = 'ws9-escape-run';
  beginRun(root);
  const manifest = readManifest(root);
  manifest.runId = runId;
  writeJsonAtomic(join(root, MANIFEST_FILE), manifest);

  const outside = join(sandbox, 'outside-secret.json');
  writeFileSync(outside, JSON.stringify({ secret: true }));

  // 1. absolute path
  writeCaseArtifact(root, {
    ...casePayload('DATA-3'),
    artifacts: [{ path: outside, sha256: 'x'.repeat(64) }],
  });
  rejectionFor(root, 'must be an absolute path', HEAD);

  // 2. relative traversal
  writeCaseArtifact(root, {
    ...casePayload('DATA-4'),
    artifacts: [{ path: '../outside-secret.json', sha256: 'x'.repeat(64) }],
  });
  rejectionFor(root, 'path traversal', HEAD);

  // 3. symlink escape: lexically inside the run root, really outside it
  const link = join(root, 'link-out.json');
  try {
    symlinkSync(outside, link);
  } catch (err) {
    assert.fail(`could not create symlink fixture: ${(err as Error).message}`);
  }
  const escape = describeChildArtifact(link, root);
  assert.equal(escape.external, true, 'a symlink escaping the root must be marked external');
  // The recorded path is the resolved real path of the target. `startsWith(tmp)`
  // would be wrong on hosts where the temp directory itself is a symlink
  // (macOS /var → /private/var), so compare against the real path directly.
  assert.equal(escape.path, realpathSync(outside));

  // A hand-written relative child path that resolves through a symlinked
  // directory is the real escape the verifier must catch (the lexical path
  // contains no ".." and looks contained).
  const linkDir = join(root, 'linkdir');
  symlinkSync(sandbox, linkDir, 'dir');
  writeCaseArtifact(root, {
    ...casePayload('DATA-5'),
    artifacts: [{ path: 'linkdir/outside-secret.json', sha256: 'x'.repeat(64) }],
  });
  finalizeRun(root, 'complete');

  const result = verifyRun(root, { expectedGitSha: HEAD, expectedRunId: runId });
  assert.equal(result.ok, false);
  assert.ok(
    result.rejections.some((r) => r.includes('linkdir') && r.includes('outside the run root')),
    JSON.stringify(result.rejections),
  );
  assert.ok(result.rejections.some((r) => r.includes('DATA-3')));
  assert.ok(result.rejections.some((r) => r.includes('DATA-4')));
});

// ─── Interrupted runs ────────────────────────────────────────────────────

test('interrupted run: an incomplete manifest can never be consumed as a previous summary', () => {
  const sandbox = makeSandbox('interrupted');
  const root = join(sandbox, 'run');
  beginRun(root);
  writeCaseArtifact(root, casePayload('DATA-6'));
  // Simulates a killed orchestrator: no finalizeRun(), marker still present.

  const result = verifyRun(root, { expectedGitSha: HEAD });
  assert.equal(result.ok, false);
  assert.deepEqual(result.cases, []);
  assert.ok(
    result.rejections.some((r) => r.includes('incomplete')),
    JSON.stringify(result.rejections),
  );

  // finalizeRun(..., 'failed') seals it as failed rather than consumable.
  finalizeRun(root, 'failed', 'killed mid-run');
  const failed = verifyRun(root, { expectedGitSha: HEAD });
  assert.equal(failed.ok, false);
  assert.deepEqual(failed.cases, []);
  assert.ok(failed.rejections.some((r) => r.includes('"failed"')));
});

test('extra unlisted case: an artifact the manifest does not list fails the run', () => {
  const { root } = buildValidRun('extra-case');
  const manifest = readManifest(root);
  manifest.cases = manifest.cases.filter((c) => c !== 'TAMPER-5');
  writeJsonAtomic(join(root, MANIFEST_FILE), manifest);

  const result = verifyRun(root, { expectedGitSha: HEAD });
  assert.equal(result.ok, false);
  assert.ok(
    result.rejections.some((r) => r.includes('not listed in manifest')),
    JSON.stringify(result.rejections),
  );
  assert.ok(!result.cases.some((c) => c.testCaseId === 'TAMPER-5'));
});

test('a non-empty run root is refused (no cross-run overwrite)', () => {
  const sandbox = makeSandbox('reuse');
  const root = join(sandbox, 'run');
  beginRun(root);
  assert.throws(() => beginRun(root), /not empty/);
});

// ─── Two concurrent runs ─────────────────────────────────────────────────

test('two concurrent runs: evidence stays bound to its own run root', async () => {
  const baseA = makeSandbox('concurrent-a');
  const baseB = makeSandbox('concurrent-b');
  await Promise.all([spawnChild(baseA, 'nonce-A'), spawnChild(baseB, 'nonce-B')]);

  const rootA = join(baseA, 'run');
  const rootB = join(baseB, 'run');
  const manifestA = readManifest(rootA);
  const manifestB = readManifest(rootB);
  assert.notEqual(manifestA.runId, manifestB.runId);

  const resultA = verifyRun(rootA, { expectedGitSha: HEAD, expectedRunId: manifestA.runId });
  const resultB = verifyRun(rootB, { expectedGitSha: HEAD, expectedRunId: manifestB.runId });
  assert.equal(resultA.ok, true, JSON.stringify(resultA.rejections));
  assert.equal(resultB.ok, true, JSON.stringify(resultB.rejections));
  assert.deepEqual(
    resultA.cases.map((c) => c.testCaseId),
    ['DATA-1'],
  );

  // Each run's own nonce child is hash-bound in its own root.
  const childA = JSON.parse(readFileSync(join(rootA, 'child.json'), 'utf-8')) as { nonce: string };
  assert.equal(childA.nonce, 'nonce-A');
  assert.equal(resultA.cases[0]!.artifacts[0]!.path, 'child.json');

  // Cross-run consumption is impossible in both directions.
  const crossedA = verifyRun(rootA, { expectedGitSha: HEAD, expectedRunId: manifestB.runId });
  assert.equal(crossedA.ok, false);
  assert.deepEqual(crossedA.cases, []);
  assert.ok(crossedA.rejections.some((r) => r.includes('expected')));

  const crossedB = verifyRun(rootB, { expectedGitSha: HEAD, expectedRunId: manifestA.runId });
  assert.equal(crossedB.ok, false);
  assert.deepEqual(crossedB.cases, []);

  // The incomplete markers are gone only for the runs that sealed successfully.
  assert.equal(existsSync(join(rootA, 'manifest.incomplete.json')), false);
  assert.equal(existsSync(join(rootB, 'manifest.incomplete.json')), false);
  assert.equal(existsSync(join(rootA, 'manifest.json')), true);
  assert.equal(existsSync(join(rootB, 'manifest.json')), true);
});
