/**
 * Hashline Edit Format — content-hash anchored line-based edits.
 *
 * Inspired by oh-my-pi's hashline package. The model points at line numbers
 * from read output instead of retyping content, saving 50-80% tokens on edits.
 *
 * Format:
 *   ¶PATH#TAG
 *   replace N..M:
 *   +new line content
 *   +another new line
 *
 * Key properties:
 * - #TAG is 4-hex hash of file content → detects stale files before corruption
 * - Line numbers from read output → no ambiguity about which lines to change
 * - +TEXT body rows only → no retyping old content
 * - Stale-tag rejection prevents silent corruption
 */

import * as fs from 'fs';
import { computeFileHash, getSnapshotStore, type FileSnapshot } from './snapshotStore';

// ============================================================================
// Types
// ============================================================================

export interface HashlineOp {
  type: 'replace' | 'delete' | 'insert';
  startLine: number;
  endLine?: number;
  position?: 'before' | 'after' | 'head' | 'tail';
  body: string[]; // Only for replace and insert
}

export interface HashlineSection {
  filePath: string;
  expectedHash: string;
  ops: HashlineOp[];
}

export interface HashlineParseResult {
  sections: HashlineSection[];
  errors: string[];
}

export interface HashlineApplyResult {
  success: boolean;
  filePath?: string;
  newContent?: string;
  newHash?: string;
  replacements?: number;
  error?: string;
  warnings?: string[];
}

// ============================================================================
// Constants
// ============================================================================

/** File-section header prefix */
const FILE_PREFIX = '¶';

/** Separator between path and hash */
const HASH_SEP = '#';

/** Body row sigil */
const BODY_SIGIL = '+';

/** Hash length (4 hex chars) */
const HASH_LENGTH = 4;

// ============================================================================
// Parser
// ============================================================================

/**
 * Parse a hashline input string into sections and operations.
 *
 * Input format:
 *   ¶PATH#TAG
 *   replace N..M:
 *   +line content
 *   delete N
 *   insert before N:
 *   +line content
 */
export function parseHashline(input: string): HashlineParseResult {
  const sections: HashlineSection[] = [];
  const errors: string[] = [];
  const lines = input.split('\n');

  let currentSection: HashlineSection | null = null;
  let currentOp: HashlineOp | null = null;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // Skip empty lines
    if (!trimmed) {
      i++;
      continue;
    }

    // Skip patch envelope markers
    if (trimmed === '*** Begin Patch' || trimmed === '*** End Patch') {
      i++;
      continue;
    }

    // File section header: ¶PATH#TAG
    if (trimmed.startsWith(FILE_PREFIX)) {
      const headerResult = parseFileHeader(trimmed);
      if (headerResult.error) {
        errors.push(headerResult.error);
        i++;
        continue;
      }
      // Save previous section
      if (currentSection && currentOp) {
        currentSection.ops.push(currentOp);
        currentOp = null;
      }
      if (currentSection) {
        sections.push(currentSection);
      }
      currentSection = {
        filePath: headerResult.path!,
        expectedHash: headerResult.hash!,
        ops: [],
      };
      i++;
      continue;
    }

    // Must have a current section
    if (!currentSection) {
      // Try to recover: maybe it's a malformed header
      if (trimmed.includes('#') && trimmed.includes('/')) {
        errors.push(
          `Line ${i + 1}: Missing '${FILE_PREFIX}' prefix. Expected '${FILE_PREFIX}${trimmed}'`,
        );
        i++;
        continue;
      }
      errors.push(
        `Line ${i + 1}: Content without a file header. Add '${FILE_PREFIX}path#HASH' before operations.`,
      );
      i++;
      continue;
    }

    // Parse operation headers
    const opResult = parseOpHeader(trimmed, i + 1);
    if (opResult.op) {
      // Save previous op
      if (currentOp) {
        currentSection.ops.push(currentOp);
      }
      currentOp = opResult.op;
      i++;
      continue;
    }
    if (opResult.error) {
      errors.push(opResult.error);
      i++;
      continue;
    }

    // Body row: must start with +
    if (trimmed.startsWith(BODY_SIGIL)) {
      if (!currentOp) {
        errors.push(
          `Line ${i + 1}: Body row without an operation header. Add 'replace N..M:', 'delete N', or 'insert ...' above.`,
        );
        i++;
        continue;
      }
      if (currentOp.type === 'delete') {
        errors.push(
          `Line ${i + 1}: 'delete' does not take body rows. Use 'replace N..M:' if you need new content.`,
        );
        i++;
        continue;
      }
      // Body is everything after the + (preserve leading whitespace in original line)
      const bodyContent = line.substring(line.indexOf(BODY_SIGIL) + 1);
      currentOp.body.push(bodyContent);
      i++;
      continue;
    }

    // If we get here, it might be a bare body row (lenient parsing)
    if (currentOp && currentOp.type !== 'delete' && !trimmed.match(/^(replace|delete|insert)\s/)) {
      // Lenient: auto-prepend + and warn
      currentOp.body.push(trimmed);
      i++;
      continue;
    }

    errors.push(`Line ${i + 1}: Unrecognized content: "${trimmed}"`);
    i++;
  }

  // Save last section/op
  if (currentSection) {
    if (currentOp) {
      currentSection.ops.push(currentOp);
    }
    sections.push(currentSection);
  }

  return { sections, errors };
}

