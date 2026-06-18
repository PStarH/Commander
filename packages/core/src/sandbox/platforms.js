"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.NoopSB = void 0;
exports.discoverSandboxes = discoverSandboxes;
const child_process_1 = require("child_process");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const os = __importStar(require("os"));
const logging_1 = require("../logging");
const seccompBpf_1 = require("./seccompBpf");
const networkProxy_1 = require("./networkProxy");
// Expanded deny list — covers common secret-bearing env vars beyond the original 5
const EXTRA_DENY = [
    'DATABASE_URL',
    'REDIS_URL',
    'MONGO_URL',
    'PGPASSWORD',
    'MYSQL_PASSWORD',
    'GITHUB_PAT',
    'NPM_TOKEN',
    'COOKIE',
    'AUTH',
    'BEARER',
    'PRIVATE_KEY',
    'SIGNING_KEY',
    'ENCRYPTION_KEY',
    'CONNECTION_STRING',
    'DSN',
];
function filterEnv(p) {
    var _a, _b;
    const env = {};
    const deny = [...((_a = p.envVarDenyList) !== null && _a !== void 0 ? _a : []), ...EXTRA_DENY].map((x) => x.toUpperCase());
    const allow = (_b = p.envVarAllowList) !== null && _b !== void 0 ? _b : [];
    for (const [k, v] of Object.entries(process.env)) {
        const u = k.toUpperCase();
        if (allow.length > 0 && !allow.includes(k))
            continue;
        if (deny.some((d) => u.includes(d)))
            continue;
        if (k.startsWith('DOCKER_') || k.startsWith('SSH_'))
            continue;
        // Sanitize value: strip newlines and null bytes to prevent Docker env injection
        const safeValue = (v !== null && v !== void 0 ? v : '').replace(/[\n\r\x00]/g, '');
        env[k] = safeValue;
    }
    return env;
}
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024; // 10MB
/** Execute a command as an explicit argv array (no shell interpolation). */
function execArgv(argv, cwd, env, timeout) {
    return exec(argv, cwd, env, timeout);
}
/**
 * Execute a command. If `cmd` is a string, runs via shell (for backward compat with NoopSB).
 * If `cmd` is a string[], uses spawn with explicit args (shell: false) to prevent injection.
 */
