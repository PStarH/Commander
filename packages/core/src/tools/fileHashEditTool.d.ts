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
import type { Tool, ToolDefinition } from '../runtime/types';
export declare class FileHashEditTool implements Tool {
    definition: ToolDefinition;
    execute(args: Record<string, unknown>): Promise<string>;
}
//# sourceMappingURL=fileHashEditTool.d.ts.map