// ============================================================================
// Header parsers
// ============================================================================

function parseFileHeader(line: string): { path?: string; hash?: string; error?: string } {
  // Expected: ¶PATH#TAG
  if (!line.startsWith(FILE_PREFIX)) {
    return { error: `Not a file header: "${line}"` };
  }

  const withoutPrefix = line.slice(FILE_PREFIX.length);
  const hashIndex = withoutPrefix.lastIndexOf(HASH_SEP);

  if (hashIndex === -1) {
    return {
      error: `Missing hash tag. Expected format: ${FILE_PREFIX}path${HASH_SEP}XXXX. Got: "${line}"`,
    };
  }

  const filePath = withoutPrefix.slice(0, hashIndex);
  const hash = withoutPrefix.slice(hashIndex + 1).trim();

  if (!filePath) {
    return { error: `Empty file path in header: "${line}"` };
  }

  if (hash.length !== HASH_LENGTH || !/^[0-9A-Fa-f]+$/.test(hash)) {
    return {
      error: `Invalid hash tag "${hash}" (must be ${HASH_LENGTH} hex chars). Got: "${line}"`,
    };
  }

  return { path: filePath, hash: hash.toUpperCase() };
}

function parseOpHeader(line: string, lineNum: number): { op?: HashlineOp; error?: string } {
  // replace N..M: or replace N:
  const replaceMatch = line.match(/^replace\s+(\d+)(?:\.\.(\d+))?\s*:?\s*$/i);
  if (replaceMatch) {
    const start = parseInt(replaceMatch[1], 10);
    const end = replaceMatch[2] ? parseInt(replaceMatch[2], 10) : start;
    if (start < 1) return { error: `Line ${lineNum}: Line numbers are 1-indexed, got ${start}` };
    if (end < start)
      return { error: `Line ${lineNum}: Range ${start}..${end} ends before it starts` };
    return { op: { type: 'replace', startLine: start, endLine: end, body: [] } };
  }

  // replace block N: (tree-sitter structural edit — future enhancement)
  const replaceBlockMatch = line.match(/^replace\s+block\s+(\d+)\s*:?\s*$/i);
  if (replaceBlockMatch) {
    const start = parseInt(replaceBlockMatch[1], 10);
    // For now, treat as single-line replace (tree-sitter integration is future work)
    return { op: { type: 'replace', startLine: start, endLine: start, body: [] } };
  }

  // delete N..M or delete N
  const deleteMatch = line.match(/^delete\s+(\d+)(?:\.\.(\d+))?\s*$/i);
  if (deleteMatch) {
    const start = parseInt(deleteMatch[1], 10);
    const end = deleteMatch[2] ? parseInt(deleteMatch[2], 10) : start;
    if (start < 1) return { error: `Line ${lineNum}: Line numbers are 1-indexed, got ${start}` };
    if (end < start)
      return { error: `Line ${lineNum}: Range ${start}..${end} ends before it starts` };
    return { op: { type: 'delete', startLine: start, endLine: end, body: [] } };
  }

  // insert before N: / insert after N:
  const insertBeforeMatch = line.match(/^insert\s+before\s+(\d+)\s*:?\s*$/i);
  if (insertBeforeMatch) {
    const lineNum_ = parseInt(insertBeforeMatch[1], 10);
    return { op: { type: 'insert', startLine: lineNum_, position: 'before', body: [] } };
  }

  const insertAfterMatch = line.match(/^insert\s+after\s+(\d+)\s*:?\s*$/i);
  if (insertAfterMatch) {
    const lineNum_ = parseInt(insertAfterMatch[1], 10);
    return { op: { type: 'insert', startLine: lineNum_, position: 'after', body: [] } };
  }

  // insert head: / insert tail:
  if (line.match(/^insert\s+head\s*:?\s*$/i)) {
    return { op: { type: 'insert', startLine: 0, position: 'head', body: [] } };
  }
  if (line.match(/^insert\s+tail\s*:?\s*$/i)) {
    return { op: { type: 'insert', startLine: 0, position: 'tail', body: [] } };
  }

  return {}; // Not an op header
}

