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

import type { Tool, ToolDefinition, LLMMessage } from '../runtime/types';
import { getCheckpointManager } from '../runtime/checkpointManager';

// ============================================================================
// Checkpoint Save Tool
// ============================================================================

export class CheckpointSaveTool implements Tool {
  definition: ToolDefinition = {
    name: 'checkpoint_save',
    description: `Save a checkpoint of the current conversation state. Use this before trying an approach that might not work — you can rewind later.

The checkpoint captures: messages, step number, files read/modified.
Returns a checkpoint ID for later use with checkpoint_rewind.`,
    inputSchema: {
      type: 'object',
      properties: {
        label: { type: 'string', description: 'Human-readable label for this checkpoint (e.g., "before refactor", "approach A")' },
        messages: { type: 'array', description: 'Current conversation messages (pass the messages array)', items: { type: 'object' } },
        stepNumber: { type: 'number', description: 'Current step number' },
        filesRead: { type: 'array', description: 'Files read so far', items: { type: 'string' } },
        filesModified: { type: 'array', description: 'Files modified so far', items: { type: 'string' } },
      },
      required: ['label', 'messages', 'stepNumber'],
    },
    examples: [
      { name: 'checkpoint_save', arguments: { label: 'before refactor', messages: [], stepNumber: 5 } },
    ],
    category: 'workflow',
  };

  async execute(args: Record<string, unknown>): Promise<string> {
    const label = String(args.label ?? 'unnamed');
    const messages = (args.messages ?? []) as LLMMessage[];
    const stepNumber = Number(args.stepNumber ?? 0);
    const filesRead = (args.filesRead ?? []) as string[];
    const filesModified = (args.filesModified ?? []) as string[];

    const manager = getCheckpointManager();
    const checkpoint = manager.save(label, messages, stepNumber, filesRead, filesModified);

    return `Checkpoint saved: ${checkpoint.id}\nLabel: ${label}\nStep: ${stepNumber}\nMessages: ${messages.length}\nFiles read: ${filesRead.length}, modified: ${filesModified.length}`;
  }
}

// ============================================================================
// Checkpoint Rewind Tool
// ============================================================================

export class CheckpointRewindTool implements Tool {
  definition: ToolDefinition = {
    name: 'checkpoint_rewind',
    description: `Rewind to a previous checkpoint. This restores the conversation state to when the checkpoint was saved.

Use this when an approach didn't work and you want to try a different strategy.
Returns the restored messages.`,
    inputSchema: {
      type: 'object',
      properties: {
        checkpointId: { type: 'string', description: 'Checkpoint ID from checkpoint_save' },
      },
      required: ['checkpointId'],
    },
    examples: [
      { name: 'checkpoint_rewind', arguments: { checkpointId: 'cp_1234567890_abc123' } },
    ],
    category: 'workflow',
  };

  async execute(args: Record<string, unknown>): Promise<string> {
    const checkpointId = String(args.checkpointId ?? '');

    if (!checkpointId) return 'Error: checkpointId is required';

    const manager = getCheckpointManager();
    const messages = manager.rewind(checkpointId);

    if (!messages) {
      return `Error: Checkpoint not found: ${checkpointId}. Available: ${manager.list().map(cp => cp.id).join(', ')}`;
    }

    return `Rewound to checkpoint: ${checkpointId}\nRestored ${messages.length} messages.\nAll messages after this checkpoint have been discarded.`;
  }
}

// ============================================================================
// Checkpoint List Tool
// ============================================================================

export class CheckpointListTool implements Tool {
  definition: ToolDefinition = {
    name: 'checkpoint_list',
    description: 'List all saved checkpoints. Returns checkpoint IDs, labels, and summaries.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    examples: [
      { name: 'checkpoint_list', arguments: {} },
    ],
    category: 'workflow',
  };

  async execute(_args: Record<string, unknown>): Promise<string> {
    const manager = getCheckpointManager();
    const checkpoints = manager.list();

    if (checkpoints.length === 0) {
      return 'No checkpoints saved. Use checkpoint_save to save a checkpoint before trying an approach.';
    }

    const lines = checkpoints.map(cp => {
      const age = Math.round((Date.now() - cp.timestamp) / 1000);
      return `${cp.id} | ${cp.label} | step ${cp.stepNumber} | ${cp.messageCount} msgs | ${cp.tokenCount} tok | ${age}s ago`;
    });

    return `Checkpoints (${checkpoints.length}):\n${lines.join('\n')}`;
  }
}

// ============================================================================
// Checkpoint Collapse Tool
// ============================================================================

export class CheckpointCollapseTool implements Tool {
  definition: ToolDefinition = {
    name: 'checkpoint_collapse',
    description: 'Collapse a checkpoint into a concise summary. Use this to compress context from an exploratory phase.',
    inputSchema: {
      type: 'object',
      properties: {
        checkpointId: { type: 'string', description: 'Checkpoint ID from checkpoint_save' },
      },
      required: ['checkpointId'],
    },
    examples: [
      { name: 'checkpoint_collapse', arguments: { checkpointId: 'cp_1234567890_abc123' } },
    ],
    category: 'workflow',
  };

  async execute(args: Record<string, unknown>): Promise<string> {
    const checkpointId = String(args.checkpointId ?? '');

    if (!checkpointId) return 'Error: checkpointId is required';

    const manager = getCheckpointManager();
    const summary = manager.collapse(checkpointId);

    if (!summary) {
      return `Error: Checkpoint not found: ${checkpointId}`;
    }

    return summary;
  }
}
