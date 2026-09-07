#!/usr/bin/env node

import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MAX_CHILD_OUTPUT_BYTES = 16 * 1024;
const TOTAL_SUITES = 11;
const PACKAGE_NAME = 'commander-shadow-plane';

export const SHADOW_PHASE_A_DATABASE_PREREQUISITE_CODE = 'COMMANDER_SHADOW_PG_ADMIN_URL_REQUIRED';

export interface ShadowPhaseACommand {
  id:
    | 'contracts'
    | 'architecture'
    | 'shadow-tests'
    | 'shadow-typecheck'
    | 'shadow-clean'
    | 'shadow-build'
    | 'shadow-package'
    | 'shadow-package-contents'
    | 'shadow-package-import'
    | 'customer-pack'
    | 'postgres-live';
  file: string;
  args: string[];
  cwd?: string;
}

export interface ShadowPhaseAChildResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ShadowPhaseAGateOptions {
  ci?: boolean;
  databaseUrl?: string;
  sourceRevision?: string;
  run?: (command: ShadowPhaseACommand) => Promise<ShadowPhaseAChildResult>;
}

export interface ShadowPhaseAGateResult {
  exitCode: 0 | 1;
  code: string;
  sourceRevision: string;
  passed: number;
  total: number;
}

function suiteFailureCode(id: ShadowPhaseACommand['id']): string {
  return `SHADOW_PHASE_A_${id.replace(/-/g, '_').toUpperCase()}_FAILED`;
}

