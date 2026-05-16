import { execSync, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { PlatformSandbox, SandboxProfile, SandboxExecutionResult } from './types';

function filterEnv(p: SandboxProfile): Record<string, string> {
  const env: Record<string, string> = {};
  const deny = (p.envVarDenyList ?? []).map(x => x.toUpperCase());
  const allow = p.envVarAllowList ?? [];
  for (const [k, v] of Object.entries(process.env)) {
    const u = k.toUpperCase();
    if (allow.length > 0 && !allow.includes(k)) continue;
    if (deny.some(d => u.includes(d))) continue;
    if (k.startsWith('DOCKER_') || k.startsWith('SSH_')) continue;
    env[k] = v ?? '';
  }
  return env;
}

function exec(cmd: string, cwd: string, env: Record<string, string>, timeout: number): Promise<SandboxExecutionResult> {
  return new Promise(resolve => {
    const start = Date.now();
    const child = spawn(cmd, [], { stdio: ['pipe', 'pipe', 'pipe'], cwd, env, shell: true, timeout });
    let stdout = '', stderr = '';
    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('close', ec => resolve({ stdout, stderr, exitCode: ec ?? -1, durationMs: Date.now() - start, sandboxMechanism: 'none' }));
    child.on('error', err => resolve({ stdout, stderr: stderr || err.message, exitCode: -1, durationMs: Date.now() - start, sandboxMechanism: 'none' }));
  });
}

// macOS Seatbelt
class SeatbeltSB implements PlatformSandbox {
  readonly name = 'seatbelt' as const;
  readonly available: boolean;
  constructor() {
    this.available = os.platform() === 'darwin' && (() => { try { execSync('which sandbox-exec 2>/dev/null', { timeout: 3000 }); return true; } catch { return false; } })();
  }
  async execute(cmd: string, p: SandboxProfile, wd?: string): Promise<SandboxExecutionResult> {
    const profile = [
      '(version 1)', '(debug deny)',
      '(allow sysctl-read)', '(allow process-fork)', '(allow signal (target self))',
      '(allow ipc-posix-semaphore)', '(allow ipc-posix-shm)',
      '(allow mach-lookup (global-name "com.apple.system.logger"))',
      ...p.filesystem.readablePaths.map(r => `(allow file-read* (subpath "${r}"))`),
      ...(p.mode !== 'read-only' ? p.filesystem.writablePaths.map(w => `(allow file-write* (subpath "${w}"))`) : []),
      ...p.filesystem.protectedPaths.map(pt => {
        const abs = path.resolve(pt);
        return p.filesystem.writablePaths.some(w => abs.startsWith(path.resolve(w))) ? `(deny file-write* (subpath "${abs}"))` : '';
      }).filter(Boolean),
      ...(p.network === 'blocked' ? ['(deny network* (apply to process))'] : []),
      '(allow file-read* file-write* (subpath "/tmp"))',
      '(allow file-read* file-write* (subpath "/private/tmp"))',
    ].join('\n');
    const tf = path.join(os.tmpdir(), `.cmd-sb-${Date.now()}.sb`);
    fs.writeFileSync(tf, profile, 'utf-8');
    const env = filterEnv(p);
    return exec(`sandbox-exec -f "${tf}" ${cmd}`, wd ?? process.cwd(), env, p.timeout ?? 60000)
      .then(r => ({ ...r, sandboxMechanism: 'seatbelt' as const }))
      .finally(() => { try { fs.unlinkSync(tf); } catch {} });
  }
}

// Linux Bubblewrap
class BwrapSB implements PlatformSandbox {
  readonly name = 'bwrap' as const;
  readonly available: boolean;
  constructor() {
    this.available = os.platform() === 'linux' && (() => { try { execSync('which bwrap 2>/dev/null', { timeout: 3000 }); return true; } catch { return false; } })();
  }
  async execute(cmd: string, p: SandboxProfile, wd?: string): Promise<SandboxExecutionResult> {
    const start = Date.now();
    const workdir = wd ?? process.cwd();
    const env = filterEnv(p);
    const args: string[] = [
      '--unshare-user', '--unshare-pid', '--unshare-ipc', '--new-session',
      '--ro-bind', '/usr', '/usr', '--ro-bind', '/lib', '/lib',
      '--ro-bind', '/lib64', '/lib64', '--ro-bind', '/bin', '/bin',
      '--ro-bind', '/sbin', '/sbin', '--ro-bind', '/etc', '/etc',
      '--proc', '/proc', '--dev', '/dev',
      '--dev-bind', '/dev/urandom', '/dev/urandom',
      '--dev-bind', '/dev/null', '/dev/null',
      '--dev-bind', '/dev/zero', '/dev/zero',
    ];
    if (p.mode !== 'read-only') {
      args.push('--bind', workdir, workdir);
    } else {
      args.push('--ro-bind', workdir, workdir);
    }
    args.push('--bind', '/tmp', '/tmp');
    for (const pt of p.filesystem.protectedPaths) {
      const a = path.resolve(pt);
      if (fs.existsSync(a)) args.push('--ro-bind', a, a);
    }
    if (p.network === 'blocked') args.push('--unshare-net');
    args.push('--chdir', workdir, '/bin/sh', '-c', cmd);
    return new Promise(resolve => {
      const child = spawn('bwrap', args, { stdio: ['pipe', 'pipe', 'pipe'], cwd: '/', env, timeout: p.timeout ?? 60000 });
      let so = '', se = '';
      child.stdout?.on('data', (d: Buffer) => { so += d.toString(); });
      child.stderr?.on('data', (d: Buffer) => { se += d.toString(); });
      child.on('close', ec => resolve({ stdout: so, stderr: se, exitCode: ec ?? -1, durationMs: Date.now() - start, sandboxMechanism: 'bwrap' }));
      child.on('error', err => resolve({ stdout: so, stderr: se || err.message, exitCode: -1, durationMs: Date.now() - start, sandboxMechanism: 'bwrap' }));
    });
  }
}

// Docker
class DockerSB implements PlatformSandbox {
  readonly name = 'docker' as const;
  readonly available: boolean;
  constructor() {
    this.available = (() => { try { execSync('docker info 2>/dev/null', { timeout: 5000 }); return true; } catch { return false; } })();
  }
  async execute(cmd: string, p: SandboxProfile, wd?: string): Promise<SandboxExecutionResult> {
    const start = Date.now();
    const workdir = wd ?? process.cwd();
    const image = process.env.COMMANDER_SANDBOX_IMAGE || 'node:22-slim';
    const args: string[] = ['run', '--rm', '-v', `${workdir}:${workdir}:${p.mode === 'read-only' ? 'ro' : 'rw'}`, '-w', workdir];
    if (p.network === 'blocked') args.push('--network', 'none');
    if (p.memoryLimitMB && p.memoryLimitMB > 0) args.push('--memory', `${p.memoryLimitMB}m`);
    args.push('--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--read-only', '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m');
    const env = filterEnv(p);
    for (const [k, v] of Object.entries(env)) args.push('-e', `${k}=${v}`);
    args.push(image, '/bin/sh', '-c', cmd);
    return new Promise(resolve => {
      const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'], timeout: p.timeout ?? 120000 });
      let so = '', se = '';
      child.stdout?.on('data', (d: Buffer) => { so += d.toString(); });
      child.stderr?.on('data', (d: Buffer) => { se += d.toString(); });
      child.on('close', ec => resolve({ stdout: so, stderr: se, exitCode: ec ?? -1, durationMs: Date.now() - start, sandboxMechanism: 'docker' }));
      child.on('error', err => resolve({ stdout: so, stderr: se || err.message, exitCode: -1, durationMs: Date.now() - start, sandboxMechanism: 'docker' }));
    });
  }
}

// Noop fallback
class NoopSB implements PlatformSandbox {
  readonly name = 'none' as const;
  readonly available = true;
  async execute(cmd: string, p: SandboxProfile, wd?: string): Promise<SandboxExecutionResult> {
    return exec(cmd, wd ?? process.cwd(), filterEnv(p), p.timeout ?? 60000);
  }
}

export function discoverSandboxes(): PlatformSandbox[] {
  const candidates: PlatformSandbox[] = [new SeatbeltSB(), new BwrapSB(), new DockerSB()];
  return candidates.filter(s => s.available);
}

export { NoopSB };
