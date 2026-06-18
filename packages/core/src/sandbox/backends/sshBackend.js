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
exports.SSHBackend = void 0;
exports.resolveSSHConfig = resolveSSHConfig;
const child_process_1 = require("child_process");
const path = __importStar(require("path"));
const os = __importStar(require("os"));
const securityAuditLogger_1 = require("../../security/securityAuditLogger");
/** Validate that a path contains no shell metacharacters (prevents command injection via workdir). */
function isValidShellPath(p) {
    // Allow only safe path characters: alphanumeric, /, -, _, ., ~, spaces
    // Reject anything that could break out of quotes or chain commands
    return /^[a-zA-Z0-9/_. ~@:-]+$/.test(p) && !p.includes('..');
}
function buildSshArgs(config) {
    var _a;
    const args = [
        '-o',
        `Port=${config.port}`,
        '-o',
        `ConnectTimeout=${Math.ceil(((_a = config.connectTimeoutMs) !== null && _a !== void 0 ? _a : 10000) / 1000)}`,
        '-o',
        'StrictHostKeyChecking=accept-new',
        '-o',
        'BatchMode=yes',
    ];
    if (config.identityFile) {
        args.push('-o', `IdentityFile=${config.identityFile}`);
    }
    if (config.extraOptions) {
        for (const [k, v] of Object.entries(config.extraOptions)) {
            args.push('-o', `${k}=${v}`);
        }
    }
    args.push(`${config.user}@${config.host}`);
    return args;
}
/**
 * SSH execution backend — runs commands on a remote host via the `ssh` CLI.
 * Uses BatchMode and StrictHostKeyChecking=accept-new for non-interactive auth.
 */
class SSHBackend {
    constructor(config) {
        var _a, _b;
        this.type = 'ssh';
        this.config = {
            ...config,
            port: (_a = config.port) !== null && _a !== void 0 ? _a : 22,
            connectTimeoutMs: (_b = config.connectTimeoutMs) !== null && _b !== void 0 ? _b : 10000,
        };
    }
    get available() {
        return true; // ssh CLI is available on most systems; we detect at execute time
    }
    async execute(command, workdir, timeout) {
        const start = Date.now();
        // Security: validate workdir to prevent command injection via path
        if (workdir && !isValidShellPath(workdir)) {
            (0, securityAuditLogger_1.getSecurityAuditLogger)().logCommandInjectionAttempt('SSHBackend', 'Rejected workdir with unsafe characters', { workdir });
            return {
                stdout: '',
                stderr: `Rejected: workdir contains unsafe characters: ${workdir}`,
                exitCode: 1,
                durationMs: Date.now() - start,
                sandboxMechanism: 'seatbelt',
            };
        }
        // SECURITY FIX: use single quotes for workdir to prevent $() and backtick expansion
        // Double quotes in bash still interpret $(), backticks, and ! — single quotes are literal
        const escapedWorkdir = workdir ? workdir.replace(/'/g, "'\\''") : '';
        const fullCommand = workdir ? `cd '${escapedWorkdir}' && ${command}` : command;
        const sshArgs = buildSshArgs(this.config);
        return new Promise((resolve) => {
            var _a, _b;
            const child = (0, child_process_1.spawn)('ssh', [...sshArgs, fullCommand], {
                stdio: ['pipe', 'pipe', 'pipe'],
                timeout: (timeout !== null && timeout !== void 0 ? timeout : 60) * 1000,
            });
            let stdout = '';
            let stderr = '';
            const MAX_OUTPUT = 10 * 1024 * 1024;
            const stdoutTimer = setTimeout(() => {
                var _a;
                (_a = child.stdout) === null || _a === void 0 ? void 0 : _a.destroy();
            }, (timeout !== null && timeout !== void 0 ? timeout : 60) * 1000);
            stdoutTimer.unref();
            const stderrTimer = setTimeout(() => {
                var _a;
                (_a = child.stderr) === null || _a === void 0 ? void 0 : _a.destroy();
            }, (timeout !== null && timeout !== void 0 ? timeout : 60) * 1000);
            stderrTimer.unref();
            (_a = child.stdout) === null || _a === void 0 ? void 0 : _a.on('data', (d) => {
                if (stdout.length < MAX_OUTPUT) {
                    stdout += d.toString();
                    if (stdout.length > MAX_OUTPUT)
                        stdout = stdout.slice(0, MAX_OUTPUT);
                }
            });
            (_b = child.stderr) === null || _b === void 0 ? void 0 : _b.on('data', (d) => {
                if (stderr.length < MAX_OUTPUT) {
                    stderr += d.toString();
                    if (stderr.length > MAX_OUTPUT)
                        stderr = stderr.slice(0, MAX_OUTPUT);
                }
            });
            child.on('close', (exitCode) => {
                clearTimeout(stdoutTimer);
                clearTimeout(stderrTimer);
                resolve({
                    stdout,
                    stderr,
                    exitCode: exitCode !== null && exitCode !== void 0 ? exitCode : -1,
                    durationMs: Date.now() - start,
                    sandboxMechanism: 'seatbelt', // SSH inherits local sandbox; remote is unconfined
                });
            });
            child.on('error', (err) => {
                clearTimeout(stdoutTimer);
                clearTimeout(stderrTimer);
                resolve({
                    stdout,
                    stderr: stderr || err.message,
                    exitCode: -1,
                    durationMs: Date.now() - start,
                    sandboxMechanism: 'seatbelt',
                });
            });
        });
    }
}
exports.SSHBackend = SSHBackend;
// ============================================================================
// SSH Config Resolution
// ============================================================================
/**
 * Resolve SSH configuration from a combination of explicit args and environment.
 * Environment variables take precedence over defaults but explicit args win over env.
 *
 * Priority: explicit args > env vars > defaults
 */
/** Validate SSH host — must be a hostname or IP, no shell metacharacters. */
function isValidSshHost(host) {
    return /^[a-zA-Z0-9._-]+$/.test(host);
}
function resolveSSHConfig(args) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k;
    const host = String((_b = (_a = args.ssh_host) !== null && _a !== void 0 ? _a : process.env.COMMANDER_SSH_HOST) !== null && _b !== void 0 ? _b : '');
    if (!host)
        return null;
    // Security: reject hosts with shell metacharacters
    if (!isValidSshHost(host)) {
        return null;
    }
    const port = Number((_d = (_c = args.ssh_port) !== null && _c !== void 0 ? _c : process.env.COMMANDER_SSH_PORT) !== null && _d !== void 0 ? _d : 22);
    if (port < 1 || port > 65535 || !Number.isFinite(port))
        return null;
    return {
        host,
        port,
        user: String((_f = (_e = args.ssh_user) !== null && _e !== void 0 ? _e : process.env.COMMANDER_SSH_USER) !== null && _f !== void 0 ? _f : os.userInfo().username),
        identityFile: String((_h = (_g = args.ssh_key) !== null && _g !== void 0 ? _g : process.env.COMMANDER_SSH_KEY) !== null && _h !== void 0 ? _h : path.join(os.homedir(), '.ssh', 'id_rsa')),
        connectTimeoutMs: Number((_k = (_j = args.ssh_timeout) !== null && _j !== void 0 ? _j : process.env.COMMANDER_SSH_CONNECT_TIMEOUT) !== null && _k !== void 0 ? _k : 10000),
    };
}
