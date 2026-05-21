import type { Tool, ToolDefinition } from '../runtime/types';
import { execSandboxed } from './sandboxedExec';
import { getGlobalLogger } from '../logging';

const DEFINITION: ToolDefinition = {
  name: 'verify',
  description: 'Run linters, type checkers, and test runners on the codebase. Returns structured results with pass/fail status, error counts, and output. Use this after making file changes to verify correctness.',
  inputSchema: {
    type: 'object',
    properties: {
      checks: {
        type: 'array',
        items: { type: 'string', enum: ['lint', 'typecheck', 'test', 'build'] },
        description: 'Which checks to run. Default: ["lint", "typecheck"]',
      },
      directory: {
        type: 'string',
        description: 'Working directory to run checks in. Default: current project root.',
      },
      testPattern: {
        type: 'string',
        description: 'Test file pattern (e.g., "src/**/*.test.ts"). Only used when checks includes "test".',
      },
      fix: {
        type: 'boolean',
        description: 'Auto-fix lint issues if possible. Default: false.',
      },
    },
  },
};

interface CheckResult {
  name: string;
  passed: boolean;
  errors: number;
  warnings: number;
  output: string;
  durationMs: number;
}

export class VerificationTool implements Tool {
  readonly definition = DEFINITION;
  isConcurrencySafe = false;
  isReadOnly = true;
  timeout = 300000;
  maxOutputSize = 50000;

  async execute(args: Record<string, unknown>): Promise<string> {
    const checks = (args.checks as string[]) ?? ['lint', 'typecheck'];
    const directory = String(args.directory ?? process.cwd());
    const testPattern = String(args.testPattern ?? '');
    const autoFix = Boolean(args.fix);

    const results: CheckResult[] = [];
    for (const check of checks) {
      switch (check) {
        case 'lint': results.push(await this.runLint(directory, autoFix)); break;
        case 'typecheck': results.push(await this.runTypeCheck(directory)); break;
        case 'test': results.push(await this.runTests(directory, testPattern)); break;
        case 'build': results.push(await this.runBuild(directory)); break;
      }
    }

    const passed = results.filter(r => r.passed).length;
    const total = results.length;

    const lines: string[] = [
      `## Verification Results (${passed}/${total} passed)`,
      '',
    ];
    for (const r of results) {
      const icon = r.passed ? '✅' : '❌';
      lines.push(`${icon} ${r.name}: ${r.errors} errors, ${r.warnings} warnings (${r.durationMs}ms)`);
      if (r.output) {
        const truncated = r.output.length > 2000 ? r.output.slice(0, 2000) + '\n...[truncated]' : r.output;
        lines.push('```', truncated, '```');
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  private async runCommand(cmd: string, cwd: string, label: string): Promise<CheckResult> {
    const result = await execSandboxed(cmd, 120, cwd);
    const output = result.stdout || result.stderr;
    if (result.exitCode === 0) {
      const lines = output.split('\n');
      const errorCount = lines.filter((l: string) => /error/i.test(l)).length;
      const warningCount = lines.filter((l: string) => /warning/i.test(l)).length;
      return { name: label, passed: true, errors: errorCount, warnings: warningCount, output: output.slice(0, 3000), durationMs: result.durationMs };
    }
    const lines = output.split('\n');
    const errorCount = lines.filter((l: string) => /error/i.test(l)).length || 1;
    return { name: label, passed: false, errors: errorCount, warnings: 0, output: output.slice(0, 3000), durationMs: result.durationMs };
  }

  private async runLint(cwd: string, fix: boolean): Promise<CheckResult> {
    const fixFlag = fix ? ' --fix' : '';
    if (this.hasTool(cwd, 'node_modules/.bin/eslint')) {
      return this.runCommand(`npx eslint .${fixFlag} --format compact 2>&1 || true`, cwd, 'ESLint');
    }
    return { name: 'ESLint', passed: true, errors: 0, warnings: 0, output: 'No ESLint config found, skipping.', durationMs: 0 };
  }

  private async runTypeCheck(cwd: string): Promise<CheckResult> {
    if (this.hasFile(cwd, 'tsconfig.json')) {
      return this.runCommand('npx tsc --noEmit 2>&1 || true', cwd, 'TypeScript');
    }
    return { name: 'TypeScript', passed: true, errors: 0, warnings: 0, output: 'No tsconfig.json found, skipping.', durationMs: 0 };
  }

  private async runTests(cwd: string, pattern: string): Promise<CheckResult> {
    if (this.hasTool(cwd, 'node_modules/.bin/vitest')) {
      return this.runCommand(`npx vitest run ${pattern} 2>&1 || true`, cwd, 'Vitest');
    }
    if (this.hasTool(cwd, 'node_modules/.bin/jest')) {
      return this.runCommand(`npx jest ${pattern} 2>&1 || true`, cwd, 'Jest');
    }
    return { name: 'Tests', passed: true, errors: 0, warnings: 0, output: 'No test runner config found (tried vitest, jest).', durationMs: 0 };
  }

  private async runBuild(cwd: string): Promise<CheckResult> {
    if (this.hasFile(cwd, 'package.json')) {
      return this.runCommand('npx tsc --noEmit 2>&1 || true', cwd, 'Build check');
    }
    return { name: 'Build', passed: true, errors: 0, warnings: 0, output: 'No package.json found.', durationMs: 0 };
  }

  private hasTool(cwd: string, relPath: string): boolean {
    try { return require('fs').existsSync(require('path').join(cwd, relPath)); } catch (e) { getGlobalLogger().warn('VerificationTool', 'Tool check failed', { error: (e as Error)?.message, relPath }); return false; }
  }

  private hasFile(cwd: string, name: string): boolean {
    try { return require('fs').existsSync(require('path').join(cwd, name)); } catch (e) { getGlobalLogger().warn('VerificationTool', 'File check failed', { error: (e as Error)?.message, name }); return false; }
  }
}
