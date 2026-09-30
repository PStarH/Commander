import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Tool, ToolDefinition } from '../runtime/types';
import { getSafeRoot, isWithinRoot } from './fileSystemTool';

const EXCLUDE_DIRS = ['node_modules', '.git', 'dist', 'build', 'coverage', '.cache', 'target'];

/**
 * Resolve `target` to its real (symlink-free) path. When the target does not
 * exist, resolve the nearest existing ancestor and re-attach the non-existent
 * remainder — the same strategy `safePath()` uses.
 */
async function realPathOrAncestor(target: string): Promise<string> {
  let ancestor = target;
  for (;;) {
    try {
      const real = await fs.promises.realpath(ancestor);
      return ancestor === target ? real : path.join(real, path.relative(ancestor, target));
    } catch {
      const parent = path.dirname(ancestor);
      if (parent === ancestor) return target; // reached the filesystem root
      ancestor = parent;
    }
  }
}

const DEFINITION: ToolDefinition = {
  name: 'code_search',
  description:
    'Search code for patterns, symbols, or text like TODO/FIXME/HACK comments. Excludes node_modules, .git, dist, and build directories. Supports regex, file scoping, and symbol type filtering (functions, classes, interfaces).',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description:
          'The code or text pattern to search for (supports regex). Use for: TODO/FIXME/HACK comments, function names, variable names, error messages, or any code pattern.',
      },
      filePattern: {
        type: 'string',
        description:
          'File glob pattern (e.g., "src/**/*.ts", "*.py"). Defaults to common code file types (*.ts, *.js, *.py, *.rs, *.go).',
      },
      symbolType: {
        type: 'string',
        enum: ['function', 'class', 'interface', 'variable', 'import', 'all'],
        description:
          'Type of symbol to search for. Use "all" or leave empty for plain text/pattern search (e.g. TODO comments).',
      },
      maxResults: {
        type: 'number',
        description: 'Maximum number of results to return (default: 10)',
      },
      contextLines: {
        type: 'number',
        description: 'Lines of context around each match (default: 3)',
      },
      searchDomain: {
        type: 'string',
        enum: ['workspace', 'tests', 'docs', 'config'],
        description: 'Scope to narrow the search',
      },
    },
    required: ['pattern'],
  },
  examples: [
    { name: 'code_search', arguments: { pattern: 'TODO', filePattern: 'src/**/*.ts' } },
    { name: 'code_search', arguments: { pattern: 'class Repository', symbolType: 'class' } },
  ],
  category: 'development',
};

export class CodeSearchTool implements Tool {
  readonly definition = DEFINITION;
  isConcurrencySafe = true;
  isReadOnly = true;
  timeout = 30000;
  maxOutputSize = 50000;

