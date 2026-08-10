import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

export interface ExternalAcceptanceBuildFile {
  source: string;
  dist: string;
  sourceSha256: string;
  distSha256: string;
  sourceMtimeMs: number;
  distMtimeMs: number;
}

export interface ExternalAcceptanceBuildMetadata {
  sourceCommit: string;
  files: ExternalAcceptanceBuildFile[];
}

const BUILD_PAIRS = [
  ['packages/adapter-ops/src/run.ts', 'packages/adapter-ops/dist/run.js'],
  ['packages/adapter-ops/src/wiring.ts', 'packages/adapter-ops/dist/wiring.js'],
  [
    'packages/adapter-ops/src/reconciliationDaemon.ts',
    'packages/adapter-ops/dist/reconciliationDaemon.js',
  ],
  [
    'packages/adapter-ops/src/compensationDaemon.ts',
    'packages/adapter-ops/dist/compensationDaemon.js',
  ],
  ['packages/kernel/src/postgres.ts', 'packages/kernel/dist/postgres.js'],
  ['packages/kernel/src/migrations.ts', 'packages/kernel/dist/migrations.js'],
  ['packages/kernel/src/compensationSchema.ts', 'packages/kernel/dist/compensationSchema.js'],
  ['apps/api/src/actionGatewayEndpoints.ts', 'apps/api/dist/actionGatewayEndpoints.js'],
  ['packages/mcp-server/src/cli.ts', 'packages/mcp-server/dist/cli.js'],
] as const;

async function fileSha256(path: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}

export async function collectExternalAcceptanceBuildMetadata(
  root: string,
): Promise<ExternalAcceptanceBuildMetadata> {
  const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
  }).trim();
  if (!/^[0-9a-f]{40}$/.test(sourceCommit)) {
    throw new Error('ACCEPTANCE_SOURCE_COMMIT_INVALID');
  }

  const files: ExternalAcceptanceBuildFile[] = [];
  for (const [source, dist] of BUILD_PAIRS) {
    const sourcePath = resolve(root, source);
    const distPath = resolve(root, dist);
    const [sourceStats, distStats] = await Promise.all([stat(sourcePath), stat(distPath)]);
    if (!sourceStats.isFile() || !distStats.isFile()) {
      throw new Error(`ACCEPTANCE_BUILD_FILE_INVALID:${source}:${dist}`);
    }
    if (distStats.mtimeMs < sourceStats.mtimeMs) {
      throw new Error(`ACCEPTANCE_DIST_STALE:${dist}`);
    }
    const [sourceSha256, distSha256] = await Promise.all([
      fileSha256(sourcePath),
      fileSha256(distPath),
    ]);
    files.push({
      source,
      dist,
      sourceSha256,
      distSha256,
      sourceMtimeMs: sourceStats.mtimeMs,
      distMtimeMs: distStats.mtimeMs,
    });
  }
  return { sourceCommit, files };
}
