import * as fs from 'fs';
import * as path from 'path';
import type { Tool, ToolDefinition } from '../runtime/types';
import { getGlobalLogger } from '../logging';

const SAFE_ROOT = path.resolve(process.env.COMMANDER_WORKSPACE || process.cwd());

/** Check that a resolved path is within SAFE_ROOT (prevents prefix collision like workspace-evil). */
function isWithinRoot(resolved: string, root: string): boolean {
  return resolved === root || resolved.startsWith(root + path.sep);
}

function safePath(target: string): string {
  const resolved = path.resolve(SAFE_ROOT, target);
  if (!isWithinRoot(resolved, SAFE_ROOT)) {
    throw new Error(`Access denied: path "${target}" is outside workspace`);
  }
  // GAP-15: Resolve symlinks to prevent traversal bypass.
  // If the resolved realpath escapes SAFE_ROOT, deny access.
  try {
    const real = fs.realpathSync(resolved);
    if (!isWithinRoot(real, SAFE_ROOT)) {
      throw new Error(`Access denied: symlink "${target}" points outside workspace`);
    }
    return real;
  } catch (err: unknown) {
    if (err instanceof Error && 'code' in err && (err as { code: string }).code === 'ENOENT') {
      const parentDir = path.dirname(resolved);
      try {
        const realParent = fs.realpathSync(parentDir);
        if (!isWithinRoot(realParent, SAFE_ROOT)) {
          throw new Error(`Access denied: parent directory of "${target}" is outside workspace`);
        }
      } catch (e) {
        // Re-throw access denied errors — do NOT silently allow
        if (e instanceof Error && e.message.startsWith('Access denied')) throw e;
        getGlobalLogger().warn('FileSystemTool', 'Parent directory check failed', { error: (e as Error)?.message });
        throw new Error(`Access denied: cannot verify parent directory of "${target}"`);
      }
      return resolved;
    }
    throw err;
  }
}

