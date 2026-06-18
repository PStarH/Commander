"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DockerExecBackend = void 0;
exports.resolveDockerExecConfig = resolveDockerExecConfig;
const child_process_1 = require("child_process");
const child_process_2 = require("child_process");
/** Validate Docker container name/ID — must be alphanumeric with limited special chars. */
function isValidContainerName(name) {
    // Docker container names: alphanumeric, hyphens, underscores, dots, slashes (for namespaced)
    // Docker container IDs: hex characters (12-64 chars)
    return /^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,127}$/.test(name);
}
/**
 * Docker exec backend — executes commands inside running Docker containers
 * using the `docker exec` CLI. Supports user, workdir, and full environment control.
 */
class DockerExecBackend {
    constructor(config) {
        this.type = 'docker_exec';
        this.config = config;
        this._available = false;
        try {
            (0, child_process_2.execSync)('docker info 2>/dev/null', { timeout: 5000 });
            this._available = true;
        }
        catch {
            this._available = false;
        }
    }
    get available() {
        return this._available;
    }
    async execute(command, workdir, timeout) {
        const start = Date.now();
        const args = ['exec', '-i'];
        // Attach env from current process (filtered — exclude secrets)
        const SECRET_PATTERNS = [
            'KEY',
            'SECRET',
            'TOKEN',
            'PASSWORD',
            'CREDENTIAL',
            'AUTH',
            'PRIVATE',
            'SIGNATURE',
        ];
        const BLOCKED_PREFIXES = [
            'DOCKER_',
            'SSH_',
            'AWS_',
            'GCP_',
            'AZURE_',
            'GCLOUD_',
            'KUBE_',
            'NPM_',
            'NODE_',
        ];
        for (const [k, v] of Object.entries(process.env)) {
            if (!v)
                continue;
            const upper = k.toUpperCase();
            // Block known sensitive prefixes
            if (BLOCKED_PREFIXES.some((p) => upper.startsWith(p)))
                continue;
            // Block any key containing secret patterns
            if (SECRET_PATTERNS.some((p) => upper.includes(p)))
                continue;
            args.push('-e', `${k}=${v}`);
        }
        if (this.config.user) {
            args.push('-u', this.config.user);
        }
        const wd = workdir !== null && workdir !== void 0 ? workdir : this.config.workdir;
        if (wd) {
            args.push('-w', wd);
        }
        args.push(this.config.container, '/bin/sh', '-c', command);
        return new Promise((resolve) => {
            var _a, _b;
            const child = (0, child_process_1.spawn)('docker', args, {
                stdio: ['pipe', 'pipe', 'pipe'],
                timeout: (timeout !== null && timeout !== void 0 ? timeout : 60) * 1000,
            });
            let stdout = '';
            let stderr = '';
            const MAX_OUTPUT = 10 * 1024 * 1024;
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
                resolve({
                    stdout,
                    stderr,
                    exitCode: exitCode !== null && exitCode !== void 0 ? exitCode : -1,
                    durationMs: Date.now() - start,
                    sandboxMechanism: 'docker',
                });
            });
            child.on('error', (err) => {
                resolve({
                    stdout,
                    stderr: stderr || err.message,
                    exitCode: -1,
                    durationMs: Date.now() - start,
                    sandboxMechanism: 'docker',
                });
            });
        });
    }
}
exports.DockerExecBackend = DockerExecBackend;
// ============================================================================
// Docker Exec Config Resolution
// ============================================================================
/**
 * Resolve Docker exec configuration from tool arguments and environment.
 *
 * Priority: explicit args > env vars
 */
function resolveDockerExecConfig(args) {
    var _a, _b, _c, _d, _e, _f, _g;
    const container = String((_c = (_b = (_a = args.container) !== null && _a !== void 0 ? _a : args.container_id) !== null && _b !== void 0 ? _b : process.env.COMMANDER_DOCKER_CONTAINER) !== null && _c !== void 0 ? _c : '');
    if (!container)
        return null;
    // Security: reject container names with shell metacharacters
    if (!isValidContainerName(container)) {
        return null;
    }
    return {
        container,
        workdir: String((_e = (_d = args.workdir) !== null && _d !== void 0 ? _d : process.env.COMMANDER_DOCKER_WORKDIR) !== null && _e !== void 0 ? _e : ''),
        user: String((_g = (_f = args.docker_user) !== null && _f !== void 0 ? _f : process.env.COMMANDER_DOCKER_USER) !== null && _g !== void 0 ? _g : ''),
    };
}
