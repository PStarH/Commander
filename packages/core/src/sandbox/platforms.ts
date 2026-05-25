import { execSync, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { PlatformSandbox, SandboxProfile, SandboxExecutionResult } from './types';
import { getGlobalLogger } from '../logging';

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

/**
 * Build a macOS Seatbelt (.sbpl) profile string for a given SandboxProfile.
 *
 * Inspired by OpenAI Codex and Chromium sandbox policies:
 *   - https://github.com/openai/codex/blob/9a8730f3/codex-rs/sandboxing/src/seatbelt_base_policy.sbpl
 *   - https://source.chromium.org/chromium/chromium/src/+/main:sandbox/policy/mac/common.sb
 *
 * Design principles:
 *   1. Closed-by-default: (deny default) at the top, then allow only what's needed.
 *   2. Process management limited to same-sandbox — processes spawned inherit the policy.
 *   3. IOKit restricted to the bare minimum (RootDomainUserClient for system state).
 *   4. Sysctl-read allowlisted for common tooling (compilers, git, shell).
 *   5. Mach IPC restricted to known-safe services.
 *   6. File-system follows the profile's read/write lists, with overrides for
 *      protected paths and system directories.
 *   7. PTY support for interactive shells.
 */
function buildSeatbeltProfile(p: SandboxProfile): string {
  const lines: string[] = [];

  // ------------------------------------------------------------------
  // Base: closed by default
  // ------------------------------------------------------------------
  lines.push('(version 1)');
  lines.push('(deny default)');
  lines.push('(debug deny)');

  // ------------------------------------------------------------------
  // Process lifecycle — spawned children inherit the same policy
  // ------------------------------------------------------------------
  lines.push('(allow process-exec)');
  lines.push('(allow process-fork)');
  lines.push('(allow signal (target same-sandbox))');

  // ------------------------------------------------------------------
  // Process info — only self/same-sandbox
  // ------------------------------------------------------------------
  lines.push('(allow process-info* (target same-sandbox))');

  // ------------------------------------------------------------------
  // Sysctl — allowlist of sysctls commonly read by dev tools
  // ------------------------------------------------------------------
  const sysctlNames = [
    'hw.activecpu', 'hw.busfrequency_compat', 'hw.byteorder',
    'hw.cacheconfig', 'hw.cachelinesize_compat', 'hw.cpufamily',
    'hw.cpufrequency_compat', 'hw.cputype', 'hw.l1dcachesize_compat',
    'hw.l1icachesize_compat', 'hw.l2cachesize_compat', 'hw.l3cachesize_compat',
    'hw.logicalcpu', 'hw.logicalcpu_max', 'hw.machine', 'hw.model',
    'hw.memsize', 'hw.ncpu', 'hw.nperflevels', 'hw.packages',
    'hw.pagesize_compat', 'hw.pagesize', 'hw.physicalcpu',
    'hw.physicalcpu_max', 'hw.cpufrequency', 'hw.tbfrequency_compat',
    'hw.vectorunit', 'machdep.cpu.brand_string', 'kern.argmax',
    'kern.hostname', 'kern.maxfilesperproc', 'kern.maxproc',
    'kern.osproductversion', 'kern.osrelease', 'kern.ostype',
    'kern.osvariant_status', 'kern.osversion', 'kern.secure_kernel',
    'kern.usrstack64', 'kern.version', 'vm.loadavg',
    'kern.ngroups', 'kern.sbkeys',
  ];
  lines.push(`(allow sysctl-read\n${sysctlNames.map(n => `  (sysctl-name "${n}")`).join('\n')}\n  (sysctl-name-prefix "hw.optional.arm.")\n  (sysctl-name-prefix "hw.optional.armv8_")\n  (sysctl-name-prefix "hw.perflevel")\n  (sysctl-name-prefix "kern.proc.pgrp.")\n  (sysctl-name-prefix "kern.proc.pid.")\n  (sysctl-name-prefix "net.routetable."))`);

  // Allow Java/node to read CPU info — misclassified as write by SB
  lines.push('(allow sysctl-write (sysctl-name "kern.grade_cputype"))');

  // ------------------------------------------------------------------
  // IOKit — restrict to bare minimum
  // ------------------------------------------------------------------
  lines.push('(allow iokit-open (iokit-registry-entry-class "RootDomainUserClient"))');

  // ------------------------------------------------------------------
  // Mach IPC — allowlist of known-safe services
  // ------------------------------------------------------------------
  lines.push('(allow mach-lookup');
  lines.push('  (global-name "com.apple.system.opendirectoryd.libinfo")');
  lines.push('  (global-name "com.apple.PowerManagement.control")');
  lines.push('  (global-name "com.apple.cfprefsd.daemon")');
  lines.push('  (global-name "com.apple.cfprefsd.agent")');
  lines.push('  (global-name "com.apple.system.logger")');
  lines.push('  (local-name "com.apple.cfprefsd.agent"))');

  // ------------------------------------------------------------------
  // POSIX IPC — semaphores and shared memory (needed for python multiprocessing)
  // ------------------------------------------------------------------
  lines.push('(allow ipc-posix-sem)');
  lines.push('(allow ipc-posix-shm-read* (ipc-posix-name-prefix "apple.cfprefs."))');

  // ------------------------------------------------------------------
  // PTY support — interactive shells
  // ------------------------------------------------------------------
  lines.push('(allow pseudo-tty)');
  lines.push('(allow file-read* file-write* file-ioctl (literal "/dev/ptmx"))');
  lines.push('(allow file-read* file-write*');
  lines.push('  (require-all');
  lines.push('    (regex #"^/dev/ttys[0-9]+")');
  lines.push('    (extension "com.apple.sandbox.pty")))');
  lines.push('(allow file-ioctl (regex #"^/dev/ttys[0-9]+"))');

  // ------------------------------------------------------------------
  // /dev/null  (write-data needed for redirects)
  // ------------------------------------------------------------------
  lines.push('(allow file-write-data');
  lines.push('  (require-all');
  lines.push('    (path "/dev/null")');
  lines.push('    (vnode-type CHARACTER-DEVICE)))');

  // ------------------------------------------------------------------
  // User preferences read (read-only cfprefs access)
  // ------------------------------------------------------------------
  lines.push('(allow user-preference-read)');

  // ------------------------------------------------------------------
  // File-system — readable paths
  // ------------------------------------------------------------------
  for (const r of p.filesystem.readablePaths) {
    lines.push(`(allow file-read* (subpath "${path.resolve(r)}"))`);
  }

  // ------------------------------------------------------------------
  // File-system — writable paths (only if profile allows writes)
  // ------------------------------------------------------------------
  if (p.mode !== 'read-only') {
    for (const w of p.filesystem.writablePaths) {
      lines.push(`(allow file-write* (subpath "${path.resolve(w)}"))`);
    }
  }

  // ------------------------------------------------------------------
  // Always allow temp directories (for compilers, package managers, scripts)
  // ------------------------------------------------------------------
  lines.push('(allow file-read* file-write* (subpath "/tmp"))');
  lines.push('(allow file-read* file-write* (subpath "/private/tmp"))');
  lines.push('(allow file-read* file-write* (subpath "/var/tmp"))');

  // ------------------------------------------------------------------
  // Protected paths — deny writes even within writable areas
  // ------------------------------------------------------------------
  for (const pt of p.filesystem.protectedPaths) {
    const abs = path.resolve(pt);
    lines.push(`(deny file-write* (subpath "${abs}"))`);
  }

  // ------------------------------------------------------------------
  // System directory write protection (defense-in-depth)
  // ------------------------------------------------------------------
  const systemPaths = [
    '/System', '/Library', '/Applications',
    '/.vol', '/.file', '/dev', '/cores',
  ];
  for (const sp of systemPaths) {
    lines.push(`(deny file-write* (subpath "${sp}"))`);
  }

  // Deny writes to user home .ssh, .gnupg (sensitive dotfiles)
  const home = os.homedir();
  lines.push(`(deny file-read* file-write* (subpath "${home}/.ssh"))`);
  lines.push(`(deny file-read* file-write* (subpath "${home}/.gnupg"))`);

  // ------------------------------------------------------------------
  // Network — enforce policy
  // ------------------------------------------------------------------
  if (p.network === 'blocked') {
    lines.push('(deny network* (apply to process))');
  } else if (p.network === 'allowlisted') {
    lines.push('(deny network* (with no-log) (apply to process))');
    if (p.allowedDomains && p.allowedDomains.length > 0) {
      for (const d of p.allowedDomains) {
        lines.push(`(allow network-outbound (literal "${d}"))`);
      }
    }
  }
  // 'full' or 'proxy': no denial (still constrained by closed-by-default base —
  // but network is implicitly allowed since we didn't explicitly deny it after
  // the (deny default). We add an explicit allow for clarity.
  if (p.network === 'full' || p.network === 'proxy') {
    lines.push('(allow network*)');
  }

  return lines.join('\n');
}

// macOS Seatbelt — hardened
class SeatbeltSB implements PlatformSandbox {
  readonly name = 'seatbelt' as const;
  readonly available: boolean;
  constructor() {
    this.available = os.platform() === 'darwin' && (() => { try { execSync('which sandbox-exec 2>/dev/null', { timeout: 3000 }); return true; } catch (e) { getGlobalLogger().debug('SeatbeltSB', 'sandbox-exec unavailable', { error: (e as Error)?.message }); return false; } })();
  }
  async execute(cmd: string, p: SandboxProfile, wd?: string): Promise<SandboxExecutionResult> {
    const profile = buildSeatbeltProfile(p);
    const tf = path.join(os.tmpdir(), `.cmd-sb-${Date.now()}.sb`);
    fs.writeFileSync(tf, profile, 'utf-8');
    const env = filterEnv(p);
    const timeout = p.timeout ?? 60000;
    return exec(`sandbox-exec -f "${tf}" ${cmd}`, wd ?? process.cwd(), env, timeout)
      .then(r => ({ ...r, sandboxMechanism: 'seatbelt' as const }))
      .finally(() => { try { fs.unlinkSync(tf); } catch (e) { getGlobalLogger().warn('SeatbeltSB', 'Temp sandbox profile cleanup failed', { error: (e as Error)?.message }); } });
  }
}

// Linux Bubblewrap
class BwrapSB implements PlatformSandbox {
  readonly name = 'bwrap' as const;
  readonly available: boolean;
  constructor() {
    this.available = os.platform() === 'linux' && (() => { try { execSync('which bwrap 2>/dev/null', { timeout: 3000 }); return true; } catch (e) { getGlobalLogger().debug('BwrapSB', 'bwrap unavailable', { error: (e as Error)?.message }); return false; } })();
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
    this.available = (() => { try { execSync('docker info 2>/dev/null', { timeout: 5000 }); return true; } catch (e) { getGlobalLogger().debug('DockerSB', 'docker unavailable', { error: (e as Error)?.message }); return false; } })();
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
