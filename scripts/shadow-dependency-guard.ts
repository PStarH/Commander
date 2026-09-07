import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

export interface ShadowPackageManifest {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
}

const SHADOW_PRODUCTION_ALLOWLIST = new Set([
  '@commander/contracts',
  '@commander/postgres-runtime',
  'json-canonicalize',
  'pg',
]);

const POSTGRES_PRODUCTION_ALLOWLIST = new Set([
  'pg-cloudflare',
  'pg-connection-string',
  'pg-pool',
  'pg-protocol',
  'pg-types',
  'pg-int8',
  'pgpass',
  'postgres-array',
  'postgres-bytea',
  'postgres-date',
  'postgres-interval',
  'xtend',
  'split2',
]);

function dependencies(manifest: ShadowPackageManifest): string[] {
  return [
    ...new Set([
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.optionalDependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}).filter(
        (name) => manifest.peerDependenciesMeta?.[name]?.optional !== true,
      ),
    ]),
  ].sort();
}

export function readShadowDependencyClosure(
  rootManifestPath: string,
): Record<string, ShadowPackageManifest> {
  const manifests: Record<string, ShadowPackageManifest> = {};
  const pending = [{ name: '@commander/shadow-plane', path: rootManifestPath }];
  while (pending.length > 0) {
    const current = pending.shift()!;
    if (manifests[current.name]) continue;
    const manifest = JSON.parse(readFileSync(current.path, 'utf8')) as ShadowPackageManifest;
    manifests[current.name] = manifest;
    const require = createRequire(current.path);
    for (const name of dependencies(manifest)) {
      // Resolve from the declaring package so pnpm's actual production graph is checked.
      const path = require.resolve
        .paths(name)
        ?.map((directory) => join(directory, name, 'package.json'))
        .find(existsSync);
      if (!path) throw new Error(`package manifest not found: ${name}`);
      pending.push({ name, path: realpathSync(path) });
    }
  }
  return manifests;
}

export function validateShadowDependencyClosure(
  manifests: Record<string, ShadowPackageManifest>,
): string[] {
  const root = '@commander/shadow-plane';
  const issues: string[] = [];
  const visited = new Set<string>();
  const pending: Array<{ name: string; path: string[] }> = [{ name: root, path: [root] }];

  while (pending.length > 0) {
    const current = pending.shift()!;
    if (visited.has(current.name)) continue;
    visited.add(current.name);
    const manifest = manifests[current.name];
    if (!manifest) {
      issues.push(`missing package manifest: ${current.path.join(' -> ')}`);
      continue;
    }
    for (const dependency of dependencies(manifest)) {
      const path = [...current.path, dependency];
      const postgresDependency =
        current.path.includes('pg') && POSTGRES_PRODUCTION_ALLOWLIST.has(dependency);
      if (!SHADOW_PRODUCTION_ALLOWLIST.has(dependency) && !postgresDependency) {
        issues.push(`forbidden production dependency: ${path.join(' -> ')}`);
      }
      pending.push({ name: dependency, path });
    }
  }
  return issues;
}
