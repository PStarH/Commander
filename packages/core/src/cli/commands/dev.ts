import {
  chmodSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
  closeSync,
  writeSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import * as path from 'node:path';

export interface DevCommandFlags {
  dataDir?: string;
  'data-dir'?: string;
  port?: string;
  reset?: boolean;
  'no-open'?: boolean;
  verbose?: boolean;
}

export class DevAlreadyRunningError extends Error {
  readonly code = 'DEV_ALREADY_RUNNING';
  constructor() {
    super('commander dev is already running (dev.lock held)');
    this.name = 'DevAlreadyRunningError';
  }
}

export type DevChildRole = 'api' | 'worker' | 'kernel-ops' | 'operations';

export const DEV_SHUTDOWN_ORDER: DevChildRole[] = ['operations', 'worker', 'kernel-ops', 'api'];

export interface DevLayout {
  dataDir: string;
  kernelSqlite: string;
  apiKeyPath: string;
  lockPath: string;
  pidPath: string;
}

export function resolveDevLayout(flags: DevCommandFlags, cwd = process.cwd()): DevLayout {
  const dataDir = path.resolve(cwd, flags.dataDir ?? flags['data-dir'] ?? '.commander/dev');
  return {
    dataDir,
    kernelSqlite: path.join(dataDir, 'kernel.sqlite'),
    apiKeyPath: path.join(dataDir, 'api-key'),
    lockPath: path.join(dataDir, 'dev.lock'),
    pidPath: path.join(dataDir, 'dev.pid'),
  };
}

export function prepareDevDataDir(
  layout: DevLayout,
  reset: boolean,
): { apiKey: string; workerAuthToken: string } {
  if (reset && existsSync(layout.dataDir)) {
    rmSync(layout.dataDir, { recursive: true, force: true });
  }
  mkdirSync(layout.dataDir, { recursive: true, mode: 0o700 });
  chmodSync(layout.dataDir, 0o700);

  const apiKey = randomBytes(24).toString('hex');
  const workerAuthToken = randomBytes(24).toString('hex');
  writeFileSync(layout.apiKeyPath, `${apiKey}\n`, { mode: 0o600 });
  chmodSync(layout.apiKeyPath, 0o600);
  return { apiKey, workerAuthToken };
}

export function acquireDevLock(layout: DevLayout): { release: () => void } {
  try {
    const fd = openSync(layout.lockPath, 'wx');
    writeSync(fd, String(process.pid));
    closeSync(fd);
    chmodSync(layout.lockPath, 0o600);
    writeFileSync(layout.pidPath, String(process.pid), { mode: 0o600 });
    chmodSync(layout.pidPath, 0o600);
  } catch {
    throw new DevAlreadyRunningError();
  }
  return {
    release: () => {
      try {
        rmSync(layout.lockPath, { force: true });
        rmSync(layout.pidPath, { force: true });
      } catch {
        // ignore
      }
    },
  };
}

export function buildDevChildEnv(input: {
  layout: DevLayout;
  port: number;
  apiKey: string;
  workerAuthToken: string;
  repoRoot: string;
  opsHealthPort: number;
}): NodeJS.ProcessEnv {
  const bootstrap = path.join(input.repoRoot, 'packages/worker-plane/src/bootstrap.ts');
  return {
    ...process.env,
    NODE_ENV: 'development',
    COMMANDER_PROFILE: 'local',
    COMMANDER_KERNEL_BACKEND: 'sqlite',
    COMMANDER_KERNEL_SQLITE_PATH: input.layout.kernelSqlite,
    COMMANDER_KERNEL_ENABLED: '1',
    COMMANDER_CELL_TENANT_ID: 'local',
    PORT: String(input.port),
    API_KEYS: input.apiKey,
    TENANT_API_KEYS: `local:${input.apiKey}`,
    COMMANDER_WORKER_AUTH_TOKEN: input.workerAuthToken,
    COMMANDER_WORKER_BOOTSTRAP: bootstrap,
    COMMANDER_OPS_HEALTH_PORT: String(input.opsHealthPort),
  };
}

export interface DevChildSpec {
  role: DevChildRole;
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
}

export function buildDevChildSpecs(input: {
  repoRoot: string;
  env: NodeJS.ProcessEnv;
}): DevChildSpec[] {
  const node = process.execPath;
  const workerBootstrap = input.env.COMMANDER_WORKER_BOOTSTRAP ?? '';
  return [
    {
      role: 'api',
      command: node,
      args: ['--import', 'tsx', 'apps/api/src/index.ts'],
      env: input.env,
      cwd: input.repoRoot,
    },
    {
      role: 'worker',
      command: node,
      args: ['packages/worker-plane/dist/main.js'],
      env: { ...input.env, COMMANDER_WORKER_BOOTSTRAP: workerBootstrap },
      cwd: input.repoRoot,
    },
    {
      role: 'kernel-ops',
      command: node,
      args: ['packages/kernel/dist/ops/main.js'],
      env: input.env,
      cwd: input.repoRoot,
    },
    {
      role: 'operations',
      command: node,
      args: ['packages/operations/dist/run.js'],
      env: input.env,
      cwd: input.repoRoot,
    },
  ];
}

export type SpawnFn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

export async function pollReady(url: string, timeoutMs = 120_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.status === 200) return true;
    } catch {
      // retry
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

export async function shutdownChildren(
  children: Map<DevChildRole, ChildProcess>,
  order: DevChildRole[] = DEV_SHUTDOWN_ORDER,
  signal: NodeJS.Signals = 'SIGTERM',
  graceMs = 5_000,
): Promise<void> {
  for (const role of order) {
    const child = children.get(role);
    if (!child || child.killed) continue;
    child.kill(signal);
  }
  await new Promise((resolve) => setTimeout(resolve, graceMs));
  for (const child of children.values()) {
    if (!child.killed) child.kill('SIGKILL');
  }
}

export async function cmdDev(
  _args: string[],
  flags: DevCommandFlags,
  options: {
    repoRoot?: string;
    spawnFn?: SpawnFn;
    pollFn?: typeof pollReady;
    openBrowser?: (url: string) => void;
  } = {},
): Promise<void> {
  const repoRoot = options.repoRoot ?? process.cwd();
  const layout = resolveDevLayout(flags, repoRoot);
  const port = Number(flags.port ?? 4000);
  const opsHealthPort = port + 4081;
  const { apiKey, workerAuthToken } = prepareDevDataDir(layout, Boolean(flags.reset));
  const lock = acquireDevLock(layout);
  const env = buildDevChildEnv({ layout, port, apiKey, workerAuthToken, repoRoot, opsHealthPort });
  if (flags.verbose) {
    const filteredEnv = Object.fromEntries(
      Object.entries(env).filter(([k]) => k === 'PORT' || k.startsWith('COMMANDER_')),
    );
    writeFileSync(path.join(layout.dataDir, 'ops.env'), JSON.stringify(filteredEnv, null, 2), {
      mode: 0o600,
    });
  }

  const spawnFn = options.spawnFn ?? spawn;
  const specs = buildDevChildSpecs({ repoRoot, env });
  const children = new Map<DevChildRole, ChildProcess>();
  let shuttingDown = false;
  let childCrashed = false;

  const teardown = async (code = 0): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    await shutdownChildren(children);
    lock.release();
    if (childCrashed) process.exitCode = 1;
    else process.exitCode = code;
  };

  for (const spec of specs) {
    const child = spawnFn(spec.command, spec.args, {
      cwd: spec.cwd,
      env: spec.env,
      stdio: flags.verbose ? 'inherit' : 'pipe',
    });
    children.set(spec.role, child);
    child.on('exit', (exitCode, signal) => {
      if (shuttingDown) return;
      if (exitCode !== 0 || signal) {
        childCrashed = true;
        void teardown(1);
      }
    });
  }

  const readyUrl = `http://127.0.0.1:${port}/ready`;
  const pollFn = options.pollFn ?? pollReady;
  const ready = await pollFn(readyUrl);
  if (!ready) {
    childCrashed = true;
    await teardown(1);
    throw new Error(`Timed out waiting for ${readyUrl}`);
  }

  if (!flags['no-open'] && options.openBrowser) {
    options.openBrowser(`http://127.0.0.1:${port}/v1/openapi.json`);
  }

  process.stdout.write(
    `commander dev ready on http://127.0.0.1:${port} (api-key: ${layout.apiKeyPath})\n`,
  );

  await new Promise<void>((resolve) => {
    if (childCrashed) {
      void teardown(1).then(resolve);
      return;
    }
    const onSignal = () => {
      void teardown(0).then(resolve);
    };
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
  });
}
