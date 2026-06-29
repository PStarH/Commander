/**
 * FileHashEditTool — Content-hash-anchored file editing.
 *
 * Uses the @hash→content format from HashAnchoredEditor for drift-proof
 * surgical edits. Unlike file_edit (which uses line numbers), this tool
 * anchors edits to per-line content hashes that survive line number drift.
 *
 * Format:
 *   ¶src/file.ts#FILE_HASH
 *   @A1B2C3→replacement text
 *   @D4E5F6,G7H8I9→
 *   multi-line
 *   replacement
 *
 * Per-line content hashes are shown in file_read output when
 * includeHashes:true is set. Each line gets a #XXXXXX hash annotation.
 */

import * as fs from 'node:fs';
import type { Tool, ToolDefinition } from '../runtime/types';
import { isHashlineFormat, parseHashline, applyHashlineSection } from '../edit/hashline';
import { parseAndApplyHashEdit, isHashEditFormat } from '../edit/hashAnchoredEditor';
import { safePath } from './fileSystemTool';
import { atomicWriteFile } from './_utils/atomicWrite';
import { pathExists } from './_utils/pathExists';
import { getSnapshotStore } from '../edit/snapshotStore';

export class FileHashEditTool implements Tool {
  definition: ToolDefinition = {
    name: 'file_hash_edit',
    description: `Edit a file using content-hash-anchored format (drift-proof).

PREFERRED over file_edit for all edits. Saves 61% tokens vs retyping old content.

FORMAT:
  ¶path/file.ts#FILE_HASH
  @CONTENT_HASH→replacement

HOW TO USE:
  1. Read the file with file_read(includeHashes:true)
  2. Each line shows its content hash as #XXXXXX at the end
  3. Create edits referencing those hashes: @XXXXXX→new content
  4. Multi-line: @HASH1,HASH2→ (then new lines on subsequent rows)

The file-level hash (#FILE_HASH) prevents editing stale files.
Content hashes stay valid even when line numbers change.`,
    inputSchema: {
      type: 'object',
      properties: {
        input: {
          type: 'string',
          description:
            'Hash-edit input (starts with ¶PATH#FILE_HASH). Use @HASH→new content format.',
        },
        path: {
          type: 'string',
          description: 'Legacy: path to file (for backward compat with string replacement)',
        },
        oldString: { type: 'string', description: 'Legacy: text to replace' },
        newString: { type: 'string', description: 'Legacy: replacement text' },
      },
      required: [],
    },
    examples: [
      // Hash-anchored single-line edit
      {
        name: 'file_hash_edit',
        arguments: { input: '¶src/config.ts#A1B2\n@F7G8H9→const port = 8080;' },
      },
      // Hash-anchored multi-line edit
      {
        name: 'file_hash_edit',
        arguments: {
          input:
            '¶src/config.ts#A1B2\n@F7G8H9,I0J1K2→\nconst port = 8080;\nconst host = "0.0.0.0"',
        },
      },
    ],
    category: 'filesystem',
  };

  async execute(args: Record<string, unknown>): Promise<string> {
    const input = String(args.input ?? '');

    // Detect mode: hash-edit or legacy
    if (input && isHashEditFormat(input)) {
      return parseAndApplyHashEdit(input);
    }

    // Fallback to hashline format
    if (input && isHashlineFormat(input)) {
      const parsed = parseHashline(input);
      if (parsed.errors.length > 0) {
        return `Hashline parse errors:\n${parsed.errors.join('\n')}`;
      }
      const results: string[] = [];
      for (const section of parsed.sections) {
        try {
          const resolved = safePath(section.filePath);
          section.filePath = resolved;
          const result = applyHashlineSection(section);
          if (result.success) {
            let msg = `✅ ${section.filePath}`;
            if (result.replacements) msg += ` (${result.replacements} op(s))`;
            if (result.newHash) msg += ` [hash: ${result.newHash}]`;
            results.push(msg);
          } else {
            results.push(`❌ ${section.filePath}: ${result.error}`);
          }
        } catch (err) {
          results.push(`❌ Error: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      return results.join('\n');
    }

    // Legacy string replacement
    const filePath = String(args.path ?? '');
    const oldStr = String(args.oldString ?? '');
    const newStr = String(args.newString ?? '');

    if (!filePath || !oldStr) {
      return 'Error: Provide input in @hash→content format, or use path+oldString+newString for legacy replacement. Read the file with file_read(includeHashes:true) to get content hashes.';
    }

    try {
      const resolved = safePath(filePath);
      if (!(await pathExists(resolved))) return `Error: file not found: ${filePath}`;

      const content = await fs.promises.readFile(resolved, 'utf-8');
      const idx = content.indexOf(oldStr);
      if (idx === -1)
        return `Error: oldString not found in ${filePath}. Try re-reading the file with includeHashes:true and use @hash→content format.`;

      const occurrences = content.split(oldStr).length - 1;
      const updated = content.split(oldStr).join(newStr);
      await atomicWriteFile(resolved, updated, { encoding: 'utf-8' });
      getSnapshotStore().record(resolved, updated);

      return `✅ ${filePath}: replaced ${occurrences} occurrence(s)`;
    } catch (err) {
      return `Error editing file: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}
