import { reportSilentFailure } from '../silentFailureReporter';
import * as fs from 'fs';
import * as path from 'path';
import type { Tool, ToolDefinition } from '../runtime/types';
import { getGlobalLogger } from '../logging';
import { getSnapshotStore, computeFileHash } from '../edit/snapshotStore';
import {
  parseHashline,
  applyHashlineSection,
  isHashlineFormat,
  formatHashlineHeader,
  formatNumberedLines,
} from '../edit/hashline';
import { formatAnchoredOutput } from '../edit/hashAnchoredEditor';
import { getInternalUrlRouter, isInternalUrl } from '../runtime/internalUrls';
import { atomicWriteFile } from './_utils/atomicWrite';

/** Async path existence check compatible with Node 18+ types. */
async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.promises.access(p);
    return true;
  } catch (err) {
    reportSilentFailure(err, 'fileSystemTool:23');
    return false;
  }
}

/** Get the safe root directory. Dynamic to support runtime COMMANDER_WORKSPACE changes. */
export function getSafeRoot(): string {
  return path.resolve(process.env.COMMANDER_WORKSPACE || process.cwd());
}

/** Check that a resolved path is within SAFE_ROOT (prevents prefix collision like workspace-evil). */
export function isWithinRoot(resolved: string, root: string): boolean {
  return resolved === root || resolved.startsWith(root + path.sep);
}

/**
 * Resolve a user-provided path relative to the safe workspace root.
 * Rejects paths that resolve outside the workspace, including symlink-based traversal.
 * Re-exports for use by other tools (patchTool, multimodal tools).
 */
export function safePath(target: string): string {
  const resolved = path.resolve(getSafeRoot(), target);
  // Resolve symlinks for the resolved path (e.g., /tmp -> /private/tmp on macOS)
  let resolvedReal: string;
  try {
    resolvedReal = fs.realpathSync(resolved);
  } catch (err) {
    reportSilentFailure(err, 'fileSystemTool:50');
    // File doesn't exist yet — resolve the parent directory
    let parent = path.dirname(resolved);
    while (parent !== '/' && !fs.existsSync(parent)) {
      parent = path.dirname(parent);
    }
    try {
      resolvedReal = fs.realpathSync(parent) + resolved.slice(parent.length);
    } catch (err) {
      reportSilentFailure(err, 'fileSystemTool:59');
      resolvedReal = resolved;
    }
  }
  if (!isWithinRoot(resolvedReal, getSafeRoot())) {
    throw new Error(`Access denied: path "${target}" is outside workspace`);
  }
  // GAP-15: Resolve symlinks to prevent traversal bypass.
  try {
    const real = fs.realpathSync(resolved);
    if (!isWithinRoot(real, getSafeRoot())) {
      throw new Error(`Access denied: symlink "${target}" points outside workspace`);
    }
    return real;
  } catch (err: unknown) {
    if (err instanceof Error && 'code' in err && (err as { code: string }).code === 'ENOENT') {
      let ancestor = path.dirname(resolved);
      while (ancestor !== getSafeRoot() && !fs.existsSync(ancestor)) {
        ancestor = path.dirname(ancestor);
      }
      try {
        const realAncestor = fs.realpathSync(ancestor);
        if (!isWithinRoot(realAncestor, getSafeRoot())) {
          throw new Error(`Access denied: ancestor of "${target}" is outside workspace`);
        }
      } catch (e) {
        if (e instanceof Error && e.message.startsWith('Access denied')) throw e;
        if (!isWithinRoot(resolved, getSafeRoot()))
          throw new Error(`Access denied: path "${target}" is outside workspace`);
      }
      return resolved;
    }
    throw err;
  }
}

// ============================================================================
// FileReadTool — with hashline snapshot tracking
// ============================================================================

