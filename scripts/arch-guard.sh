#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="${COMMANDER_ARCH_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)}"
export ROOT_DIR

node <<'NODE'
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(process.env.ROOT_DIR);
const failures = [];
const skipDirectories = new Set(['node_modules', 'dist', '.git', '.turbo', 'coverage']);
const forbiddenPackagePattern = /(^|[-_.])(control-plane|orchestration|orchestrator|security)(?=$|[-_.])/i;
const deletedPackageImportPattern = /^@commander\/(control-plane|orchestration)(?:\/|$)/;

const allowedDependencies = {
  '@commander/contracts': [],
  '@commander/kernel': ['@commander/contracts'],
  '@commander/effect-broker': ['@commander/contracts'],
  '@commander/action-adapters': ['@commander/contracts', '@commander/effect-broker'],
  '@commander/operations': ['@commander/kernel', '@commander/contracts'],
  '@commander/worker-plane': [
    '@commander/contracts',
    '@commander/kernel',
    '@commander/effect-broker',
    '@commander/action-adapters',
    '@commander/core',
  ],
  '@commander/api': [
    '@commander/contracts',
    '@commander/kernel',
    '@commander/worker-plane',
    '@commander/effect-broker',
    '@commander/core',
  ],
  '@commander/core': ['@commander/plugin-sdk', '@commander/contracts'],
  '@commander/plugin-sdk': [],
  '@commander/sdk': ['@commander/contracts', '@commander/core'],
  '@commander/mcp-server': ['@commander/core'],
  '@commander/web': [],
};

function exists(file) {
  return fs.existsSync(path.join(root, file));
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    failures.push(`Unable to parse ${path.relative(root, file)}: ${error.message}`);
    return null;
  }
}

function walk(directory, predicate, output = []) {
  if (!fs.existsSync(directory)) return output;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (skipDirectories.has(entry.name) || entry.name.startsWith('.')) continue;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(file, predicate, output);
    else if (predicate(file)) output.push(file);
  }
  return output;
}

function packageDirectories() {
  const directories = [];
  for (const group of ['packages', 'apps']) {
    const directory = path.join(root, group);
    if (!fs.existsSync(directory)) continue;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      if (!entry.isDirectory()) continue;
      directories.push(path.join(directory, entry.name));
    }
  }
  return directories;
}

