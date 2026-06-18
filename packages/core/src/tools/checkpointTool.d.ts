/**
 * Checkpoint & Rewind Tools — save and restore conversation state.
 *
 * Inspired by oh-my-pi's checkpoint/rewind tools. These tools allow the agent to:
 * - Save a checkpoint before trying an approach
 * - Rewind if the approach didn't work
 * - Collapse a checkpoint into a concise report
 *
 * Critical for long coding sessions where the model may need to backtrack.
 */
import type { Tool, ToolDefinition } from '../runtime/types';
export declare class CheckpointSaveTool implements Tool {
    definition: ToolDefinition;
    execute(args: Record<string, unknown>): Promise<string>;
}
export declare class CheckpointRewindTool implements Tool {
    definition: ToolDefinition;
    execute(args: Record<string, unknown>): Promise<string>;
}
export declare class CheckpointListTool implements Tool {
    definition: ToolDefinition;
    execute(_args: Record<string, unknown>): Promise<string>;
}
export declare class CheckpointCollapseTool implements Tool {
    definition: ToolDefinition;
    execute(args: Record<string, unknown>): Promise<string>;
}
//# sourceMappingURL=checkpointTool.d.ts.map