export class FileReadTool implements Tool {
  definition: ToolDefinition = {
    name: 'file_read',
    description:
      'Read a file. Returns content with line numbers in hashline format (¶path#HASH followed by LINE:content). Set includeHashes:true to get per-line content hashes (#XXXXXX) for drift-proof hash-anchored edits with file_hash_edit.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file (relative to workspace)' },
        maxChars: {
          type: 'number',
          description: 'Maximum characters to return (default: 10000)',
          default: 10000,
        },
        offset: { type: 'number', description: 'Start at this line number (1-indexed)' },
        limit: { type: 'number', description: 'Maximum number of lines to return' },
        includeHashes: {
          type: 'boolean',
          description:
            'Include per-line content hashes (#XXXXXX) for hash-anchored edits (default: false)',
          default: false,
        },
      },
      required: ['path'],
    },
    examples: [
      { name: 'file_read', arguments: { path: 'package.json' } },
      { name: 'file_read', arguments: { path: 'src/index.ts', offset: 10, limit: 30 } },
    ],
    category: 'filesystem',
  };

  async execute(args: Record<string, unknown>): Promise<string> {
    const filePath = String(args.path ?? '');
    const maxChars = Math.min(Math.max(Number(args.maxChars) || 10000, 1), 100000);
    const offset = Math.max(Number(args.offset) || 1, 1);
    const limit = args.limit ? Math.max(Number(args.limit), 1) : undefined;
    const includeHashes = args.includeHashes === true;

    if (!filePath) return 'Error: path is required';

    // ── Internal URL Protocol ──
    // Handle internal URLs like checkpoint://, memory://, skill://, agent://
    if (isInternalUrl(filePath)) {
      const router = getInternalUrlRouter();
      const result = await router.resolve(filePath);
      if (result) {
        const content = result.content;
        if (content.length > maxChars) {
          return (
            content.slice(0, maxChars) + `\n\n...[truncated ${content.length - maxChars} chars]`
          );
        }
        return content;
      }
      return `Error: Unknown internal URL protocol: ${filePath}`;
    }

    try {
      const resolved = safePath(filePath);
      if (!(await pathExists(resolved))) return `Error: file not found: ${filePath}`;

      const stat = await fs.promises.stat(resolved);
      if (stat.size > 1024 * 1024)
        return `Error: file too large (${(stat.size / 1024 / 1024).toFixed(1)}MB). Max: 1MB`;

      const content = await fs.promises.readFile(resolved, 'utf-8');

      // Record snapshot for hashline edit recovery
      const store = getSnapshotStore();
      store.record(resolved, content);

      // Compute hash
      const hash = computeFileHash(content);

      // Format with hashline header + line numbers
      const allLines = content.split('\n');
      const startIdx = offset - 1; // 0-indexed
      const endIdx = limit ? Math.min(startIdx + limit, allLines.length) : allLines.length;
      const displayLines = allLines.slice(startIdx, endIdx);

      // Format output: use anchored format if hashes requested, otherwise plain hashline
      if (includeHashes) {
        const result = formatAnchoredOutput(filePath, content, { offset, limit, maxChars });
        return result;
      }

      // Build header
      const header = formatHashlineHeader(filePath, hash);

      // Build numbered lines
      const numberedLines = displayLines.map((line, i) => `${startIdx + i + 1}:${line}`).join('\n');

      // Add truncation info
      let truncationInfo = '';
      if (startIdx > 0 || endIdx < allLines.length) {
        truncationInfo = `\n[Showing lines ${startIdx + 1}-${endIdx} of ${allLines.length}]`;
        if (endIdx < allLines.length) {
          truncationInfo += ` | Use offset=${endIdx + 1} for more`;
        }
      }

      const result = `${header}\n${numberedLines}${truncationInfo}`;

      if (result.length > maxChars) {
        return result.slice(0, maxChars) + `\n\n...[truncated ${result.length - maxChars} chars]`;
      }
      return result;
    } catch (err) {
      return `Error reading file: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}

// ============================================================================
// FileWriteTool — unchanged (creates new files, no hashline needed)
// ============================================================================

export class FileWriteTool implements Tool {
  definition: ToolDefinition = {
    name: 'file_write',
    description:
      'Write content to a file. Creates the file if it does not exist. Overwrites existing content.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file (relative to workspace)' },
        content: { type: 'string', description: 'Content to write' },
      },
      required: ['path', 'content'],
    },
    examples: [
      { name: 'file_write', arguments: { path: 'output.txt', content: 'Hello, world!' } },
      { name: 'file_write', arguments: { path: 'src/config.json', content: '{"debug": true}' } },
    ],
    category: 'filesystem',
  };

  async execute(args: Record<string, unknown>): Promise<string> {
    const filePath = String(args.path ?? '');
    const content = String(args.content ?? '');

    if (!filePath) return 'Error: path is required';
    if (content.length > 10 * 1024 * 1024)
      return `Error: content too large (${(content.length / 1024 / 1024).toFixed(1)}MB). Max: 10MB`;

    try {
      const resolved = safePath(filePath);
      const dir = path.dirname(resolved);
      if (!(await pathExists(dir))) await fs.promises.mkdir(dir, { recursive: true });

      await atomicWriteFile(resolved, content, { encoding: 'utf-8' });

      getSnapshotStore().record(resolved, content);

      return `Written ${content.length} bytes to ${filePath}`;
    } catch (err) {
      return `Error writing file: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}

// ============================================================================
// FileEditTool — supports both hashline and legacy string replacement
// ============================================================================

export class FileEditTool implements Tool {
  definition: ToolDefinition = {
    name: 'file_edit',
    description: `Edit a file. Supports two modes:

HASHLINE MODE (preferred): Use the hashline format from file_read output.
The input starts with ¶PATH#TAG (the tag from your read output), followed by operations:
  ¶src/foo.ts#A1B2
  replace 3..5:
  +new line 3
  +new line 4
  +new line 5

Operations: replace N..M:, delete N..M, insert before/after N:, insert head/tail:
Body rows start with + (only +TEXT, no -old lines).
The tag ensures the file hasn't changed since you read it.

LEGACY MODE (backward-compatible): Use path + oldString + newString for simple string replacement.`,
    inputSchema: {
      type: 'object',
      properties: {
        input: {
          type: 'string',
          description: 'Hashline-format edit (starts with ¶PATH#TAG). Preferred mode.',
        },
        path: {
          type: 'string',
          description: 'Path to the file (legacy mode, relative to workspace)',
        },
        oldString: {
          type: 'string',
          description: 'Text to replace (legacy mode, must exist in file)',
        },
        newString: { type: 'string', description: 'Replacement text (legacy mode)' },
      },
      required: [],
    },
    examples: [
      // Hashline example
      {
        name: 'file_edit',
        arguments: { input: '¶src/config.ts#A1B2\nreplace 3..3:\n+  port: 8080' },
      },
      // Legacy example
      {
        name: 'file_edit',
        arguments: { path: 'src/config.ts', oldString: 'port: 3000', newString: 'port: 8080' },
      },
    ],
    category: 'filesystem',
  };

  async execute(args: Record<string, unknown>): Promise<string> {
    const input = String(args.input ?? '');

    // Detect mode: hashline or legacy
    if (input && isHashlineFormat(input)) {
      return this.executeHashline(input);
    }

    // Legacy mode
    return this.executeLegacy(args);
  }

  /**
   * Hashline mode: parse and apply hashline edits.
   */
  private async executeHashline(input: string): Promise<string> {
    const parsed = parseHashline(input);

    if (parsed.errors.length > 0) {
      return `Hashline parse errors:\n${parsed.errors.join('\n')}`;
    }

    if (parsed.sections.length === 0) {
      return 'Error: No valid hashline sections found in input';
    }

    const results: string[] = [];

    for (const section of parsed.sections) {
      try {
        // Resolve file path
        const resolved = safePath(section.filePath);
        section.filePath = resolved;

        const result = applyHashlineSection(section);

        if (result.success) {
          let msg = `Updated ${section.filePath}`;
          if (result.replacements) msg += ` (${result.replacements} operation(s))`;
          if (result.newHash) msg += ` [hash: ${result.newHash}]`;
          if (result.warnings && result.warnings.length > 0) {
            msg += `\nWarnings:\n${result.warnings.join('\n')}`;
          }
          results.push(msg);
        } else {
          results.push(`Error editing ${section.filePath}: ${result.error}`);
        }
      } catch (err) {
        results.push(`Error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return results.join('\n');
  }

  /**
   * Legacy mode: exact string replacement (backward-compatible).
   */
  private async executeLegacy(args: Record<string, unknown>): Promise<string> {
    const filePath = String(args.path ?? '');
    const oldStr = String(args.oldString ?? '');
    const newStr = String(args.newString ?? '');

    if (!filePath || !oldStr)
      return 'Error: path and oldString are required (or use hashline mode with input)';

    try {
      const resolved = safePath(filePath);
      if (!(await pathExists(resolved))) return `Error: file not found: ${filePath}`;

      let content = await fs.promises.readFile(resolved, 'utf-8');
      const idx = content.indexOf(oldStr);
      if (idx === -1) return `Error: oldString not found in ${filePath}`;

      const occurrences = content.split(oldStr).length - 1;
      content = content.split(oldStr).join(newStr);
      await atomicWriteFile(resolved, content, { encoding: 'utf-8' });

      // Update snapshot
      getSnapshotStore().record(resolved, content);

      return `Edited ${filePath}: replaced ${occurrences} occurrence(s) of "${oldStr.slice(0, 50)}..." with "${newStr.slice(0, 50)}..."`;
    } catch (err) {
      return `Error editing file: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}

// ============================================================================
// FileSearchTool — unchanged
// ============================================================================

export class FileSearchTool implements Tool {
  definition: ToolDefinition = {
    name: 'file_search',
    description:
      'Search for files matching a pattern. Uses glob patterns. Returns matching file paths.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern (e.g. "**/*.ts", "src/**/*.js")' },
        maxResults: { type: 'number', description: 'Maximum results (default: 20)', default: 20 },
      },
      required: ['pattern'],
    },
    examples: [
      { name: 'file_search', arguments: { pattern: 'src/**/*.ts' } },
      { name: 'file_search', arguments: { pattern: '**/*.json', maxResults: 5 } },
    ],
    category: 'filesystem',
  };

  async execute(args: Record<string, unknown>): Promise<string> {
    const pattern = String(args.pattern ?? '');
    const maxResults = Math.min(Math.max(Number(args.maxResults) || 20, 1), 100);

    if (!pattern) return 'Error: pattern is required';

    try {
      const files = this.globSearch(pattern, getSafeRoot()).slice(0, maxResults);
      if (files.length === 0) return `No files matching "${pattern}"`;
      return files.map((f, i) => `[${i + 1}] ${f}`).join('\n');
    } catch (err) {
      return `Error searching files: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  private globSearch(pattern: string, root: string): string[] {
    const results: string[] = [];
    const parts = pattern.split('/');
    const filePattern = parts.pop() || '';
    const dirPattern = parts.join('/');

    let searchDir: string;
    let deep = false; // Whether to recurse into subdirectories
    if (dirPattern) {
      // Handle ** at the end of the directory pattern (e.g., "src/**" or "**")
      if (dirPattern.endsWith('/**') || dirPattern === '**') {
        const baseDir = dirPattern === '**' ? '' : dirPattern.replace('/**', '');
        searchDir = baseDir ? path.resolve(root, baseDir) : root;
        deep = true;
      } else {
        searchDir = path.resolve(root, dirPattern);
      }
      if (!isWithinRoot(searchDir, getSafeRoot())) return [];
    } else {
      searchDir = root;
    }
    if (!fs.existsSync(searchDir)) return [];

    if (deep) {
      this.globRecurseDeep(searchDir, root, filePattern, results);
    } else {
      this.globRecurse(searchDir, root, filePattern, results);
    }
    return results;
  }

  private globRecurse(dir: string, root: string, filePattern: string, results: string[]) {
    if (!fs.existsSync(dir)) return;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        const relPath = path.relative(root, fullPath);

        if (entry.isDirectory()) {
          // For simple patterns like *.ts, do not recurse — * should not match /
        } else if (entry.isFile() && this.matchGlob(entry.name, filePattern)) {
          results.push(relPath);
        }
      }
    } catch (e) {
      getGlobalLogger().warn('FileSystemTool', 'Directory scan failed', {
        error: (e as Error)?.message,
      });
    }
  }

  /** Recursive version used when the pattern contains ** — recurses into all subdirectories */
  private globRecurseDeep(dir: string, root: string, filePattern: string, results: string[]) {
    if (!fs.existsSync(dir)) return;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        const relPath = path.relative(root, fullPath);

        if (entry.isDirectory()) {
          if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
          this.globRecurseDeep(fullPath, root, filePattern, results);
        } else if (entry.isFile() && this.matchGlob(entry.name, filePattern)) {
          results.push(relPath);
        }
      }
    } catch (e) {
      getGlobalLogger().warn('FileSystemTool', 'Directory scan failed', {
        error: (e as Error)?.message,
      });
    }
  }

  private matchGlob(name: string, pattern: string): boolean {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp('^' + escaped.replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]') + '$');
    return regex.test(name);
  }
}

// ============================================================================
// FileListTool — unchanged
// ============================================================================

export class FileListTool implements Tool {
  definition: ToolDefinition = {
    name: 'file_list',
    description: 'List files and directories in a directory. Returns entries with type.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Directory path (relative to workspace, default: ".")',
          default: '.',
        },
      },
    },
    examples: [
      { name: 'file_list', arguments: { path: '.' } },
      { name: 'file_list', arguments: { path: 'src' } },
    ],
    category: 'filesystem',
  };

  async execute(args: Record<string, unknown>): Promise<string> {
    const dirPath = String(args.path ?? '.');

    try {
      const resolved = safePath(dirPath);
      if (!fs.existsSync(resolved)) return `Error: directory not found: ${dirPath}`;

      const entries = fs.readdirSync(resolved, { withFileTypes: true });
      return entries
        .map((e) => `${e.isDirectory() ? '📁' : '📄'} ${e.name}${e.isDirectory() ? '/' : ''}`)
        .join('\n');
    } catch (err) {
      return `Error listing directory: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}

// ============================================================================
// GlobTool — unchanged
// ============================================================================

export class GlobTool implements Tool {
  definition: ToolDefinition = {
    name: 'glob',
    description:
      'Find files matching a glob pattern. Searches by filename/path, not content. Use for: finding files by extension (**/*.ts), locating specific files (src/**/index.ts), discovering project structure. Use code_search to search inside files.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'Glob pattern (e.g., "**/*.ts", "src/**/*.{ts,tsx}", "package.json")',
        },
        path: {
          type: 'string',
          description: 'Directory to search in (default: workspace root)',
          default: '.',
        },
        maxResults: { type: 'number', description: 'Maximum results (default: 50)', default: 50 },
      },
      required: ['pattern'],
    },
    examples: [
      { name: 'glob', arguments: { pattern: '**/*.ts' } },
      { name: 'glob', arguments: { pattern: 'src/**/*.{ts,tsx}', maxResults: 20 } },
    ],
    category: 'filesystem',
  };

  async execute(args: Record<string, unknown>): Promise<string> {
    const pattern = String(args.pattern ?? '');
    const searchPath = String(args.path ?? '.');
    const maxResults = Math.min(Math.max(Number(args.maxResults) || 50, 1), 200);

    if (!pattern) return 'Error: pattern is required';

    try {
      const rootDir = safePath(searchPath);
      if (!fs.existsSync(rootDir)) return `Error: directory not found: ${searchPath}`;

      const files = this.globFind(rootDir, pattern, maxResults);
      if (files.length === 0) return `No files matching "${pattern}" in ${searchPath}`;

      const truncated = files.length >= maxResults ? `\n... (showing first ${maxResults})` : '';
      return `Found ${files.length} file(s):\n${files.join('\n')}${truncated}`;
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  private globFind(rootDir: string, pattern: string, maxResults: number): string[] {
    const results: string[] = [];
    const parts = pattern.split('/');
    const filePattern = parts.pop() || '*';
    const dirPrefix = parts.join('/');

    let searchDir = rootDir;
    if (dirPrefix) {
      if (dirPrefix === '**') {
        searchDir = rootDir;
      } else {
        const resolved = path.resolve(rootDir, dirPrefix);
        if (!isWithinRoot(resolved, getSafeRoot())) return [];
        searchDir = resolved;
      }
    }

    this.recurse(searchDir, rootDir, filePattern, dirPrefix === '**', results, maxResults);
    return results;
  }

  private recurse(
    dir: string,
    root: string,
    filePattern: string,
    deep: boolean,
    results: string[],
    limit: number,
  ): void {
    if (results.length >= limit) return;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (results.length >= limit) return;
        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist')
            continue;
          if (deep || this.matchGlob(entry.name, filePattern)) {
            this.recurse(fullPath, root, filePattern, deep, results, limit);
          }
        } else if (entry.isFile()) {
          if (this.matchGlob(entry.name, filePattern)) {
            results.push(path.relative(root, fullPath));
          }
        }
      }
    } catch (err) {
      reportSilentFailure(err, 'fileSystemTool:670');
      // Skip unreadable directories
    }
  }

  private matchGlob(name: string, pattern: string): boolean {
    const expanded = pattern.replace(
      /\{([^}]+)\}/g,
      (_, opts: string) =>
        `(${opts
          .split(',')
          .map((o) => o.trim())
          .join('|')})`,
    );
    const escaped = expanded.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    const regexStr =
      '^' +
      escaped
        .replace(/\*\*/g, '{{DOUBLESTAR}}')
        .replace(/\*/g, '[^/]*')
        .replace(/\?/g, '[^/]')
        .replace(/\{\{DOUBLESTAR\}\}/g, '.*') +
      '$';
    try {
      return new RegExp(regexStr).test(name);
    } catch (err) {
      reportSilentFailure(err, 'fileSystemTool:696');
      return false;
    }
  }
}
