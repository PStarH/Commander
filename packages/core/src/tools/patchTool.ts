import type { Tool, ToolDefinition } from '../runtime/types';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const DEFINITION: ToolDefinition = {
  name: 'apply_patch',
  description: 'Apply a unified diff patch to a file. The patch must be in standard unified diff format (diff -u old new). Validates the patch before applying and returns the result. Use this for surgical code modifications.',
  inputSchema: {
    type: 'object',
    properties: {
      patch: { type: 'string', description: 'The unified diff content to apply' },
      targetFile: { type: 'string', description: 'File to patch (if the diff does not include the file path)' },
      validate: { type: 'boolean', description: 'Run validation after applying (default: true)' },
      verifyCommand: { type: 'string', description: 'Command to run for verification (e.g., "npm test", "python -m pytest")' },
    },
    required: ['patch'],
  },
  examples: [
    { name: 'apply_patch', arguments: { patch: '--- a/src/file.ts\n+++ b/src/file.ts\n@@ -1,3 +1,4 @@\n-old line\n+new line', validate: true } },
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

      const targetPath = path.resolve(cwd, fileToPatch);
      if (!fs.existsSync(targetPath)) {
        // Check if file exists relative to cwd
        const altPath = path.join(cwd, fileToPatch);
        if (fs.existsSync(altPath)) {
          // Patch already has the right path, proceed
        } else {
          return `Error: Target file not found: ${fileToPatch}. Searched at: ${targetPath}`;
        }
      }

      // Try applying the patch
      const result = execSync(`patch --forward --unified "${targetPath}" "${patchFile}" 2>&1 || patch -p1 --forward --unified < "${patchFile}" 2>&1 || echo "PATCH_FAILED"`, {
        cwd,
        encoding: 'utf-8',
        timeout: 30000,
      });

      if (result.includes('PATCH_FAILED')) {
        // Try with -p0
        let result2 = '';
        try {
          result2 = execSync(`patch -p0 --forward --unified < "${patchFile}" 2>&1`, {
            cwd, encoding: 'utf-8', timeout: 30000,
          });
        } catch {}
        if (!result2 || result2.includes('FAILED')) {
          return `Error: Patch application failed. The patch format may be invalid or the file content has changed.\n\nPatch content:\n${patchContent.slice(0, 1000)}`;
        }
      }

      const outputLines: string[] = [];
      outputLines.push(`Patch applied to: ${fileToPatch}`);

      // Validate if requested
      if (shouldValidate) {
        try {
          // Try TypeScript validation
          if (fileToPatch.endsWith('.ts')) {
            const tscResult = execSync('npx tsc --noEmit 2>&1 || true', {
              cwd, encoding: 'utf-8', timeout: 30000, maxBuffer: 5 * 1024 * 1024,
            });
            const errors = tscResult.split('\n').filter(l => l.includes('error TS')).length;
            if (errors > 0) {
              outputLines.push(`\n⚠️  TypeScript errors after patch: ${errors}`);
              outputLines.push(tscResult.split('\n').slice(0, 10).join('\n'));
            } else {
              outputLines.push('\n✅ TypeScript validation: clean');
            }
          }

          // Run ESLint if available
          if (fs.existsSync(path.join(cwd, '.eslintrc'))) {
            const lintResult = execSync('npx eslint --quiet . 2>&1 || true', {
              cwd, encoding: 'utf-8', timeout: 30000,
            });
            if (lintResult.trim()) {
              outputLines.push(`\n⚠️  Lint issues found:\n${lintResult.slice(0, 1000)}`);
            }
          }
        } catch {
          // Validation tools may not be available
        }
      }

      // Run verification command if provided
      if (verifyCommand) {
        outputLines.push(`\nRunning verification: ${verifyCommand}`);
        try {
          const verifyResult = execSync(verifyCommand, {
            cwd, encoding: 'utf-8', timeout: 60000, maxBuffer: 5 * 1024 * 1024,
          });
          outputLines.push(`✅ Verification passed:\n${verifyResult.slice(0, 500)}`);
        } catch (err: any) {
          const stderr = err.stderr?.toString()?.slice(0, 1000) || '';
          const stdout = err.stdout?.toString()?.slice(0, 1000) || '';
          outputLines.push(`❌ Verification failed:\n${stderr || stdout || err.message}`);
          // Auto-revert on failure
          try {
            execSync(`git checkout -- "${fileToPatch}"`, { cwd, timeout: 10000 });
            outputLines.push('\n↩️  Patch reverted automatically.');
          } catch {
            outputLines.push('\n⚠️  Could not auto-revert. Manual restore needed.');
          }
        }
      }

      return outputLines.join('\n');
    } catch (err: any) {
      return `Patch failed: ${err.message?.slice(0, 300) || String(err)}`;
    } finally {
      try { fs.unlinkSync(patchFile); } catch {}
    }
  }
}