export function runBoundedShadowPhaseAChild(
  command: ShadowPhaseACommand,
): Promise<ShadowPhaseAChildResult> {
  return new Promise((resolveResult) => {
    const child = spawn(command.file, command.args, {
      cwd: command.cwd ?? process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let outputBytes = 0;

    const append = (value: Buffer, destination: 'stdout' | 'stderr') => {
      const remaining = MAX_CHILD_OUTPUT_BYTES - outputBytes;
      if (remaining <= 0) return;
      const captured = value.subarray(0, remaining).toString('utf8');
      outputBytes += Buffer.byteLength(captured);
      if (destination === 'stdout') stdout += captured;
      else stderr += captured;
    };

    child.stdout.on('data', (value: Buffer) => append(value, 'stdout'));
    child.stderr.on('data', (value: Buffer) => append(value, 'stderr'));
    child.once('error', () => resolveResult({ exitCode: 1, stdout, stderr }));
    child.once('close', (code) => resolveResult({ exitCode: code ?? 1, stdout, stderr }));
  });
}

function currentRevision(): string {
  const configured = process.env.GITHUB_SHA?.trim();
  if (configured) return configured;
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return 'unavailable';
  }
}

async function packageVersion(): Promise<string> {
  const manifest = JSON.parse(
    await readFile(resolve(process.cwd(), 'packages/shadow-plane/package.json'), 'utf8'),
  ) as { version?: unknown };
  if (
    typeof manifest.version !== 'string' ||
    !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(manifest.version)
  ) {
    throw new Error('SHADOW_PHASE_A_PACKAGE_VERSION_INVALID');
  }
  return manifest.version;
}

async function installedProductionDependencyPaths(): Promise<[string, string, string, string]> {
  const dependencyDirectory = resolve(process.cwd(), 'packages/shadow-plane/node_modules');
  const paths = await Promise.all([
    realpath(join(dependencyDirectory, 'json-canonicalize')),
    realpath(join(dependencyDirectory, 'pg')),
    realpath(join(dependencyDirectory, '@commander/contracts')),
    realpath(join(dependencyDirectory, '@commander/postgres-runtime')),
  ]);
  return [paths[0]!, paths[1]!, paths[2]!, paths[3]!];
}

function baseCommands(
  packageDirectory: string,
  packageFile: string,
  dependencies: [string, string, string, string],
): ShadowPhaseACommand[] {
  const extracted = join(packageDirectory, 'extracted');
  const moduleUrl = pathToFileURL(join(extracted, 'package/dist/index.js')).href;
  return [
    { id: 'contracts', file: 'pnpm', args: ['--filter', '@commander/contracts', 'test'] },
    {
      id: 'architecture',
      file: 'pnpm',
      args: [
        '--dir',
        'packages/core',
        'exec',
        'vitest',
        'run',
        'tests/architecture/shadow-replay-removal.test.ts',
      ],
    },
    {
      id: 'shadow-tests',
      file: 'pnpm',
      args: ['--filter', '@commander/shadow-plane', 'test'],
    },
    {
      id: 'shadow-typecheck',
      file: 'pnpm',
      args: ['--filter', '@commander/shadow-plane', 'typecheck'],
    },
    {
      id: 'shadow-clean',
      file: 'node',
      args: [
        '--input-type=module',
        '--eval',
        "import { rm } from 'node:fs/promises'; await rm('dist', { recursive: true, force: true });",
      ],
      cwd: resolve(process.cwd(), 'packages/shadow-plane'),
    },
    { id: 'shadow-build', file: 'pnpm', args: ['--filter', '@commander/shadow-plane', 'build'] },
    {
      id: 'shadow-package',
      file: 'pnpm',
      args: ['pack', '--pack-destination', packageDirectory],
      cwd: resolve(process.cwd(), 'packages/shadow-plane'),
    },
    { id: 'shadow-package-contents', file: 'tar', args: ['-tzf', packageFile] },
    {
      id: 'shadow-package-import',
      file: 'sh',
      args: [
        '-ec',
        'mkdir -p "$2/package/node_modules/@commander" && tar -xzf "$1" -C "$2" && ln -s "$4" "$2/package/node_modules/json-canonicalize" && ln -s "$5" "$2/package/node_modules/pg" && ln -s "$6" "$2/package/node_modules/@commander/contracts" && ln -s "$7" "$2/package/node_modules/@commander/postgres-runtime" && node --input-type=module --eval "import(process.argv[1])" "$3"',
        'shadow-phase-a-gate',
        packageFile,
        extracted,
        moduleUrl,
        ...dependencies,
      ],
    },
    {
      id: 'customer-pack',
      file: 'pnpm',
      args: ['exec', 'node', '--import', 'tsx', '--test', 'scripts/shadow-customer-pack.test.ts'],
    },
  ];
}

function hasRequiredPackageContents(output: string): boolean {
  return output.includes('package/dist/index.js') && output.includes('package/dist/cli.js');
}

export async function runShadowPhaseAGate(
  options: ShadowPhaseAGateOptions = {},
): Promise<ShadowPhaseAGateResult> {
  const sourceRevision = options.sourceRevision ?? currentRevision();
  const run = options.run ?? runBoundedShadowPhaseAChild;
  const packageDirectory = await mkdtemp(join(process.cwd(), '.commander-shadow-phase-a-'));
  let passed = 0;

  try {
    const version = await packageVersion();
    const packageFile = join(packageDirectory, `${PACKAGE_NAME}-${version}.tgz`);
    const dependencies = await installedProductionDependencyPaths();
    for (const command of baseCommands(packageDirectory, packageFile, dependencies)) {
      const result = await run(command);
      if (result.exitCode !== 0) {
        return {
          exitCode: 1,
          code: suiteFailureCode(command.id),
          sourceRevision,
          passed,
          total: TOTAL_SUITES,
        };
      }
      if (command.id === 'shadow-package-contents' && !hasRequiredPackageContents(result.stdout)) {
        return {
          exitCode: 1,
          code: suiteFailureCode(command.id),
          sourceRevision,
          passed,
          total: TOTAL_SUITES,
        };
      }
      passed += 1;
    }

    if (!options.databaseUrl) {
      return {
        exitCode: 1,
        code: SHADOW_PHASE_A_DATABASE_PREREQUISITE_CODE,
        sourceRevision,
        passed,
        total: TOTAL_SUITES,
      };
    }

    const databaseResult = await run({
      id: 'postgres-live',
      file: 'pnpm',
      args: ['--filter', '@commander/shadow-plane', 'test:postgres-live'],
    });
    if (databaseResult.exitCode !== 0) {
      return {
        exitCode: 1,
        code: suiteFailureCode('postgres-live'),
        sourceRevision,
        passed,
        total: TOTAL_SUITES,
      };
    }
    return {
      exitCode: 0,
      code: 'SHADOW_PHASE_A_GATE_PASSED',
      sourceRevision,
      passed: passed + 1,
      total: TOTAL_SUITES,
    };
  } catch {
    return {
      exitCode: 1,
      code: 'SHADOW_PHASE_A_GATE_CONFIGURATION_FAILED',
      sourceRevision,
      passed,
      total: TOTAL_SUITES,
    };
  } finally {
    await rm(packageDirectory, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const result = await runShadowPhaseAGate({
    ci: process.env.CI === 'true',
    databaseUrl: process.env.COMMANDER_SHADOW_PG_ADMIN_URL,
  });
  process.stdout.write(
    `shadow_phase_a_gate status=${result.exitCode === 0 ? 'passed' : 'failed'} code=${result.code} source_revision=${result.sourceRevision} suites_passed=${result.passed} suites_total=${result.total}\n`,
  );
  process.exitCode = result.exitCode;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main();
}
