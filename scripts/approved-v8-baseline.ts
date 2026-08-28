#!/usr/bin/env tsx
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const FORMAT = 'commander.approved-v8-baseline/v1';
const OBJECT_ID = /^[a-f0-9]{40}$/;

export interface ApprovedV8Baseline {
  format: typeof FORMAT;
  commitSha: string;
  treeSha: string;
}

export interface ApprovedV8BaselineEvidence extends ApprovedV8Baseline {
  detached: true;
  clean: true;
  sourceArchiveSha256: string;
  chartArchiveSha256: string;
  lfsPlaceholders: readonly string[];
  submodules: readonly string[];
}

function fail(code: string): never {
  throw new Error(code);
}

export function parseApprovedV8Baseline(text: string): ApprovedV8Baseline {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    fail('APPROVED_V8_BASELINE_INVALID');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('APPROVED_V8_BASELINE_INVALID');
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    keys.join(',') !== 'commitSha,format,treeSha' ||
    record.format !== FORMAT ||
    typeof record.commitSha !== 'string' ||
    !OBJECT_ID.test(record.commitSha) ||
    typeof record.treeSha !== 'string' ||
    !OBJECT_ID.test(record.treeSha)
  ) {
    fail('APPROVED_V8_BASELINE_INVALID');
  }
  return {
    format: FORMAT,
    commitSha: record.commitSha,
    treeSha: record.treeSha,
  };
}

function git(root: string, args: readonly string[], encoding: BufferEncoding = 'utf8'): string {
  return execFileSync('git', ['-C', root, ...args], {
    encoding,
    maxBuffer: 512 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  }) as string;
}

function archiveSha256(root: string, commitSha: string, path?: string): string {
  const args = ['-C', root, 'archive', '--format=tar', commitSha];
  if (path) args.push('--', path);
  const archive = execFileSync('git', args, {
    encoding: 'buffer',
    maxBuffer: 512 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return createHash('sha256').update(archive).digest('hex');
}

function matchingFiles(root: string, commitSha: string, pattern: string): string[] {
  const result = spawnSync('git', ['-C', root, 'grep', '-Il', '-e', pattern, commitSha, '--'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status === 1) return [];
  if (result.status !== 0) fail('APPROVED_V8_BASELINE_SOURCE_SCAN_FAILED');
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

export function verifyApprovedV8Baseline(
  repositoryRoot: string,
  manifest: ApprovedV8Baseline,
): ApprovedV8BaselineEvidence {
  const root = resolve(repositoryRoot);
  if (!isAbsolute(root)) fail('APPROVED_V8_BASELINE_REPOSITORY_INVALID');
  try {
    git(root, ['cat-file', '-e', `${manifest.commitSha}^{commit}`]);
  } catch {
    fail('APPROVED_V8_BASELINE_OBJECT_MISSING');
  }
  const observedTree = git(root, ['show', '-s', '--format=%T', manifest.commitSha]).trim();
  if (observedTree !== manifest.treeSha) fail('APPROVED_V8_BASELINE_TREE_MISMATCH');

  const treeRows = git(root, ['ls-tree', '-r', manifest.commitSha]).split('\n').filter(Boolean);
  const submodules = treeRows
    .filter((row) => row.startsWith('160000 '))
    .map((row) => row.slice(row.indexOf('\t') + 1));
  if (submodules.length > 0) fail('APPROVED_V8_BASELINE_SUBMODULE_DRIFT');
  const lfsPlaceholders = matchingFiles(
    root,
    manifest.commitSha,
    '^version https://git-lfs.github.com/spec/v1$',
  );
  if (lfsPlaceholders.length > 0) fail('APPROVED_V8_BASELINE_LFS_PLACEHOLDER');

  const temporaryRoot = mkdtempSync(join(tmpdir(), 'commander-approved-v8-'));
  const worktree = join(temporaryRoot, 'worktree');
  let added = false;
  try {
    execFileSync('git', ['-C', root, 'worktree', 'add', '--detach', worktree, manifest.commitSha], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    added = true;
    const symbolic = spawnSync('git', ['-C', worktree, 'symbolic-ref', '-q', 'HEAD']);
    if (symbolic.status === 0) fail('APPROVED_V8_BASELINE_NOT_DETACHED');
    if (git(worktree, ['status', '--porcelain', '--untracked-files=all']).trim() !== '') {
      fail('APPROVED_V8_BASELINE_DIRTY');
    }
    if (git(worktree, ['rev-parse', 'HEAD']).trim() !== manifest.commitSha) {
      fail('APPROVED_V8_BASELINE_COMMIT_MISMATCH');
    }
    if (git(worktree, ['rev-parse', 'HEAD^{tree}']).trim() !== manifest.treeSha) {
      fail('APPROVED_V8_BASELINE_TREE_MISMATCH');
    }

    return {
      ...manifest,
      detached: true,
      clean: true,
      sourceArchiveSha256: archiveSha256(root, manifest.commitSha),
      chartArchiveSha256: archiveSha256(root, manifest.commitSha, 'deploy/helm/commander'),
      lfsPlaceholders,
      submodules,
    };
  } finally {
    if (added) {
      spawnSync('git', ['-C', root, 'worktree', 'remove', '--force', worktree]);
    }
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function main(): void {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const root = resolve(scriptDir, '..');
  const fixture = process.argv[2]
    ? resolve(process.argv[2])
    : resolve(root, 'scripts/fixtures/helm-lifecycle/approved-v8-baseline.json');
  const evidence = verifyApprovedV8Baseline(
    root,
    parseApprovedV8Baseline(readFileSync(fixture, 'utf8')),
  );
  process.stdout.write(`${JSON.stringify(evidence)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'APPROVED_V8_BASELINE_FAILED'}\n`,
    );
    process.exitCode = 1;
  }
}