export class FileReadTool implements Tool {
  definition: ToolDefinition = {
    name: 'file_read',
    description: 'Read the contents of a file. Supports text files, code, JSON, CSV, and markdown. Returns the file content.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file (relative to workspace)' },
        maxChars: { type: 'number', description: 'Maximum characters to return (default: 10000)', default: 10000 },
      },
      required: ['path'],
    },
    examples: [
      { name: 'file_read', arguments: { path: 'package.json' } },
      { name: 'file_read', arguments: { path: 'src/index.ts', maxChars: 5000 } },
    ],
    category: 'filesystem',
  };

  async execute(args: Record<string, unknown>): Promise<string> {
    const filePath = String(args.path ?? '');
    const maxChars = Math.min(Math.max(Number(args.maxChars) || 10000, 1), 100000);

    if (!filePath) return 'Error: path is required';

    try {
      const resolved = safePath(filePath);
      if (!fs.existsSync(resolved)) return `Error: file not found: ${filePath}`;

      const stat = fs.statSync(resolved);
      if (stat.size > 1024 * 1024) return `Error: file too large (${(stat.size / 1024 / 1024).toFixed(1)}MB). Max: 1MB`;

      const content = fs.readFileSync(resolved, 'utf-8');
      const lines = content.split('\n');
      const result = lines.map((line, i) => `${i + 1}: ${line}`).join('\n');

      if (result.length > maxChars) {
        return result.slice(0, maxChars) + `\n\n...[truncated ${result.length - maxChars} chars]`;
      }
      return result;
    } catch (err) {
      return `Error reading file: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}

export class FileWriteTool implements Tool {
  definition: ToolDefinition = {
    name: 'file_write',
    description: 'Write content to a file. Creates the file if it does not exist. Overwrites existing content.',
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
    if (content.length > 10 * 1024 * 1024) return `Error: content too large (${(content.length / 1024 / 1024).toFixed(1)}MB). Max: 10MB`;

    try {
      const resolved = safePath(filePath);
      const dir = path.dirname(resolved);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      // Atomic write: write to temp, then rename (prevents partial writes on crash)
      const tmpPath = resolved + `.tmp.${Date.now()}`;
      try {
        fs.writeFileSync(tmpPath, content, 'utf-8');
        fs.renameSync(tmpPath, resolved);
      } catch (e) {
        try { fs.unlinkSync(tmpPath); } catch { /* ignore cleanup error */ }
        throw e;
      }
      return `Written ${content.length} bytes to ${filePath}`;
    } catch (err) {
      return `Error writing file: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}

export class FileEditTool implements Tool {
  definition: ToolDefinition = {
    name: 'file_edit',
    description: 'Edit a file by replacing text. Uses exact string replacement. Returns the diff.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file (relative to workspace)' },
        oldString: { type: 'string', description: 'Text to replace (must exist in file)' },
        newString: { type: 'string', description: 'Replacement text' },
      },
      required: ['path', 'oldString', 'newString'],
    },
    examples: [
      { name: 'file_edit', arguments: { path: 'src/config.ts', oldString: 'port: 3000', newString: 'port: 8080' } },
      { name: 'file_edit', arguments: { path: 'README.md', oldString: '# Old Title', newString: '# New Title' } },
    ],
    category: 'filesystem',
  };

  async execute(args: Record<string, unknown>): Promise<string> {
    const filePath = String(args.path ?? '');
    const oldStr = String(args.oldString ?? '');
    const newStr = String(args.newString ?? '');

    if (!filePath || !oldStr) return 'Error: path and oldString are required';

    try {
      const resolved = safePath(filePath);
      if (!fs.existsSync(resolved)) return `Error: file not found: ${filePath}`;

      let content = fs.readFileSync(resolved, 'utf-8');
      const idx = content.indexOf(oldStr);
      if (idx === -1) return `Error: oldString not found in ${filePath}`;

      // Atomic edit: write to temp, then rename
      const occurrences = content.split(oldStr).length - 1;
      content = content.split(oldStr).join(newStr);
      const tmpPath = resolved + `.tmp.${Date.now()}`;
      try {
        fs.writeFileSync(tmpPath, content, 'utf-8');
        fs.renameSync(tmpPath, resolved);
      } catch (e) {
        try { fs.unlinkSync(tmpPath); } catch { /* ignore cleanup error */ }
        throw e;
      }
      return `Edited ${filePath}: replaced ${occurrences} occurrence(s) of "${oldStr.slice(0, 50)}..." with "${newStr.slice(0, 50)}..."`;
    } catch (err) {
      return `Error editing file: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}

export class FileSearchTool implements Tool {
  definition: ToolDefinition = {
    name: 'file_search',
    description: 'Search for files matching a pattern. Uses glob patterns. Returns matching file paths.',
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
      const files = this.globSearch(pattern, SAFE_ROOT).slice(0, maxResults);
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

    // CRITICAL FIX: enforce safePath on search directory to prevent path traversal
    // (e.g., pattern "../../etc/**/*.conf" would resolve outside workspace)
    let searchDir: string;
    if (dirPattern) {
      const candidate = path.resolve(root, dirPattern);
      if (!isWithinRoot(candidate, SAFE_ROOT)) return []; // silently reject out-of-workspace
      searchDir = candidate;
    } else {
      searchDir = root;
    }
    if (!fs.existsSync(searchDir)) return [];

    this.globRecurse(searchDir, root, filePattern, results);
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
          if (filePattern.startsWith('**')) {
            this.globRecurse(fullPath, root, filePattern, results);
          } else {
            const dirMatch = filePattern.includes('*') ? false : entry.name === filePattern;
            if (!dirMatch) this.globRecurse(fullPath, root, filePattern, results);
          }
        } else if (entry.isFile() && this.matchGlob(entry.name, filePattern.replace('**/', ''))) {
          results.push(relPath);
        }
      }
    } catch (e) { getGlobalLogger().warn('FileSystemTool', 'Directory scan failed', { error: (e as Error)?.message }); }
  }

  private matchGlob(name: string, pattern: string): boolean {
    // Escape regex metacharacters first, then convert glob wildcards
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp('^' + escaped.replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]') + '$');
    return regex.test(name);
  }
}

export class FileListTool implements Tool {
  definition: ToolDefinition = {
    name: 'file_list',
    description: 'List files and directories in a directory. Returns entries with type.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path (relative to workspace, default: ".")', default: '.' },
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
      return entries.map(e => `${e.isDirectory() ? '📁' : '📄'} ${e.name}${e.isDirectory() ? '/' : ''}`).join('\n');
    } catch (err) {
      return `Error listing directory: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}

/** Glob Tool — File pattern matching (from Claude Code). Finds files by name/path, not content. */
export class GlobTool implements Tool {
  definition: ToolDefinition = {
    name: 'glob',
    description: 'Find files matching a glob pattern. Searches by filename/path, not content. Use for: finding files by extension (**/*.ts), locating specific files (src/**/index.ts), discovering project structure. Use code_search to search inside files.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern (e.g., "**/*.ts", "src/**/*.{ts,tsx}", "package.json")' },
        path: { type: 'string', description: 'Directory to search in (default: workspace root)', default: '.' },
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
    // Normalize pattern: split into directory prefix and file pattern
    const parts = pattern.split('/');
    const filePattern = parts.pop() || '*';
    const dirPrefix = parts.join('/');

    let searchDir = rootDir;
    if (dirPrefix) {
      // Handle ** in directory prefix by starting from root
      if (dirPrefix === '**') {
        searchDir = rootDir;
      } else {
        const resolved = path.resolve(rootDir, dirPrefix);
        if (!isWithinRoot(resolved, SAFE_ROOT)) return [];
        searchDir = resolved;
      }
    }

    this.recurse(searchDir, rootDir, filePattern, dirPrefix === '**', results, maxResults);
    return results;
  }

  private recurse(dir: string, root: string, filePattern: string, deep: boolean, results: string[], limit: number): void {
    if (results.length >= limit) return;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (results.length >= limit) return;
        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          // Skip hidden dirs and common excluded dirs
          if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist') continue;
          // Always recurse if deep (**) or if directory name matches pattern
          if (deep || this.matchGlob(entry.name, filePattern)) {
            this.recurse(fullPath, root, filePattern, deep, results, limit);
          }
        } else if (entry.isFile()) {
          if (this.matchGlob(entry.name, filePattern)) {
            results.push(path.relative(root, fullPath));
          }
        }
      }
    } catch {
      // Skip unreadable directories
    }
  }

  private matchGlob(name: string, pattern: string): boolean {
    // Handle brace expansion: {ts,tsx} → (ts|tsx)
    const expanded = pattern.replace(/\{([^}]+)\}/g, (_, opts: string) =>
      `(${opts.split(',').map(o => o.trim()).join('|')})`
    );
    // Escape regex metacharacters, then convert glob wildcards
    const escaped = expanded.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    const regexStr = '^' + escaped
      .replace(/\*\*/g, '{{DOUBLESTAR}}')
      .replace(/\*/g, '[^/]*')
      .replace(/\?/g, '[^/]')
      .replace(/\{\{DOUBLESTAR\}\}/g, '.*')
      + '$';
    try {
      return new RegExp(regexStr).test(name);
    } catch {
      return false;
    }
  }
}