function exec(cmd, cwd, env, timeout) {
    return new Promise((resolve) => {
        var _a, _b;
        const start = Date.now();
        const isArr = Array.isArray(cmd);
        const child = isArr
            ? (0, child_process_1.spawn)(cmd[0], cmd.slice(1), { stdio: ['pipe', 'pipe', 'pipe'], cwd, env })
            : (0, child_process_1.spawn)(cmd, [], { stdio: ['pipe', 'pipe', 'pipe'], cwd, env, shell: true });
        let stdout = '', stderr = '';
        let stdoutTruncated = false, stderrTruncated = false;
        (_a = child.stdout) === null || _a === void 0 ? void 0 : _a.on('data', (d) => {
            if (stdout.length < MAX_OUTPUT_BYTES) {
                stdout += d.toString();
                if (stdout.length > MAX_OUTPUT_BYTES) {
                    stdout = stdout.slice(0, MAX_OUTPUT_BYTES);
                    stdoutTruncated = true;
                }
            }
        });
        (_b = child.stderr) === null || _b === void 0 ? void 0 : _b.on('data', (d) => {
            if (stderr.length < MAX_OUTPUT_BYTES) {
                stderr += d.toString();
                if (stderr.length > MAX_OUTPUT_BYTES) {
                    stderr = stderr.slice(0, MAX_OUTPUT_BYTES);
                    stderrTruncated = true;
                }
            }
        });
        // Explicit timeout since spawn doesn't honor the timeout option
        let timedOut = false;
        const killTimer = setTimeout(() => {
            timedOut = true;
            child.kill('SIGKILL');
        }, timeout);
        killTimer.unref();
        child.on('close', (ec) => {
            clearTimeout(killTimer);
            resolve({
                stdout: stdoutTruncated ? stdout + '\n[truncated]' : stdout,
                stderr: stderrTruncated ? stderr + '\n[truncated]' : stderr,
                exitCode: timedOut ? 137 : (ec !== null && ec !== void 0 ? ec : -1),
                durationMs: Date.now() - start,
                sandboxMechanism: 'none',
            });
        });
        child.on('error', (err) => {
            clearTimeout(killTimer);
            resolve({
                stdout,
                stderr: stderr || err.message,
                exitCode: -1,
                durationMs: Date.now() - start,
                sandboxMechanism: 'none',
            });
        });
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
function buildSeatbeltProfile(p) {
    const lines = [];
    // ------------------------------------------------------------------
    // Base: closed by default
    // ------------------------------------------------------------------
    lines.push('(version 1)');
    lines.push('(deny default)');
    lines.push('(debug deny)');
    // ------------------------------------------------------------------
    // Process lifecycle — spawned children inherit the same policy
    // SECURITY FIX: restrict process-exec to common tool directories instead of allowing all
    // ------------------------------------------------------------------
    const execPaths = [
        '/usr/bin',
        '/usr/local/bin',
        '/bin',
        '/sbin',
        '/usr/sbin',
        '/opt/homebrew/bin',
    ];
    for (const ep of execPaths) {
        lines.push(`(allow process-exec (subpath "${ep}"))`);
    }
    // Also allow exec from the workspace (for scripts, node_modules/.bin, etc.)
    lines.push(`(allow process-exec (subpath "${path.resolve(p.filesystem.readablePaths[0] || process.cwd())}"))`);
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
        'hw.activecpu',
        'hw.busfrequency_compat',
        'hw.byteorder',
        'hw.cacheconfig',
        'hw.cachelinesize_compat',
        'hw.cpufamily',
        'hw.cpufrequency_compat',
        'hw.cputype',
        'hw.l1dcachesize_compat',
        'hw.l1icachesize_compat',
        'hw.l2cachesize_compat',
        'hw.l3cachesize_compat',
        'hw.logicalcpu',
        'hw.logicalcpu_max',
        'hw.machine',
        'hw.model',
        'hw.memsize',
        'hw.ncpu',
        'hw.nperflevels',
        'hw.packages',
        'hw.pagesize_compat',
        'hw.pagesize',
        'hw.physicalcpu',
        'hw.physicalcpu_max',
        'hw.cpufrequency',
        'hw.tbfrequency_compat',
        'hw.vectorunit',
        'machdep.cpu.brand_string',
        'kern.argmax',
        'kern.hostname',
        'kern.maxfilesperproc',
        'kern.maxproc',
        'kern.osproductversion',
        'kern.osrelease',
        'kern.ostype',
        'kern.osvariant_status',
        'kern.osversion',
        'kern.secure_kernel',
        'kern.usrstack64',
        'kern.version',
        'vm.loadavg',
        'kern.ngroups',
        'kern.sbkeys',
    ];
    lines.push(`(allow sysctl-read\n${sysctlNames.map((n) => `  (sysctl-name "${n}")`).join('\n')}\n  (sysctl-name-prefix "hw.optional.arm.")\n  (sysctl-name-prefix "hw.optional.armv8_")\n  (sysctl-name-prefix "hw.perflevel")\n  (sysctl-name-prefix "kern.proc.pgrp.")\n  (sysctl-name-prefix "kern.proc.pid.")\n  (sysctl-name-prefix "net.routetable."))`);
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
    const systemPaths = ['/System', '/Library', '/Applications', '/.vol', '/.file', '/dev', '/cores'];
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
    }
    else if (p.network === 'allowlisted') {
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
class SeatbeltSB {
    constructor() {
        this.name = 'seatbelt';
        this.available =
            os.platform() === 'darwin' &&
                (() => {
                    try {
                        (0, child_process_1.execSync)('which sandbox-exec 2>/dev/null', { timeout: 3000 });
                        return true;
                    }
                    catch (e) {
                        (0, logging_1.getGlobalLogger)().debug('SeatbeltSB', 'sandbox-exec unavailable', {
                            error: e === null || e === void 0 ? void 0 : e.message,
                        });
                        return false;
                    }
                })();
    }
    async execute(cmd, p, wd) {
        var _a;
        const profile = buildSeatbeltProfile(p);
        // Use mkdtemp for unpredictable temp file name (prevents TOCTOU symlink attack)
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), '.cmd-sb-'));
        const tf = path.join(tmpDir, 'profile.sb');
        fs.writeFileSync(tf, profile, 'utf-8');
        const env = filterEnv(p);
        const timeout = (_a = p.timeout) !== null && _a !== void 0 ? _a : 60000;
        // CRITICAL FIX: use spawn with explicit args instead of shell interpolation
        // This prevents command injection via shell metacharacters in `cmd`
        return execArgv(['sandbox-exec', '-f', tf, '/bin/sh', '-c', cmd], wd !== null && wd !== void 0 ? wd : process.cwd(), env, timeout)
            .then((r) => ({ ...r, sandboxMechanism: 'seatbelt' }))
            .finally(() => {
            try {
                fs.rmSync(tmpDir, { recursive: true, force: true });
            }
            catch (e) {
                (0, logging_1.getGlobalLogger)().warn('SeatbeltSB', 'Temp sandbox profile cleanup failed', {
                    error: e === null || e === void 0 ? void 0 : e.message,
                });
            }
        });
    }
}
// Linux Bubblewrap
class BwrapSB {
    constructor() {
        this.name = 'bwrap';
        this.available =
            os.platform() === 'linux' &&
                (() => {
                    try {
                        (0, child_process_1.execSync)('which bwrap 2>/dev/null', { timeout: 3000 });
                        return true;
                    }
                    catch (e) {
                        (0, logging_1.getGlobalLogger)().debug('BwrapSB', 'bwrap unavailable', { error: e === null || e === void 0 ? void 0 : e.message });
                        return false;
                    }
                })();
    }
    async execute(cmd, p, wd) {
        const start = Date.now();
        const workdir = wd !== null && wd !== void 0 ? wd : process.cwd();
        const env = filterEnv(p);
        // Codex CLI pattern: read-only by default, carve-out writable
        // Start with read-only mounts for system directories
        const args = [
            '--unshare-user',
            '--unshare-pid',
            '--unshare-ipc',
            '--new-session',
            // Codex pattern: read-only system dirs
            '--ro-bind',
            '/usr',
            '/usr',
            '--ro-bind',
            '/lib',
            '/lib',
            '--ro-bind',
            '/lib64',
            '/lib64',
            '--ro-bind',
            '/bin',
            '/bin',
            '--ro-bind',
            '/sbin',
            '/sbin',
            '--ro-bind',
            '/etc',
            '/etc',
            // Codex: also mount /nix/store and /run/current-system/sw if they exist (NixOS support)
            ...(fs.existsSync('/nix/store') ? ['--ro-bind', '/nix/store', '/nix/store'] : []),
            ...(fs.existsSync('/run/current-system/sw')
                ? ['--ro-bind', '/run/current-system/sw', '/run/current-system/sw']
                : []),
            '--proc',
            '/proc',
            '--dev',
            '/dev',
            '--dev-bind',
            '/dev/urandom',
            '/dev/urandom',
            '--dev-bind',
            '/dev/null',
            '/dev/null',
            '--dev-bind',
            '/dev/zero',
            '/dev/zero',
            // Codex: die-with-parent ensures sandbox cleanup on parent crash
            '--die-with-parent',
        ];
        // Workspace: read-only or read-write depending on mode
        if (p.mode !== 'read-only') {
            args.push('--bind', workdir, workdir);
        }
        else {
            args.push('--ro-bind', workdir, workdir);
        }
        // SECURITY FIX: use tmpfs for /tmp instead of bind-mounting host /tmp
        args.push('--tmpfs', '/tmp');
        // Codex pattern: re-mount protected paths read-only AFTER workspace bind
        // This ensures .git etc. are protected even within a writable workspace
        for (const pt of p.filesystem.protectedPaths) {
            const a = path.resolve(workdir, pt);
            if (fs.existsSync(a))
                args.push('--ro-bind', a, a);
        }
        // Network isolation: block for non-full profiles
        if (p.network === 'blocked' || p.network === 'allowlisted')
            args.push('--unshare-net');
        // Seccomp-BPF: syscall-level filtering (from Codex CLI research)
        // Generates a whitelist BPF program and passes it to bwrap via --seccomp FD
        let seccompFile = null;
        try {
            const bpf = (0, seccompBpf_1.buildSeccompFilter)({
                allowNetwork: p.network === 'full' || p.network === 'proxy',
                allowProcessCreation: true,
            });
            seccompFile = path.join(os.tmpdir(), `.cmd-seccomp-${Date.now()}.bpf`);
            fs.writeFileSync(seccompFile, bpf);
            args.push('--seccomp', '3');
            const syscallCount = (0, seccompBpf_1.countAllowedSyscalls)({ allowNetwork: p.network === 'full' });
            (0, logging_1.getGlobalLogger)().debug('BwrapSB', `Seccomp filter: ${syscallCount} syscalls allowed, ${bpf.length / 8} BPF instructions`);
        }
        catch (e) {
            (0, logging_1.getGlobalLogger)().warn('BwrapSB', 'Seccomp filter generation failed, proceeding without', {
                error: e === null || e === void 0 ? void 0 : e.message,
            });
        }
        args.push('--chdir', workdir, '/bin/sh', '-c', cmd);
        // Open seccomp file as fd 3 if available
        const stdio = ['pipe', 'pipe', 'pipe'];
        let seccompFd = null;
        if (seccompFile) {
            try {
                seccompFd = fs.openSync(seccompFile, 'r');
                stdio.push(seccompFd);
            }
            catch {
                // Proceed without seccomp if fd open fails
                seccompFile = null;
                seccompFd = null;
            }
        }
        return new Promise((resolve) => {
            var _a, _b, _c;
            const child = (0, child_process_1.spawn)('bwrap', args, { stdio, cwd: '/', env });
            let so = '', se = '';
            let soTrunc = false, seTrunc = false;
            (_a = child.stdout) === null || _a === void 0 ? void 0 : _a.on('data', (d) => {
                if (so.length < MAX_OUTPUT_BYTES) {
                    so += d.toString();
                    if (so.length > MAX_OUTPUT_BYTES) {
                        so = so.slice(0, MAX_OUTPUT_BYTES);
                        soTrunc = true;
                    }
                }
            });
            (_b = child.stderr) === null || _b === void 0 ? void 0 : _b.on('data', (d) => {
                if (se.length < MAX_OUTPUT_BYTES) {
                    se += d.toString();
                    if (se.length > MAX_OUTPUT_BYTES) {
                        se = se.slice(0, MAX_OUTPUT_BYTES);
                        seTrunc = true;
                    }
                }
            });
            // Codex pattern: forward signals to child process group
            const forwardSignal = (sig) => {
                try {
                    child.kill(sig);
                }
                catch {
                    /* process may have exited */
                }
            };
            const sigHandler = (sig) => () => forwardSignal(sig);
            process.on('SIGHUP', sigHandler('SIGHUP'));
            process.on('SIGINT', sigHandler('SIGINT'));
            process.on('SIGQUIT', sigHandler('SIGQUIT'));
            process.on('SIGTERM', sigHandler('SIGTERM'));
            let timedOut = false;
            const killTimer = setTimeout(() => {
                timedOut = true;
                child.kill('SIGKILL');
            }, (_c = p.timeout) !== null && _c !== void 0 ? _c : 60000);
            killTimer.unref();
            const cleanup = () => {
                clearTimeout(killTimer);
                process.removeListener('SIGHUP', sigHandler('SIGHUP'));
                process.removeListener('SIGINT', sigHandler('SIGINT'));
                process.removeListener('SIGQUIT', sigHandler('SIGQUIT'));
                process.removeListener('SIGTERM', sigHandler('SIGTERM'));
                // Clean up seccomp fd and temp file
                if (seccompFd !== null) {
                    try {
                        fs.closeSync(seccompFd);
                    }
                    catch {
                        /* ignore */
                    }
                }
                if (seccompFile) {
                    try {
                        fs.unlinkSync(seccompFile);
                    }
                    catch {
                        /* ignore */
                    }
                }
            };
            child.on('close', (ec) => {
                cleanup();
                resolve({
                    stdout: soTrunc ? so + '\n[truncated]' : so,
                    stderr: seTrunc ? se + '\n[truncated]' : se,
                    exitCode: timedOut ? 137 : (ec !== null && ec !== void 0 ? ec : -1),
                    durationMs: Date.now() - start,
                    sandboxMechanism: 'bwrap',
                });
            });
            child.on('error', (err) => {
                cleanup();
                resolve({
                    stdout: so,
                    stderr: se || err.message,
                    exitCode: -1,
                    durationMs: Date.now() - start,
                    sandboxMechanism: 'bwrap',
                });
            });
        });
    }
}
// gVisor (runsc) — kernel-level sandbox providing stronger isolation than standard Docker.
// Uses the runsc OCI runtime (gVisor's user-space kernel) which intercepts all syscalls.
// Falls back to DockerSB if runsc is not available.
class GVisorSB {
    constructor() {
        this.name = 'gvisor';
        // Check if runsc (gVisor's runtime binary) is installed
        this.available = (() => {
            try {
                (0, child_process_1.execSync)('runsc --version 2>/dev/null', { timeout: 3000 });
                return true;
            }
            catch {
                // Also check if Docker has a runsc runtime configured
                try {
                    const info = (0, child_process_1.execSync)('docker info --format "{{.Runtimes}}" 2>/dev/null', {
                        timeout: 3000,
                        encoding: 'utf-8',
                    });
                    return info.includes('runsc');
                }
                catch {
                    (0, logging_1.getGlobalLogger)().debug('GVisorSB', 'gVisor (runsc) not available');
                    return false;
                }
            }
        })();
    }
    async execute(cmd, p, wd) {
        const start = Date.now();
        const workdir = wd !== null && wd !== void 0 ? wd : process.cwd();
        const image = process.env.COMMANDER_SANDBOX_IMAGE || 'node:22-slim';
        const ALLOWED_IMAGES = [
            'node:22-slim',
            'node:20-slim',
            'python:3.12-slim',
            'python:3.11-slim',
            'ubuntu:22.04',
        ];
        const resolvedImage = ALLOWED_IMAGES.includes(image) ? image : 'node:22-slim';
        const args = [
            'run',
            '--rm',
            '--runtime',
            'runsc', // Use gVisor as the OCI runtime
            '-v',
            `${workdir}:${workdir}:${p.mode === 'read-only' ? 'ro' : 'rw'}`,
            '-w',
            workdir,
        ];
        // gVisor-specific security: no-new-privileges is enforced by default
        args.push('--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--read-only', '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m');
        // Network isolation
        if (p.network === 'blocked') {
            args.push('--network', 'none');
        }
        else if (p.network === 'proxy') {
            // For proxy mode, use the network proxy (same as DockerSB)
            const domains = (0, networkProxy_1.getLLMAPIDomains)();
            if (domains.length > 0) {
                const scriptPath = (0, networkProxy_1.writeProxyScript)(domains);
                args.push('-v', `${scriptPath}:/proxy.js:ro`);
                cmd = [
                    `node /proxy.js &`,
                    `PROXY_PID=$!`,
                    `sleep 0.3`,
                    `export HTTP_PROXY=http://127.0.0.1:1999`,
                    `export HTTPS_PROXY=http://127.0.0.1:1999`,
                    `export NO_PROXY=''`,
                    cmd,
                    `EXIT_CODE=$?`,
                    `kill $PROXY_PID 2>/dev/null`,
                    `exit $EXIT_CODE`,
                ].join('; ');
                args.push('-e', 'HTTP_PROXY=http://127.0.0.1:1999');
                args.push('-e', 'HTTPS_PROXY=http://127.0.0.1:1999');
                args.push('-e', 'NO_PROXY=');
            }
            else {
                args.push('--network', 'none');
            }
        }
        if (p.memoryLimitMB && p.memoryLimitMB > 0)
            args.push('--memory', `${p.memoryLimitMB}m`);
        // Environment filtering
        const env = filterEnv(p);
        const cleanupPaths = [];
        const envFile = path.join(os.tmpdir(), `.cmd-env-${Date.now()}.txt`);
        try {
            fs.writeFileSync(envFile, Object.entries(env)
                .map(([k, v]) => `${k}=${v}`)
                .join('\n'), 'utf-8');
            args.push('--env-file', envFile);
            cleanupPaths.push(envFile);
        }
        catch {
            for (const [k, v] of Object.entries(env))
                args.push('-e', `${k}=${v}`);
        }
        // Track proxy script for cleanup
        const proxyScriptPaths = [];
        if (p.network === 'proxy' && args.some((a) => a.includes('/proxy.js'))) {
            // Find the proxy.js mount arg and clean up the source directory
            const proxyMount = args.find((a) => a.endsWith(':/proxy.js:ro'));
            if (proxyMount) {
                const scriptPath = proxyMount.split(':')[0];
                const tmpDir = path.dirname(scriptPath);
                proxyScriptPaths.push(tmpDir);
            }
        }
        args.push(resolvedImage, '/bin/sh', '-c', cmd);
        const cleanup = () => {
            for (const p of cleanupPaths) {
                try {
                    fs.unlinkSync(p);
                }
                catch {
                    /* best-effort */
                }
            }
            for (const d of proxyScriptPaths) {
                try {
                    fs.rmSync(d, { recursive: true, force: true });
                }
                catch {
                    /* best-effort */
                }
            }
        };
        return new Promise((resolve) => {
            var _a, _b, _c;
            const child = (0, child_process_1.spawn)('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] });
            let so = '', se = '';
            let soTrunc = false, seTrunc = false;
            (_a = child.stdout) === null || _a === void 0 ? void 0 : _a.on('data', (d) => {
                if (so.length < MAX_OUTPUT_BYTES) {
                    so += d.toString();
                    if (so.length > MAX_OUTPUT_BYTES) {
                        so = so.slice(0, MAX_OUTPUT_BYTES);
                        soTrunc = true;
                    }
                }
            });
            (_b = child.stderr) === null || _b === void 0 ? void 0 : _b.on('data', (d) => {
                if (se.length < MAX_OUTPUT_BYTES) {
                    se += d.toString();
                    if (se.length > MAX_OUTPUT_BYTES) {
                        se = se.slice(0, MAX_OUTPUT_BYTES);
                        seTrunc = true;
                    }
                }
            });
            let timedOut = false;
            const killTimer = setTimeout(() => {
                timedOut = true;
                child.kill('SIGKILL');
            }, (_c = p.timeout) !== null && _c !== void 0 ? _c : 120000);
            killTimer.unref();
            const finalize = () => {
                clearTimeout(killTimer);
                cleanup();
            };
            child.on('close', (ec) => {
                finalize();
                resolve({
                    stdout: soTrunc ? so + '\n[truncated]' : so,
                    stderr: seTrunc ? se + '\n[truncated]' : se,
                    exitCode: timedOut ? 137 : (ec !== null && ec !== void 0 ? ec : -1),
                    durationMs: Date.now() - start,
                    sandboxMechanism: 'gvisor',
                });
            });
            child.on('error', (err) => {
                finalize();
                resolve({
                    stdout: so,
                    stderr: se || err.message,
                    exitCode: -1,
                    durationMs: Date.now() - start,
                    sandboxMechanism: 'gvisor',
                });
            });
        });
    }
}
// Docker — supports network isolation via HTTP CONNECT proxy in 'proxy' mode
// Uses local cleanup per execution (not instance state) to avoid concurrency hazards
class DockerSB {
    constructor() {
        this.name = 'docker';
        this.available = (() => {
            try {
                (0, child_process_1.execSync)('docker info 2>/dev/null', { timeout: 5000 });
                return true;
            }
            catch (e) {
                (0, logging_1.getGlobalLogger)().debug('DockerSB', 'docker unavailable', { error: e === null || e === void 0 ? void 0 : e.message });
                return false;
            }
        })();
    }
    /** Clean up temp files locally — called once per execute() call. */
    static doCleanup(paths) {
        for (const p of paths) {
            try {
                const stat = fs.statSync(p);
                if (stat.isDirectory()) {
                    fs.rmSync(p, { recursive: true, force: true });
                }
                else {
                    fs.unlinkSync(p);
                }
            }
            catch {
                /* best-effort cleanup */
            }
        }
    }
    async execute(cmd, p, wd) {
        const start = Date.now();
        const workdir = wd !== null && wd !== void 0 ? wd : process.cwd();
        const cleanupPaths = []; // Local to this execution — concurrency-safe
        // SECURITY FIX: validate image against allowlist
        const ALLOWED_IMAGES = [
            'node:22-slim',
            'node:20-slim',
            'python:3.12-slim',
            'python:3.11-slim',
            'ubuntu:22.04',
        ];
        const requestedImage = process.env.COMMANDER_SANDBOX_IMAGE || 'node:22-slim';
        const image = ALLOWED_IMAGES.includes(requestedImage) ? requestedImage : 'node:22-slim';
        if (requestedImage && !ALLOWED_IMAGES.includes(requestedImage)) {
            (0, logging_1.getGlobalLogger)().warn('DockerSB', `Image "${requestedImage}" not in allowlist, using node:22-slim`);
        }
        const args = [
            'run',
            '--rm',
            '-v',
            `${workdir}:${workdir}:${p.mode === 'read-only' ? 'ro' : 'rw'}`,
            '-w',
            workdir,
        ];
        // Network isolation: 'none' for blocked, proxy gate for 'proxy' mode
        if (p.network === 'blocked') {
            args.push('--network', 'none');
        }
        else if (p.network === 'proxy') {
            // Proxy mode: set up HTTP CONNECT proxy as network gate
            const domains = (0, networkProxy_1.getLLMAPIDomains)();
            if (domains.length === 0) {
                // No LLM APIs configured — default to full network block
                (0, logging_1.getGlobalLogger)().warn('DockerSB', 'Proxy mode but no LLM API domains detected — falling back to network isolation');
                args.push('--network', 'none');
            }
            else {
                // Warn if the container image may not have Node.js (proxy script is JS)
                const NON_NODE_IMAGES = ['python:3.12-slim', 'python:3.11-slim', 'ubuntu:22.04'];
                if (NON_NODE_IMAGES.includes(image)) {
                    (0, logging_1.getGlobalLogger)().warn('DockerSB', `Image "${image}" may not have Node.js — proxy mode requires node for the network gate`);
                }
                const scriptPath = (0, networkProxy_1.writeProxyScript)(domains);
                cleanupPaths.push(path.dirname(scriptPath)); // Track the temp directory
                args.push('-v', `${scriptPath}:/proxy.js:ro`);
                (0, logging_1.getGlobalLogger)().info('DockerSB', `Network proxy allowlist: ${domains.join(', ')}`);
                // Wrap the command: start proxy in background, then run actual command
                cmd = [
                    `node /proxy.js &`,
                    `PROXY_PID=$!`,
                    `sleep 0.3`,
                    `export HTTP_PROXY=http://127.0.0.1:1999`,
                    `export HTTPS_PROXY=http://127.0.0.1:1999`,
                    `export NO_PROXY=''`,
                    cmd,
                    `EXIT_CODE=$?`,
                    `kill $PROXY_PID 2>/dev/null`,
                    `exit $EXIT_CODE`,
                ].join('; ');
            }
        }
        if (p.memoryLimitMB && p.memoryLimitMB > 0)
            args.push('--memory', `${p.memoryLimitMB}m`);
        args.push('--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--read-only', '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m');
        // Use --env-file to prevent env var injection via special characters
        const env = filterEnv(p);
        const envFile = path.join(os.tmpdir(), `.cmd-env-${Date.now()}.txt`);
        try {
            fs.writeFileSync(envFile, Object.entries(env)
                .map(([k, v]) => `${k}=${v}`)
                .join('\n'), 'utf-8');
            args.push('--env-file', envFile);
            cleanupPaths.push(envFile);
        }
        catch {
            // Fallback to -e flags if env-file fails
            for (const [k, v] of Object.entries(env))
                args.push('-e', `${k}=${v}`);
        }
        // For proxy mode, also set proxy env vars via -e (override env-file)
        if (p.network === 'proxy') {
            args.push('-e', 'HTTP_PROXY=http://127.0.0.1:1999');
            args.push('-e', 'HTTPS_PROXY=http://127.0.0.1:1999');
            args.push('-e', 'NO_PROXY=');
        }
        args.push(image, '/bin/sh', '-c', cmd);
        const cleanup = () => DockerSB.doCleanup(cleanupPaths);
        return new Promise((resolve) => {
            var _a, _b, _c;
            const child = (0, child_process_1.spawn)('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] });
            let so = '', se = '';
            let soTrunc = false, seTrunc = false;
            (_a = child.stdout) === null || _a === void 0 ? void 0 : _a.on('data', (d) => {
                if (so.length < MAX_OUTPUT_BYTES) {
                    so += d.toString();
                    if (so.length > MAX_OUTPUT_BYTES) {
                        so = so.slice(0, MAX_OUTPUT_BYTES);
                        soTrunc = true;
                    }
                }
            });
            (_b = child.stderr) === null || _b === void 0 ? void 0 : _b.on('data', (d) => {
                if (se.length < MAX_OUTPUT_BYTES) {
                    se += d.toString();
                    if (se.length > MAX_OUTPUT_BYTES) {
                        se = se.slice(0, MAX_OUTPUT_BYTES);
                        seTrunc = true;
                    }
                }
            });
            let timedOut = false;
            const killTimer = setTimeout(() => {
                timedOut = true;
                child.kill('SIGKILL');
            }, (_c = p.timeout) !== null && _c !== void 0 ? _c : 120000);
            killTimer.unref();
            const finalize = () => {
                clearTimeout(killTimer);
                cleanup();
            };
            child.on('close', (ec) => {
                finalize();
                resolve({
                    stdout: soTrunc ? so + '\n[truncated]' : so,
                    stderr: seTrunc ? se + '\n[truncated]' : se,
                    exitCode: timedOut ? 137 : (ec !== null && ec !== void 0 ? ec : -1),
                    durationMs: Date.now() - start,
                    sandboxMechanism: 'docker',
                });
            });
            child.on('error', (err) => {
                finalize();
                resolve({
                    stdout: so,
                    stderr: se || err.message,
                    exitCode: -1,
                    durationMs: Date.now() - start,
                    sandboxMechanism: 'docker',
                });
            });
        });
    }
}
// Noop fallback
class NoopSB {
    constructor() {
        this.name = 'none';
        this.available = true;
    }
    async execute(cmd, p, wd) {
        var _a;
        return exec(cmd, wd !== null && wd !== void 0 ? wd : process.cwd(), filterEnv(p), (_a = p.timeout) !== null && _a !== void 0 ? _a : 60000);
    }
}
exports.NoopSB = NoopSB;
function discoverSandboxes() {
    const candidates = [
        new SeatbeltSB(),
        new BwrapSB(),
        new DockerSB(),
        new GVisorSB(),
    ];
    return candidates.filter((s) => s.available);
}
