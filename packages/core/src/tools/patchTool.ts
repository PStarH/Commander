import type { Tool, ToolDefinition } from '../runtime/types';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { execSandboxed } from './sandboxedExec';
import { getGlobalLogger } from '../logging';
import { safePath } from './fileSystemTool';

/** Reject paths containing shell metacharacters that could enable injection. */
const SHELL_UNSAFE_RE = /[;&|`$(){}[\]!#~<>*\n\t'"\\\x00-\x1f]/;

function assertShellSafePath(filePath: string, label: string): void {
  if (SHELL_UNSAFE_RE.test(filePath)) {
    throw new Error(`${label} contains shell-unsafe characters: ${filePath}`);
  }
}

const DEFINITION: ToolDefinition = {
  name: 'apply_patch',
  description:
    'Apply a unified diff patch to a file. The patch must be in standard unified diff format (diff -u old new). Validates the patch before applying and returns the result. Use this for surgical code modifications.',
  inputSchema: {
    type: 'object',
    properties: {
      patch: { type: 'string', description: 'The unified diff content to apply' },
      targetFile: {
        type: 'string',
        description: 'File to patch (if the diff does not include the file path)',
      },
      validate: { type: 'boolean', description: 'Run validation after applying (default: true)' },
      verifyCommand: {
        type: 'string',
        description: 'Command to run for verification (e.g., "npm test", "python -m pytest")',
      },
    },
    required: ['patch'],
  },
  examples: [
    {
      name: 'apply_patch',
      arguments: {
        patch: '--- a/src/file.ts\n+++ b/src/file.ts\n@@ -1,3 +1,4 @@\n-old line\n+new line',
        validate: true,
      },
    },
    { name: 'apply_patch', arguments: { patch: '...', verifyCommand: 'npm test' } },
  ],
  category: 'development',
};

export class ApplyPatchTool implements Tool {
  readonly definition = DEFINITION;
  isConcurrencySafe = false;
  isReadOnly = false;
  timeout = 120000;
  maxOutputSize = 50000;

  async execute(args: Record<string, unknown>): Promise<string> {
    const patchContent = String(args.patch ?? '');
    const targetFile = String(args.targetFile ?? '');
    const shouldValidate = args.validate !== false;
    const verifyCommand = String(args.verifyCommand ?? '');

    if (!patchContent) return 'Error: No patch content provided.';

    const cwd = process.cwd();
    const patchFile = path.join(cwd, `.tmp-patch-${Date.now()}.diff`);

    try {
      // Write patch to temp file
      fs.writeFileSync(patchFile, patchContent, 'utf-8');

      // Try to extract target file from patch header
      let fileToPatch = targetFile;
      if (!fileToPatch) {
        const headerMatch = patchContent.match(/^\+\+\+\s+(?:b\/)?(.+?)$/m);
        if (headerMatch) fileToPatch = headerMatch[1].trim();
      }

      if (!fileToPatch) {
        return 'Error: Could not determine target file from patch. Specify targetFile or include path in diff header (--- a/... / +++ b/...).';
      }

      let targetPath: string;
      try {
        targetPath = safePath(fileToPatch);
      } catch (err) {
        console.warn('[Catch]', err);
        return `Error: Target file "${fileToPatch}" is outside the workspace.`;
      }
      if (!fs.existsSync(targetPath)) {
        return `Error: Target file not found: ${fileToPatch}. Searched at: ${targetPath}`;
      }

      assertShellSafePath(targetPath, 'targetPath');
      assertShellSafePath(patchFile, 'patchFile');

      const patchArgsList = [
        ['--forward', '--unified', targetPath, '-i', patchFile],
        ['-p1', '--forward', '--unified', targetPath, '-i', patchFile],
        ['-p0', '--forward', '--unified', targetPath, '-i', patchFile],
      ];
      let patchApplied = false;
      for (const args of patchArgsList) {
        try {
          execFileSync('patch', args, {
            cwd,
            encoding: 'utf-8',
            timeout: 30000,
            stdio: ['pipe', 'pipe', 'pipe'],
          });
          patchApplied = true;
          break;
        } catch (err) {
          console.warn('[Catch]', err);
          /* try next variant */
        }
      }
      if (!patchApplied) {
        return `Error: Patch application failed. The patch format may be invalid or the file content has changed.\n\nPatch content:\n${patchContent.slice(0, 1000)}`;
      }

      const outputLines: string[] = [];
      outputLines.push(`Patch applied to: ${fileToPatch}`);

      // Validate if requested
      if (shouldValidate) {
        try {
          // Try TypeScript validation
          if (fileToPatch.endsWith('.ts')) {
            const tscResult = await execSandboxed('npx tsc --noEmit 2>&1 || true', 30, cwd);
            const tscOutput = tscResult.stdout || tscResult.stderr;
            // Split once and reuse
            const tscLines = tscOutput.split('\n');
            const errors = tscLines.filter((l) => l.includes('error TS')).length;
            if (errors > 0) {
              outputLines.push(`\n⚠️  TypeScript errors after patch: ${errors}`);
              outputLines.push(tscLines.slice(0, 10).join('\n'));
            } else {
              outputLines.push('\n✅ TypeScript validation: clean');
            }
          }

          // Run ESLint if available
          if (fs.existsSync(path.join(cwd, '.eslintrc'))) {
            const lintResult = await execSandboxed('npx eslint --quiet . 2>&1 || true', 30, cwd);
            const lintOutput = lintResult.stdout || lintResult.stderr;
            if (lintOutput.trim()) {
              outputLines.push(`\n⚠️  Lint issues found:\n${lintOutput.slice(0, 1000)}`);
            }
          }
        } catch (e) {
          getGlobalLogger().warn('ApplyPatchTool', 'Validation step failed', {
            error: (e as Error)?.message,
          });
        }
      }

      // Run verification command if provided
      if (verifyCommand) {
        outputLines.push(`\nRunning verification: ${verifyCommand}`);
        try {
          const verifyResult = await execSandboxed(verifyCommand, 60, cwd);
          if (verifyResult.exitCode === 0) {
            outputLines.push(`✅ Verification passed:\n${verifyResult.stdout.slice(0, 500)}`);
          } else {
            const stderr = verifyResult.stderr?.slice(0, 1000) || '';
            const stdout = verifyResult.stdout?.slice(0, 1000) || '';
            outputLines.push(
              `❌ Verification failed:\n${stderr || stdout || 'Exit code ' + verifyResult.exitCode}`,
            );
            // Auto-revert on failure
            try {
              const revertRes = await execSandboxed(`git checkout -- "${fileToPatch}"`, 10, cwd);
              if (revertRes.exitCode === 0) {
                outputLines.push('\n↩️  Patch reverted automatically.');
              } else {
                outputLines.push('\n⚠️  Could not auto-revert. Manual restore needed.');
                getGlobalLogger().warn('ApplyPatchTool', 'Auto-revert failed', {
                  stderr: revertRes.stderr,
                });
              }
            } catch (e) {
              outputLines.push('\n⚠️  Could not auto-revert. Manual restore needed.');
              getGlobalLogger().warn('ApplyPatchTool', 'Auto-revert exception', {
                error: (e as Error)?.message,
              });
            }
          }
        } catch (err: unknown) {
          outputLines.push(
            `❌ Verification error: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      return outputLines.join('\n');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return `Patch failed: ${msg.slice(0, 300)}`;
    } finally {
      try {
        fs.unlinkSync(patchFile);
      } catch (e) {
        getGlobalLogger().warn('ApplyPatchTool', 'Temp patch cleanup failed', {
          error: (e as Error)?.message,
        });
      }
    }
  }
}
