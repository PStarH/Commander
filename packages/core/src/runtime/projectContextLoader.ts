/**
 * Project Context Loader
 *
 * Loads project-specific instructions from well-known markdown files and
 * injects them into the stable system prompt. This is the Commander
 * equivalent of Claude Code's CLAUDE.md / Codex CLI's AGENTS.md mechanism.
 *
 * Supported files (highest precedence last):
 *   1. PROJECT.md  — project overview, conventions, standards
 *   2. CLAUDE.md   — Claude-style project context
 *   3. AGENTS.md   — agent-specific instructions (most specific)
 *
 * Higher-precedence files appear later in the injected block so their
 * instructions have stronger recency in the model's attention.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

/** Max size per file in bytes. Prevents one giant file from eating the context window. */
const MAX_FILE_BYTES = 50_000;

/** Well-known project context files in ascending precedence. */
const CONTEXT_FILENAMES = ['PROJECT.md', 'CLAUDE.md', 'AGENTS.md'] as const;

export interface ProjectContext {
  /** Absolute paths of files that were read, in precedence order. */
  filesRead: string[];
  /** Combined markdown content of all read files. */
  content: string;
  /** Cache key derived from file mtimes. Changes when any file changes. */
  cacheKey: string;
}

interface FileSnapshot {
  filePath: string;
  mtimeMs: number;
  content: string;
}

/**
 * Load project context from the given directory.
 *
 * @param projectPath Directory to scan. Defaults to process.cwd() for CLI usage.
 * @returns ProjectContext. If no files exist, content is empty and cacheKey is stable.
 */
export function loadProjectContext(projectPath: string = process.cwd()): ProjectContext {
  const snapshots: FileSnapshot[] = [];

  for (const filename of CONTEXT_FILENAMES) {
    const filePath = path.resolve(projectPath, filename);
    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) continue;

      const content = readFileWithCap(filePath);
      if (content.trim().length === 0) continue;

      snapshots.push({ filePath, mtimeMs: stat.mtimeMs, content });
    } catch (err) {
      // File does not exist or is unreadable — skip silently.
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'EACCES' && code !== 'EPERM') {
        // Best-effort warning for unexpected errors; do not fail the run.
        // eslint-disable-next-line no-console
        console.warn(
          `[projectContextLoader] Could not read ${filePath}: ${(err as Error).message}`,
        );
      }
    }
  }

  const filesRead = snapshots.map((s) => s.filePath);
  const content =
    snapshots.length > 0
      ? snapshots.map((s) => `<!-- ${path.basename(s.filePath)} -->\n${s.content}`).join('\n\n')
      : '';
  const cacheKey = computeCacheKey(snapshots);

  return { filesRead, content, cacheKey };
}

/**
 * Build the `<project_context>` block for injection into the system prompt.
 * Returns an empty string if no project context files were found.
 */
export function buildProjectContextBlock(ctx: ProjectContext): string {
  if (!ctx.content || ctx.filesRead.length === 0) return '';

  return [
    '<project_context>',
    '## Project Context',
    `The following instructions come from: ${ctx.filesRead.map((p) => path.basename(p)).join(', ')}`,
    '',
    ctx.content,
    '</project_context>',
  ].join('\n');
}

/**
 * Compute a deterministic cache key from file snapshots.
 * Key changes when any file is added, removed, or modified.
 */
export function computeProjectContextCacheKey(snapshots: FileSnapshot[]): string {
  return computeCacheKey(snapshots);
}

// ── internal helpers ──

function readFileWithCap(filePath: string): string {
  const fd = fs.openSync(filePath, 'r');
  try {
    const stat = fs.fstatSync(fd);
    const toRead = Math.min(stat.size, MAX_FILE_BYTES);
    const buffer = Buffer.alloc(toRead);
    const bytesRead = fs.readSync(fd, buffer, 0, toRead, 0);
    let raw = buffer.toString('utf8', 0, bytesRead);

    // If we truncated the file, drop the last potentially incomplete UTF-8 sequence
    // and any trailing partial line to avoid exposing a cut-off sentence.
    if (stat.size > MAX_FILE_BYTES) {
      raw = raw.replace(/[\uD800-\uDBFF]$/, '');
      const lastBreak = Math.max(raw.lastIndexOf('\n'), raw.lastIndexOf('\r'));
      if (lastBreak > 0) {
        raw = raw.slice(0, lastBreak);
      }
    }

    return raw;
  } finally {
    fs.closeSync(fd);
  }
}

function computeCacheKey(snapshots: FileSnapshot[]): string {
  const hash = crypto.createHash('sha256');
  for (const s of snapshots) {
    hash.update(path.basename(s.filePath));
    hash.update(String(s.mtimeMs));
  }
  // Include an explicit "no files" marker so empty contexts are also stable.
  if (snapshots.length === 0) {
    hash.update('__no_project_context__');
  }
  return hash.digest('hex');
}