  async execute(args: Record<string, unknown>): Promise<string> {
    const pattern = String(args.pattern ?? '');
    const filePattern = String(args.filePattern ?? '');
    const symbolType = String(args.symbolType ?? 'all');
    const maxResults = Number(args.maxResults ?? 10);
    const contextLines = Number(args.contextLines ?? 3);
    const searchDomain = String(args.searchDomain ?? 'workspace');

    if (!pattern) return 'Error: No search pattern provided.';
    if (pattern.length < 2) return 'Error: Search pattern too short (min 2 chars).';

    const cwd = getSafeRoot();
    let searchDir = cwd;
    if (searchDomain === 'tests') searchDir = `${cwd}/tests`;
    else if (searchDomain === 'docs') searchDir = `${cwd}/docs`;
    else if (searchDomain === 'config') searchDir = `${cwd}/config`;

    try {
      let grepPattern = pattern;
      if (symbolType === 'function') grepPattern = `(def |function |async function|fn )${pattern}`;
      else if (symbolType === 'class') grepPattern = `(class |interface )${pattern}`;
      else if (symbolType === 'import') grepPattern = `(import |from |require\\().*${pattern}`;

      const maxHead = maxResults * (contextLines * 2 + 2);

      // SECURITY: a purely lexical containment check is not enough. A symlink
      // that lives inside the workspace but points outside it resolves
      // lexically to a path under the root, and grep follows a symlink named on
      // the command line — so the boundary has to be verified against the REAL
      // path before grep runs. (safePath() does the same for the file tools.)
      const realRoot = await realPathOrAncestor(cwd);

      // The search root itself must be a real directory inside the workspace: a
      // `tests`/`docs`/`config` symlink pointing outside would otherwise be
      // followed by grep.
      const realSearchDir = await realPathOrAncestor(searchDir);
      if (!isWithinRoot(realSearchDir, realRoot)) {
        return `Error: Access denied: search domain "${searchDomain}" is outside workspace`;
      }

      // SECURITY FIX: use execFileSync with argv array instead of execSync with shell string
      // This prevents command injection via pattern/filePattern containing shell metacharacters
      const args: string[] = [
        '-rn',
        '--max-count=1',
        '-B',
        String(contextLines),
        '-A',
        String(contextLines),
        ...EXCLUDE_DIRS.flatMap((d) => ['--exclude-dir', d]),
      ];

      if (filePattern) {
        // filePattern is user-supplied. Absolute paths (and path escapes) must
        // stay inside the workspace — otherwise `grep -E pattern /etc/passwd`
        // reads host files even when cwd is the sandbox root.
        const lexicalTarget = path.isAbsolute(filePattern)
          ? path.resolve(filePattern)
          : path.resolve(searchDir, filePattern);
        if (!isWithinRoot(lexicalTarget, path.resolve(getSafeRoot()))) {
          return `Error: Access denied: filePattern "${filePattern}" is outside workspace`;
        }
        // Keep the search-domain scoping the tool always had.
        const relativeTarget = path.relative(searchDir, lexicalTarget) || '.';
        if (relativeTarget.startsWith('..') || path.isAbsolute(relativeTarget)) {
          return `Error: Access denied: filePattern "${filePattern}" is outside workspace`;
        }
        // Resolve symlinks and re-check: a symlink inside the workspace must not
        // be able to redirect grep past the boundary.
        const realTarget = await realPathOrAncestor(lexicalTarget);
        if (!isWithinRoot(realTarget, realRoot)) {
          return `Error: Access denied: filePattern "${filePattern}" is outside workspace`;
        }
        // Hand grep the canonical absolute path: it is already verified to be
        // inside the workspace, and an absolute path can never be mistaken for
        // a grep option.
        args.push('-E', grepPattern, realTarget);
      } else {
        args.push(
          '--include=*.ts',
          '--include=*.js',
          '--include=*.py',
          '--include=*.rs',
          '--include=*.go',
          '-E',
          grepPattern,
          realSearchDir,
        );
      }

      let stdout: string;
      try {
        stdout = execFileSync('grep', args, {
          cwd: realSearchDir,
          timeout: 30000,
          maxBuffer: 10 * 1024 * 1024,
          encoding: 'utf-8',
        });
      } catch (grepErr: unknown) {
        // grep exits 1 when no matches (not an error), 2 for actual errors
        const err = grepErr as {
          status?: number;
          stdout?: string;
          stderr?: string;
          message?: string;
        };
        if (err.status === 1) {
          // No matches found — return clean message regardless of stdout presence
          return `No results found for pattern: ${pattern}`;
        }
        throw grepErr;
      }

      const lines = stdout.trim().split('\n').filter(Boolean);
      if (lines.length === 0) return `No results found for pattern: ${pattern}`;

      const matchCount = lines.filter((l) => l.includes(grepPattern) || l.includes(pattern)).length;
      const sliced = lines.slice(0, maxHead).join('\n');
      return `Found ${matchCount} matches in ${lines.length} lines:\n\n${sliced}`;
    } catch (searchErr: unknown) {
      const msg = searchErr instanceof Error ? searchErr.message : String(searchErr);
      if (msg.includes('no results') || msg.toLowerCase().includes('no such file')) {
        return `No results found for pattern: ${pattern}`;
      }
      return `Search failed: ${msg.slice(0, 200)}`;
    }
  }
}
