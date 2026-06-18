"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LocalBackend = void 0;
const child_process_1 = require("child_process");
const manager_1 = require("../manager");
/** Shell metacharacters that enable command injection — blocks fallback execSync. */
const SHELL_UNSAFE_RE = /[;&|`$(){}[\]!#~<>*\n\t'"\\\x00-\x1f]/;
/**
 * Shell-aware split: splits on whitespace but preserves quoted substrings.
 * "C:\Program Files\node\node.exe" → ["C:\Program Files\node\node.exe"]
 * ls -la "/path/with spaces" → ["ls", "-la", "/path/with spaces"]
 */
function shellSplit(input) {
    const tokens = [];
    let current = '';
    let inQuote = null;
    for (const ch of input) {
        if (inQuote) {
            if (ch === inQuote) {
                inQuote = null;
                continue;
            }
            current += ch;
        }
        else if (ch === '"' || ch === "'") {
            inQuote = ch;
        }
        else if (/\s/.test(ch)) {
            if (current) {
                tokens.push(current);
                current = '';
            }
        }
        else {
            current += ch;
        }
    }
    if (current)
        tokens.push(current);
    return tokens;
}
/**
 * Local execution backend — runs commands through the OS sandbox (Seatbelt/Bwrap/Docker)
 * or falls back to direct execSync when sandbox is unavailable.
 */
class LocalBackend {
    constructor(config) {
        this.type = 'local';
        this.available = true;
        this.config = config !== null && config !== void 0 ? config : {};
    }
    async execute(command, workdir, timeout) {
        var _a, _b, _c, _d, _e;
        const start = Date.now();
        const sandbox = (0, manager_1.getSandboxManager)();
        if (sandbox.hasSandbox()) {
            const result = await sandbox.execute(command, 'workspace-write', workdir);
            return { ...result, durationMs: result.durationMs };
        }
        if (this.config.rejectOnNoSandbox) {
            return {
                stdout: '',
                stderr: `Rejected: no sandbox available and rejectOnNoSandbox is enabled`,
                exitCode: 1,
                durationMs: Date.now() - start,
                sandboxMechanism: 'none',
            };
        }
        if (SHELL_UNSAFE_RE.test(command)) {
            return {
                stdout: '',
                stderr: `Rejected: command contains shell-unsafe characters (no sandbox available)`,
                exitCode: 1,
                durationMs: Date.now() - start,
                sandboxMechanism: 'none',
            };
        }
        try {
            const parts = shellSplit(command.trim());
            const file = parts[0];
            const args = parts.slice(1);
            const stdout = (0, child_process_1.execFileSync)(file, args, {
                timeout: (timeout !== null && timeout !== void 0 ? timeout : 60) * 1000,
                encoding: 'utf-8',
                cwd: workdir !== null && workdir !== void 0 ? workdir : process.cwd(),
                maxBuffer: 10 * 1024 * 1024,
            });
            return {
                stdout: stdout !== null && stdout !== void 0 ? stdout : '',
                stderr: '',
                exitCode: 0,
                durationMs: Date.now() - start,
                sandboxMechanism: 'none',
            };
        }
        catch (err) {
            const e = err;
            return {
                stdout: (_b = (_a = e.stdout) === null || _a === void 0 ? void 0 : _a.toString()) !== null && _b !== void 0 ? _b : '',
                stderr: (_d = (_c = e.stderr) === null || _c === void 0 ? void 0 : _c.toString()) !== null && _d !== void 0 ? _d : '',
                exitCode: (_e = e.status) !== null && _e !== void 0 ? _e : 1,
                durationMs: Date.now() - start,
                sandboxMechanism: 'none',
            };
        }
    }
}
exports.LocalBackend = LocalBackend;
