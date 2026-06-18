"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ExecutionRouter = void 0;
exports.getExecutionRouter = getExecutionRouter;
exports.resetExecutionRouter = resetExecutionRouter;
const localBackend_1 = require("./backends/localBackend");
const sshBackend_1 = require("./backends/sshBackend");
const dockerExecBackend_1 = require("./backends/dockerExecBackend");
const lane_1 = require("./lane");
const logging_1 = require("../logging");
const pluginManager_1 = require("../pluginManager");
/**
 * ExecutionRouter — manages a set of execution backends and routes
 * shell/code execution tool calls to the appropriate backend.
 *
 * Supports three backend types:
 *   - local: runs through the OS sandbox (Seatbelt/Bwrap/Docker) or fallback execSync
 *   - ssh:  runs on a remote host via the `ssh` CLI
 *   - docker_exec: runs inside a running Docker container via `docker exec`
 *
 * Backend selection is driven by tool call arguments:
 *   - backend="ssh"    + ssh_host, ssh_user, ssh_key, etc.
 *   - backend="docker"  + container/container_id, docker_user, etc.
 *   - backend="local"   (default, no extra config needed)
 */
class ExecutionRouter {
    constructor() {
        this.backends = new Map();
        this.localBackend = new localBackend_1.LocalBackend({ rejectOnNoSandbox: true });
    }
    /**
     * Register a named backend (e.g., "prod-server", "db-container").
     * Named backends persist and can be referenced by name in tool calls.
     */
    registerBackend(name, backend) {
        this.backends.set(name, backend);
        (0, logging_1.getGlobalLogger)().info('ExecutionRouter', `Registered backend "${name}" (${backend.type})`);
    }
    /**
     * Get a registered backend by name.
     */
    getBackend(name) {
        return this.backends.get(name);
    }
    /**
     * List all registered backends.
     */
    listBackends() {
        const result = [];
        for (const [name, backend] of this.backends) {
            result.push({ name, type: backend.type, available: backend.available });
        }
        return result;
    }
    /**
     * Select the appropriate backend for a tool call based on arguments.
     *
     * Selection logic:
     *   1. If `backend_name` is provided and matches a registered backend → use it
     *   2. If `backend` arg is "ssh"  or has ssh_host → create ephemeral SSHBackend
     *   3. If `backend` arg is "docker" or has container/container_id → create ephemeral DockerExecBackend
     *   4. Default → LocalBackend
     */
    async selectBackend(args) {
        var _a, _b, _c, _d, _e, _f, _g, _h;
        const toolName = String((_a = args._toolName) !== null && _a !== void 0 ? _a : 'shell_execute');
        // ── Hook: beforeBackendSelect (can override by returning a registered backend name) ──
        try {
            const hookOverride = await (0, pluginManager_1.getHookManager)().fireBeforeBackendSelect({
                toolName,
                args,
                agentId: String((_b = args._agentId) !== null && _b !== void 0 ? _b : ''),
                runId: String((_c = args._runId) !== null && _c !== void 0 ? _c : ''),
            });
            if (hookOverride && this.backends.has(hookOverride)) {
                return this.backends.get(hookOverride);
            }
        }
        catch {
            (0, logging_1.getGlobalLogger)().debug('ExecutionRouter', 'beforeBackendSelect hook failed');
        }
        // Named backend takes priority
        const backendName = String((_d = args.backend_name) !== null && _d !== void 0 ? _d : '');
        if (backendName && this.backends.has(backendName)) {
            return this.backends.get(backendName);
        }
        // Lane-pinned backend: if the resolved execution lane has a pinned backend, use it
        const laneBackend = (0, lane_1.getLaneManager)().getLaneBackend({
            tenantId: String((_e = args._tenantId) !== null && _e !== void 0 ? _e : ''),
            agentId: String((_f = args._agentId) !== null && _f !== void 0 ? _f : ''),
            runId: String((_g = args._runId) !== null && _g !== void 0 ? _g : ''),
            toolName,
            args,
        });
        if (laneBackend && this.backends.has(laneBackend)) {
            return this.backends.get(laneBackend);
        }
        const backendType = String((_h = args.backend) !== null && _h !== void 0 ? _h : '').toLowerCase();
        // SSH backend
        if (backendType === 'ssh' || args.ssh_host) {
            const sshConfig = (0, sshBackend_1.resolveSSHConfig)(args);
            if (sshConfig) {
                return new sshBackend_1.SSHBackend(sshConfig);
            }
        }
        // Docker exec backend
        if (backendType === 'docker' || args.container || args.container_id) {
            const dockerConfig = (0, dockerExecBackend_1.resolveDockerExecConfig)(args);
            if (dockerConfig) {
                return new dockerExecBackend_1.DockerExecBackend(dockerConfig);
            }
        }
        // Default: local
        return this.localBackend;
    }
    /**
     * Execute a command through the appropriate backend.
     * This is a convenience wrapper around selectBackend + execute.
     */
    async execute(command, args, workdir) {
        var _a;
        const backend = await this.selectBackend(args);
        const timeout = Number((_a = args.timeout) !== null && _a !== void 0 ? _a : 60);
        return backend.execute(command, workdir, timeout);
    }
}
exports.ExecutionRouter = ExecutionRouter;
const tenantAwareSingleton_1 = require("../runtime/tenantAwareSingleton");
const executionRouterSingleton = (0, tenantAwareSingleton_1.createTenantAwareSingleton)(() => new ExecutionRouter());
function getExecutionRouter() {
    return executionRouterSingleton.get();
}
function resetExecutionRouter() {
    executionRouterSingleton.reset();
}