const packageInfo = new Map();
for (const directory of packageDirectories()) {
  const base = path.basename(directory);
  if (forbiddenPackagePattern.test(base)) {
    failures.push(`Forbidden package directory: ${path.relative(root, directory)}`);
  }

  const manifestPath = path.join(directory, 'package.json');
  if (!fs.existsSync(manifestPath)) continue;
  const manifest = readJson(manifestPath);
  if (!manifest?.name) {
    failures.push(`Package manifest has no name: ${path.relative(root, manifestPath)}`);
    continue;
  }
  if (forbiddenPackagePattern.test(manifest.name.replace(/^@commander\//, ''))) {
    failures.push(`Forbidden package name: ${manifest.name}`);
  }
  packageInfo.set(manifest.name, {
    directory,
    manifestPath,
    manifest,
  });
}

const internalNames = new Set(packageInfo.keys());
const graph = new Map([...internalNames].map((name) => [name, new Set()]));

function internalPackageName(specifier) {
  for (const name of internalNames) {
    if (specifier === name || specifier.startsWith(`${name}/`)) return name;
  }
  return null;
}

function dependencyNames(manifest) {
  return Object.keys({
    ...(manifest.dependencies ?? {}),
    ...(manifest.devDependencies ?? {}),
    ...(manifest.peerDependencies ?? {}),
    ...(manifest.optionalDependencies ?? {}),
  }).filter((name) => name.startsWith('@commander/'));
}

function allowed(owner, dependency) {
  if (owner === dependency) return true;
  return (allowedDependencies[owner] ?? []).includes(dependency);
}

for (const [owner, info] of packageInfo) {
  const dependencies = dependencyNames(info.manifest);
  if (!allowedDependencies[owner]) {
    failures.push(`No dependency policy exists for workspace package ${owner}`);
  }
  if (owner === '@commander/contracts' && dependencies.length > 0) {
    failures.push(`Contracts must be a leaf; found internal dependency ${dependencies.join(', ')}`);
  }
  for (const dependency of dependencies) {
    const resolved = internalPackageName(dependency);
    if (!resolved) {
      failures.push(`${owner} references unknown internal package ${dependency}`);
      continue;
    }
    graph.get(owner)?.add(resolved);
    if (!allowed(owner, resolved)) {
      failures.push(`Illegal dependency: ${owner} -> ${resolved}`);
    }
  }
}

function packageForFile(file) {
  for (const [name, info] of [...packageInfo].sort((a, b) => b[1].directory.length - a[1].directory.length)) {
    const relativeFile = path.relative(info.directory, file);
    if (relativeFile && !relativeFile.startsWith('..') && !path.isAbsolute(relativeFile)) {
      return { name, info };
    }
  }
  return null;
}

function relativeFile(file) {
  return path.relative(root, file).split(path.sep).join('/');
}

const importPattern = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)['"]([^'"]+)['"]/g;
const apiConfigPath = path.join(root, 'scripts', 'architecture-gate.config.json');
const gateConfig = fs.existsSync(apiConfigPath) ? readJson(apiConfigPath) : null;
const apiLegacyCoreFiles = new Set(gateConfig?.api?.legacyImportExceptions ?? []);
const workerCoreBridgeFiles = new Set(
  (gateConfig?.v2ImportExceptions ?? []).map((entry) => String(entry).split(path.sep).join('/')),
);
const sourceFiles = [];
for (const info of packageInfo.values()) {
  const sourceDirectory = path.join(info.directory, 'src');
  sourceFiles.push(...walk(sourceDirectory, (candidate) => /\.tsx?$/.test(candidate)));
}
for (const file of sourceFiles) {
  const packageOwner = packageForFile(file);
  if (!packageOwner) continue;
  const owner = packageOwner.name;
  const source = fs.readFileSync(file, 'utf8');
  for (const match of source.matchAll(importPattern)) {
    const specifier = match[1];
    if (specifier.startsWith('.')) {
      const resolved = path.resolve(path.dirname(file), specifier);
      const relativeToPackage = path.relative(packageOwner.info.directory, resolved);
      if (relativeToPackage.startsWith('..') || path.isAbsolute(relativeToPackage)) {
        failures.push(`Relative import escapes package boundary: ${relativeFile(file)} -> ${specifier}`);
      }
      continue;
    }
    const dependency = internalPackageName(specifier);
    if (deletedPackageImportPattern.test(specifier)) {
      failures.push(`${relativeFile(file)} imports deleted package ${specifier}`);
      continue;
    }
    if (!dependency || dependency === owner) continue;
    graph.get(owner)?.add(dependency);
    const isWorkerCoreBridge =
      owner === '@commander/worker-plane' &&
      dependency === '@commander/core' &&
      workerCoreBridgeFiles.has(relativeFile(file));
    const apiSourceFile =
      owner === '@commander/api' && relativeFile(file).startsWith('apps/api/src/')
        ? relativeFile(file).slice('apps/api/src/'.length)
        : null;
    const isApiLegacyCoreImport =
      owner === '@commander/api' &&
      dependency === '@commander/core' &&
      apiSourceFile !== null &&
      apiLegacyCoreFiles.has(apiSourceFile);
    if (
      !allowed(owner, dependency) ||
      (dependency === '@commander/core' && owner === '@commander/worker-plane' && !isWorkerCoreBridge) ||
      (dependency === '@commander/core' && owner === '@commander/api' && !isApiLegacyCoreImport)
    ) {
      failures.push(`Illegal source dependency: ${relativeFile(file)} (${owner} -> ${dependency})`);
    }
    if (['@commander/kernel', '@commander/effect-broker', '@commander/operations'].includes(owner) && dependency === '@commander/core') {
      failures.push(`V2 implementation package ${owner} imports forbidden @commander/core in ${relativeFile(file)}`);
    }
  }
}

for (const file of ['package.json', 'pnpm-lock.yaml']) {
  const absolute = path.join(root, file);
  if (!fs.existsSync(absolute)) continue;
  const source = fs.readFileSync(absolute, 'utf8');
  if (/@commander\/(control-plane|orchestration)\b/.test(source)) {
    failures.push(`${file} references a deleted package`);
  }
}

for (const info of packageInfo.values()) {
  const source = fs.readFileSync(info.manifestPath, 'utf8');
  if (/@commander\/(control-plane|orchestration)\b/.test(source)) {
    failures.push(`${relativeFile(info.manifestPath)} references a deleted package`);
  }
}

const visiting = new Set();
const visited = new Set();
function visit(name, chain = []) {
  if (visiting.has(name)) {
    const start = chain.indexOf(name);
    failures.push(`Dependency cycle: ${[...chain.slice(start), name].join(' -> ')}`);
    return;
  }
  if (visited.has(name)) return;
  visiting.add(name);
  for (const dependency of graph.get(name) ?? []) visit(dependency, [...chain, name]);
  visiting.delete(name);
  visited.add(name);
}
for (const name of graph.keys()) visit(name);

if (failures.length > 0) {
  console.error('Architecture constitution guard failed:');
  for (const failure of [...new Set(failures)]) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log('Architecture constitution guard passed.');
NODE
