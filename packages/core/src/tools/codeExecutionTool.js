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
exports.ShellExecuteTool = exports.PythonExecuteTool = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const crypto_1 = require("crypto");
const sandboxedExec_1 = require("./sandboxedExec");
const logging_1 = require("../logging");
const fileSystemTool_1 = require("./fileSystemTool");
const TEMP_DIR = path.join(process.cwd(), '.commander_exec');
async function ensureTempDir() {
    await fs.promises.mkdir(TEMP_DIR, { recursive: true });
}
function formatExecResult(r) {
    // FIX: check killed FIRST — killed processes often have stderr and non-zero exit
    // Also preserve stdout/stderr collected before the kill (partial output is better than none)
    if (r.killed) {
        const parts = [`[Exit: SIGTERM | timeout exceeded after ${r.durationMs}ms]`];
        if (r.stdout)
            parts.push(`STDOUT:\n${r.stdout}`);
        if (r.stderr)
            parts.push(`STDERR:\n${r.stderr}`);
        return parts.join('\n');
    }
    if (r.exitCode === 0) {
        return `[Exit: 0 | ${r.durationMs}ms]\n${r.stdout}`.trim();
    }
    // FIX: include both stdout AND stderr on non-zero exit (was losing stdout)
    const parts = [`[Exit: ${r.exitCode} | ${r.durationMs}ms]`];
    if (r.stdout)
        parts.push(`STDOUT:\n${r.stdout}`);
    if (r.stderr)
        parts.push(`STDERR:\n${r.stderr}`);
    return parts.join('\n');
}
class PythonExecuteTool {
    constructor() {
        this.definition = {
            name: 'python_execute',
            description: 'Execute Python code in a sandboxed environment. Returns stdout, stderr, and execution time. Use for calculations, data analysis, and scripting.',
            inputSchema: {
                type: 'object',
                properties: {
                    code: { type: 'string', description: 'Python code to execute' },
                    timeout: { type: 'number', description: 'Timeout in seconds (default: 30)', default: 30 },
                },
                required: ['code'],
            },
            examples: [
                { name: 'python_execute', arguments: { code: 'print(sum(range(100)))' } },
                {
                    name: 'python_execute',
                    arguments: { code: 'import json; print(json.dumps({"key": "value"}))', timeout: 10 },
                },
            ],
            category: 'code',
        };
    }
    async execute(args) {
        var _a, _b;
        const code = String((_a = args.code) !== null && _a !== void 0 ? _a : '');
        const timeout = Math.min(Number((_b = args.timeout) !== null && _b !== void 0 ? _b : 30), 120);
        if (!code)
            return 'Error: code is required';
        await ensureTempDir();
        const filePath = path.join(TEMP_DIR, `exec_${(0, crypto_1.randomUUID)()}.py`);
        try {
            await fs.promises.writeFile(filePath, code, 'utf-8');
            return formatExecResult(await (0, sandboxedExec_1.execSandboxed)(`python3 "${filePath}"`, timeout));
        }
        finally {
            try {
                await fs.promises.unlink(filePath);
            }
            catch (e) {
                (0, logging_1.getGlobalLogger)().warn('PythonExecuteTool', 'Temp file cleanup failed', {
                    error: e === null || e === void 0 ? void 0 : e.message,
                });
            }
        }
    }
}
exports.PythonExecuteTool = PythonExecuteTool;
/**
 * Build a user-facing description of the available backends based on environment.
 * This is shown in the tool definition so the LLM knows what's available.
 */
function buildBackendDescriptions() {
    const parts = [];
    parts.push('local — run on the local machine through sandbox (default)');
    if (process.env.COMMANDER_SSH_HOST)
        parts.push('ssh — run on a remote host (configured via env, or override with ssh_host/ssh_user/ssh_key args)');
    if (process.env.COMMANDER_DOCKER_CONTAINER)
        parts.push('docker — run inside a running Docker container (container configured via env, or override with container/container_id args)');
    if (parts.length === 1)
        parts.push('ssh — run on a remote host (set ssh_host argument)');
    if (parts.length <= 2)
        parts.push('docker — run inside a running container (set container argument)');
    return parts.join('; ');
}
// ============================================================================
// Bash Interception — Tool Priority Enforcement
//
// Inspired by oh-my-pi's approach: specialized tools are ALWAYS better than
// shell equivalents. When the model tries to use bash for operations that
// have dedicated tools, we intercept and redirect.
//
// This saves tokens (specialized tools produce cleaner output), improves
// reliability (dedicated tools have better error handling), and enables
// hashline integration (search results with anchors for direct edit use).
// ============================================================================
/** Patterns that should be redirected to specialized tools */
const INTERCEPTED_PATTERNS = [
    // File reads → file_read
    {
        pattern: /\b(cat|less|more|head|tail)\s+/,
        tool: 'file_read',
        reason: 'Use file_read instead — it returns hashline-anchored output for direct use with file_edit',
    },
    {
        pattern: /\bsed\s+-n\s+/,
        tool: 'file_read',
        reason: 'Use file_read with offset/limit instead of sed -n',
    },
    // Search → code_search (only when code_search is available)
    {
        pattern: /\bgrep\b/,
        tool: 'code_search',
        reason: 'Use code_search instead — it returns hashline-anchored results for direct use with file_edit',
        requiresTool: true,
    },
    {
        pattern: /\brg\b/,
        tool: 'code_search',
        reason: 'Use code_search instead — it returns hashline-anchored results',
        requiresTool: true,
    },
    { pattern: /\bag\b/, tool: 'code_search', reason: 'Use code_search instead', requiresTool: true },
    // Find → file_search / glob (only when glob is available)
    {
        pattern: /\bfind\s+.*-name\b/,
        tool: 'glob',
        reason: 'Use glob or file_search instead of find',
        requiresTool: true,
    },
    { pattern: /\bfd\b/, tool: 'glob', reason: 'Use glob instead of fd', requiresTool: true },
    // Edit → file_edit
    {
        pattern: /\bsed\s+-i\b/,
        tool: 'file_edit',
        reason: 'Use file_edit with hashline format instead of sed -i',
    },
    { pattern: /\bawk\s+-i\b/, tool: 'file_edit', reason: 'Use file_edit instead of awk -i' },
    // Write → file_write
    { pattern: /\btee\s+/, tool: 'file_write', reason: 'Use file_write instead of tee' },
];
/**
 * Check if a shell command should be intercepted.
 * Returns null if the command is allowed, or an error message with guidance.
 *
 * @param command - The shell command to check
 * @param availableTools - Set of available tool names (if provided, only intercept when target tool is available)
 */
