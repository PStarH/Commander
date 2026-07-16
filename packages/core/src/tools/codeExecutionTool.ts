import { reportSilentFailure } from '../silentFailureReporter';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Tool, ToolDefinition } from '../runtime/types';
import { execSandboxed } from './sandboxedExec';
import { getGlobalLogger } from '../logging';
import { safePath } from './fileSystemTool';

const TEMP_DIR = path.join(process.cwd(), '.commander_exec');

async function ensureTempDir(): Promise<void> {
  await fs.promises.mkdir(TEMP_DIR, { recursive: true });
}

function formatExecResult(r: {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  killed: boolean;
}): string {
  // FIX: check killed FIRST — killed processes often have stderr and non-zero exit
  // Also preserve stdout/stderr collected before the kill (partial output is better than none)
  if (r.killed) {
    const parts = [`[Exit: SIGTERM | timeout exceeded after ${r.durationMs}ms]`];
    if (r.stdout) parts.push(`STDOUT:\n${r.stdout}`);
    if (r.stderr) parts.push(`STDERR:\n${r.stderr}`);
    return parts.join('\n');
  }
  if (r.exitCode === 0) {
    return `[Exit: 0 | ${r.durationMs}ms]\n${r.stdout}`.trim();
  }
  // FIX: include both stdout AND stderr on non-zero exit (was losing stdout)
  const parts = [`[Exit: ${r.exitCode} | ${r.durationMs}ms]`];
  if (r.stdout) parts.push(`STDOUT:\n${r.stdout}`);
  if (r.stderr) parts.push(`STDERR:\n${r.stderr}`);
  return parts.join('\n');
}

export class PythonExecuteTool implements Tool {
  definition: ToolDefinition = {
    name: 'python_execute',
    description:
      'Execute Python code in a sandboxed environment. Returns stdout, stderr, and execution time. Use for calculations, data analysis, and scripting.',
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

  async execute(args: Record<string, unknown>): Promise<string> {
    const code = String(args.code ?? '');
    const timeout = Math.min(Number(args.timeout ?? 30), 120);

    if (!code) return 'Error: code is required';

    await ensureTempDir();
    const filePath = path.join(TEMP_DIR, `exec_${randomUUID()}.py`);

    try {
      await fs.promises.writeFile(filePath, code, 'utf-8');
      return formatExecResult(
        await execSandboxed(`python3 "${filePath}"`, timeout, undefined, args),
      );
    } finally {
      try {
        await fs.promises.unlink(filePath);
      } catch (e) {
        getGlobalLogger().warn('PythonExecuteTool', 'Temp file cleanup failed', {
          error: (e as Error)?.message,
        });
      }
    }
  }
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
const INTERCEPTED_PATTERNS: Array<{
  pattern: RegExp;
  tool: string;
  reason: string;
  /** If true, only intercept when the target tool is available */
  requiresTool?: boolean;
}> = [
  // File reads → file_read
  {
    pattern: /\b(cat|less|more|head|tail)\s+/,
    tool: 'file_read',
    reason:
      'Use file_read instead — it returns hashline-anchored output for direct use with file_edit',
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
    reason:
      'Use code_search instead — it returns hashline-anchored results for direct use with file_edit',
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
function interceptBashCommand(command: string, availableTools?: Set<string>): string | null {
  // Only intercept the FIRST meaningful command (handle pipes and chains)
  const firstCmd = command.trim().split(/[;&|]/)[0]?.trim() ?? '';

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

export class ShellExecuteTool implements Tool {
  definition: ToolDefinition = {
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

  async execute(args: Record<string, unknown>): Promise<string> {
    const command = String(args.command ?? '');
    const timeout = Math.min(Number(args.timeout ?? 30), 120);
    const workdir = String(args.workdir ?? '.');

    if (!command) return 'Error: command is required';

    // ── Bash Interception: redirect to specialized tools ──
    // Only intercept when the target tool is actually available
    const availableTools = args._availableTools as Set<string> | undefined;
    const interceptResult = interceptBashCommand(command, availableTools);
    if (interceptResult) return interceptResult;

    let resolvedWorkdir: string;
    try {
      resolvedWorkdir = await safePath(workdir);
    } catch (err) {
      reportSilentFailure(err, 'codeExecutionTool:254');
      return `Error: Access denied: workdir "${workdir}" is outside workspace`;
    }
    // Pass full args as backendArgs so the router can pick the right backend
    return formatExecResult(await execSandboxed(command, timeout, resolvedWorkdir, args));
  }
}