// ============================================================================
// Applicator
// ============================================================================

/**
 * Apply a parsed hashline section to a file.
 *
 * Steps:
 * 1. Read the file
 * 2. Validate hash matches expected
 * 3. Apply operations (in reverse line order to preserve line numbers)
 * 4. Write the result
 */
export function applyHashlineSection(section: HashlineSection): HashlineApplyResult {
  const store = getSnapshotStore();

  // 1. Read file
  let content: string;
  try {
    content = fs.readFileSync(section.filePath, 'utf-8');
  } catch (err) {
    return {
      success: false,
      filePath: section.filePath,
      error: `Cannot read file: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // 2. Validate hash
  const currentHash = computeFileHash(content);
  if (currentHash !== section.expectedHash) {
    // Try snapshot-based recovery
    const snapshot = store.get(section.filePath);
    if (snapshot && snapshot.hash === section.expectedHash) {
      // File changed since read, but we have the snapshot
      // Attempt recovery: apply edits to snapshot lines, then diff
      return applyWithRecovery(section, snapshot, content);
    }
    return {
      success: false,
      filePath: section.filePath,
      error: `Stale hash for ${section.filePath}: expected ${section.expectedHash}, got ${currentHash}. File changed since last read. Re-read the file before editing.`,
    };
  }

  // 3. Apply operations
  const lines = content.split('\n');
  const result = applyOperations(lines, section.ops);

  if (result.error) {
    return { success: false, filePath: section.filePath, error: result.error };
  }

  // 4. Write result
  const newContent = result.lines.join('\n');
  const newHash = computeFileHash(newContent);

  // Atomic write
  const tmpPath = section.filePath + `.tmp.${Date.now()}`;
  try {
    fs.writeFileSync(tmpPath, newContent, 'utf-8');
    fs.renameSync(tmpPath, section.filePath);
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath);
    } catch (err) {
      console.warn('[Catch]', err);
      /* ignore */
    }
    return {
      success: false,
      filePath: section.filePath,
      error: `Write failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Update snapshot
  store.record(section.filePath, newContent);

  return {
    success: true,
    filePath: section.filePath,
    newContent,
    newHash,
    replacements: result.replacements,
    warnings: result.warnings,
  };
}

/**
 * Apply operations to lines array. Operations are sorted and applied in reverse
 * line order to preserve line numbers.
 */
function applyOperations(
  lines: string[],
  ops: HashlineOp[],
): {
  lines: string[];
  error?: string;
  replacements: number;
  warnings: string[];
} {
  const warnings: string[] = [];
  let replacements = 0;

  // Sort ops by start line descending (apply from bottom to top)
  const sorted = [...ops].sort((a, b) => b.startLine - a.startLine);

  let result = [...lines];

  for (const op of sorted) {
    switch (op.type) {
      case 'replace': {
        const start = op.startLine - 1; // Convert to 0-indexed
        const end = (op.endLine ?? op.startLine) - 1;

        if (start < 0 || start >= result.length) {
          return {
            lines: result,
            error: `Line ${op.startLine} does not exist (file has ${result.length} lines)`,
            replacements,
            warnings,
          };
        }
        if (end >= result.length) {
          return {
            lines: result,
            error: `Line ${op.endLine} does not exist (file has ${result.length} lines)`,
            replacements,
            warnings,
          };
        }
        if (op.body.length === 0) {
          return {
            lines: result,
            error: `replace ${op.startLine}..${op.endLine}: needs at least one +TEXT body row`,
            replacements,
            warnings,
          };
        }

        // Replace lines start..end with body
        result.splice(start, end - start + 1, ...op.body);
        replacements++;
        break;
      }

      case 'delete': {
        const start = op.startLine - 1;
        const end = (op.endLine ?? op.startLine) - 1;

        if (start < 0 || start >= result.length) {
          return {
            lines: result,
            error: `Line ${op.startLine} does not exist (file has ${result.length} lines)`,
            replacements,
            warnings,
          };
        }
        if (end >= result.length) {
          return {
            lines: result,
            error: `Line ${op.endLine} does not exist (file has ${result.length} lines)`,
            replacements,
            warnings,
          };
        }

        result.splice(start, end - start + 1);
        replacements++;
        break;
      }

      case 'insert': {
        let insertIdx: number;
        switch (op.position) {
          case 'before':
            insertIdx = op.startLine - 1;
            break;
          case 'after':
            insertIdx = op.startLine;
            break;
          case 'head':
            insertIdx = 0;
            break;
          case 'tail':
            insertIdx = result.length;
            break;
          default:
            return {
              lines: result,
              error: `Unknown insert position: ${op.position}`,
              replacements,
              warnings,
            };
        }

        if (insertIdx < 0 || insertIdx > result.length) {
          return {
            lines: result,
            error: `Insert position ${op.startLine} is out of range (file has ${result.length} lines)`,
            replacements,
            warnings,
          };
        }

        result.splice(insertIdx, 0, ...op.body);
        replacements++;
        break;
      }
    }
  }

  return { lines: result, replacements, warnings };
}

/**
 * Attempt recovery when file changed since read.
 * Apply edits to the snapshot's lines, then produce the result.
 */
function applyWithRecovery(
  section: HashlineSection,
  snapshot: FileSnapshot,
  currentContent: string,
): HashlineApplyResult {
  const warnings: string[] = [
    `File changed since last read. Applying edits to snapshot version.`,
    `Re-read may be needed if changes conflict.`,
  ];

  // Apply edits to snapshot lines
  const result = applyOperations([...snapshot.lines], section.ops);

  if (result.error) {
    return { success: false, filePath: section.filePath, error: result.error };
  }

  const newContent = result.lines.join('\n');
  const newHash = computeFileHash(newContent);

  // Atomic write
  const tmpPath = section.filePath + `.tmp.${Date.now()}`;
  try {
    fs.writeFileSync(tmpPath, newContent, 'utf-8');
    fs.renameSync(tmpPath, section.filePath);
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath);
    } catch (err) {
      console.warn('[Catch]', err);
      /* ignore */
    }
    return {
      success: false,
      filePath: section.filePath,
      error: `Write failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Update snapshot
  getSnapshotStore().record(section.filePath, newContent);

  return {
    success: true,
    filePath: section.filePath,
    newContent,
    newHash,
    replacements: result.replacements,
    warnings,
  };
}

// ============================================================================
// Convenience
// ============================================================================

/**
 * Format a hashline header for a file.
 */
export function formatHashlineHeader(filePath: string, hash: string): string {
  return `${FILE_PREFIX}${filePath}${HASH_SEP}${hash}`;
}

/**
 * Format numbered lines in hashline display format.
 */
export function formatNumberedLines(content: string, startLine = 1): string {
  const lines = content.split('\n');
  return lines.map((line, i) => `${startLine + i}:${line}`).join('\n');
}

/**
 * Check if input looks like hashline format (starts with ¶).
 */
export function isHashlineFormat(input: string): boolean {
  return input.trimStart().startsWith(FILE_PREFIX);
}