function interceptBashCommand(command, availableTools) {
    var _a, _b;
    // Only intercept the FIRST meaningful command (handle pipes and chains)
    const firstCmd = (_b = (_a = command.trim().split(/[;&|]/)[0]) === null || _a === void 0 ? void 0 : _a.trim()) !== null && _b !== void 0 ? _b : '';
    for (const { pattern, tool, reason, requiresTool } of INTERCEPTED_PATTERNS) {
        if (pattern.test(firstCmd)) {
            // If requiresTool is set, only intercept when the target tool is available
            if (requiresTool && availableTools && !availableTools.has(tool)) {
                continue; // Target tool not available, allow the command
            }
            return `TOOL_PRIORITY: This command is intercepted. ${reason}\n\nCommand blocked: "${firstCmd.slice(0, 80)}"\nUse the \`${tool}\` tool instead.`;
        }
    }
    return null;
}
class ShellExecuteTool {
    constructor() {
        this.definition = {
            name: 'shell_execute',
            description: `Execute a shell command in a sandboxed environment. Returns stdout, stderr, and exit code.

ALLOWED: git operations, npm/pip commands, build scripts, system tasks, compilation.
BLOCKED: cat, head, tail, grep, rg, find, fd, sed -i, awk -i, tee — these are intercepted and redirected to specialized tools (file_read, code_search, glob, file_edit, file_write).

Using specialized tools is REQUIRED because they return hashline-anchored output for direct use with file_edit.`,
            inputSchema: {
                type: 'object',
                properties: {
                    command: { type: 'string', description: 'Shell command to execute' },
                    timeout: {
                        type: 'number',
                        description: 'Timeout in seconds (default: 30, max: 120)',
                        default: 30,
                    },
                    workdir: {
                        type: 'string',
                        description: 'Working directory relative to workspace (default: ".")',
                        default: '.',
                    },
                    backend: {
                        type: 'string',
                        enum: ['local', 'ssh', 'docker'],
                        description: `Execution backend (default: local). SSH/Docker configured via env vars: COMMANDER_SSH_HOST, COMMANDER_DOCKER_CONTAINER`,
                        default: 'local',
                    },
                },
                required: ['command'],
            },
            examples: [
                { name: 'shell_execute', arguments: { command: 'ls -la' } },
                { name: 'shell_execute', arguments: { command: 'npm test', timeout: 60 } },
            ],
            category: 'code',
        };
    }
    async execute(args) {
        var _a, _b, _c;
        const command = String((_a = args.command) !== null && _a !== void 0 ? _a : '');
        const timeout = Math.min(Number((_b = args.timeout) !== null && _b !== void 0 ? _b : 30), 120);
        const workdir = String((_c = args.workdir) !== null && _c !== void 0 ? _c : '.');
        if (!command)
            return 'Error: command is required';
        // ── Bash Interception: redirect to specialized tools ──
        // Only intercept when the target tool is actually available
        const availableTools = args._availableTools;
        const interceptResult = interceptBashCommand(command, availableTools);
        if (interceptResult)
            return interceptResult;
        let resolvedWorkdir;
        try {
            resolvedWorkdir = (0, fileSystemTool_1.safePath)(workdir);
        }
        catch {
            return `Error: Access denied: workdir "${workdir}" is outside workspace`;
        }
        // Pass full args as backendArgs so the router can pick the right backend
        return formatExecResult(await (0, sandboxedExec_1.execSandboxed)(command, timeout, resolvedWorkdir, args));
    }
}
exports.ShellExecuteTool = ShellExecuteTool;
