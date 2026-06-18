"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.execSandboxed = execSandboxed;
const executionRouter_1 = require("../sandbox/executionRouter");
function formatResult(r) {
    var _a, _b;
    return {
        stdout: (_a = r.stdout) !== null && _a !== void 0 ? _a : '',
        stderr: (_b = r.stderr) !== null && _b !== void 0 ? _b : '',
        exitCode: r.exitCode,
        durationMs: r.durationMs,
        killed: false,
    };
}
/**
 * Execute a command through the ExecutionRouter.
 * The router picks the right backend (local/ssh/docker_exec) based on args.
 *
 * @param command  Shell command to execute
 * @param timeoutSec  Timeout in seconds
 * @param workdir  Working directory
 * @param backendArgs  Tool call arguments for backend selection (backend, ssh_host, container, etc.)
 */
async function execSandboxed(command, timeoutSec, workdir, backendArgs) {
    const router = (0, executionRouter_1.getExecutionRouter)();
    const args = { timeout: timeoutSec, ...backendArgs };
    const result = await router.execute(command, args, workdir);
    return formatResult(result);
}
