import * as fs from 'fs';
import * as path from 'path';
import type { Tool, ToolDefinition } from '../runtime/types';

const SAFE_ROOT = process.env.COMMANDER_WORKSPACE || process.cwd();

function safePath(target: string): string {
  const resolved = path.resolve(SAFE_ROOT, target);
  if (!resolved.startsWith(SAFE_ROOT)) {
    throw new Error(`Access denied: path "${target}" is outside workspace`);
  }
  return resolved;
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
  };

  async execute(args: Record<string, unknown>): Promise<string> {
    const filePath = String(args.path ?? '');
    const maxChars = Math.min(Number(args.maxChars ?? 10000), 100000);

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
  };

  async execute(args: Record<string, unknown>): Promise<string> {
    const filePath = String(args.path ?? '');
    const content = String(args.content ?? '');

    if (!filePath) return 'Error: path is required';

    try {
      const resolved = safePath(filePath);
      const dir = path.dirname(resolved);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      fs.writeFileSync(resolved, content, 'utf-8');
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

      content = content.replace(oldStr, newStr);
      fs.writeFileSync(resolved, content, 'utf-8');
      return `Edited ${filePath}: replaced "${oldStr.slice(0, 50)}..." with "${newStr.slice(0, 50)}..."`;
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
  };

  async execute(args: Record<string, unknown>): Promise<string> {
    const pattern = String(args.pattern ?? '');
    const maxResults = Math.min(Number(args.maxResults ?? 20), 100);

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

    const searchDir = dirPattern ? path.resolve(root, dirPattern) : root;
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
    } catch { }
  }

  private matchGlob(name: string, pattern: string): boolean {
    const regex = new RegExp('^' + pattern.replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
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
