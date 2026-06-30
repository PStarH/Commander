import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTaintTrackingPlugin } from '../../src/plugins/builtin/taintTrackingPlugin';
import type {
  CommanderPlugin,
  BeforeToolCallContext,
  AfterToolCallContext,
} from '../../src/pluginManager';
import type { Tool, ToolDefinition, ToolResult } from '../../src/runtime/types/tool';

// ── Helpers ──────────────────────────────────────────────────────────────
// Builds a minimal Tool carrying only the fields the taint-tracking plugin
// inspects (definition.riskMetadata.sideEffect). The execute() stub is never
// invoked because the plugin short-circuits via beforeToolCall before the
// tool is run.

function makeTool(
  name: string,
  sideEffect?: 'none' | 'local_state' | 'external_egress',
): Tool {
  const def: ToolDefinition = {
    name,
    description: `test tool ${name}`,
    inputSchema: {},
    riskMetadata: sideEffect ? { sideEffect } : undefined,
  };
  return {
    definition: def,
    execute: vi.fn(),
  };
}

function makeToolResult(name: string): ToolResult {
  return {
    toolCallId: 'tc-1',
    name,
    output: 'ok',
    durationMs: 10,
  };
}

function makeBeforeCtx(
  toolName: string,
  runId: string,
  tool?: Tool,
): BeforeToolCallContext {
  return { toolName, args: {}, agentId: 'a1', runId, tool };
}

function makeAfterCtx(
  toolName: string,
  runId: string,
  tool: Tool,
): AfterToolCallContext {
  return {
    toolName,
    args: {},
    result: makeToolResult(toolName),
    agentId: 'a1',
    runId,
    tool,
  };
}

describe('builtin-taint-tracking plugin', () => {
  let plugin: CommanderPlugin;

  beforeEach(async () => {
    plugin = createTaintTrackingPlugin();
    await plugin.onLoad!({
      config: { blockOutboundOnExternalDirty: true, outboundToolWhitelist: [] },
    } as any);
  });

  afterEach(async () => {
    if (plugin.onUnload) await plugin.onUnload();
  });

  it('has the correct metadata', () => {
    expect(plugin.name).toBe('builtin-taint-tracking');
    expect(plugin.category).toBe('security');
  });

  it('does not block outbound when run is CLEAN', async () => {
    // onAgentStart context is { ctx, runId }; the plugin only reads runId.
    await plugin.onAgentStart!({ runId: 'r1' } as any);
    const result = await plugin.beforeToolCall!(
      makeBeforeCtx('send_email', 'r1', makeTool('send_email', 'external_egress')),
    );
    expect(result).toBeNull();
  });

  it('does not block local tools after EXTERNAL_DIRTY', async () => {
    await plugin.onAgentStart!({ runId: 'r1' } as any);
    // Promote to EXTERNAL_DIRTY via afterToolCall on web_fetch.
    await plugin.afterToolCall!(
      makeAfterCtx('web_fetch', 'r1', makeTool('web_fetch', 'external_egress')),
    );
    // file_read is internal — should NOT be blocked even after EXTERNAL_DIRTY.
    const result = await plugin.beforeToolCall!(
      makeBeforeCtx('file_read', 'r1', makeTool('file_read', 'none')),
    );
    expect(result).toBeNull();
  });

  it('blocks external_egress tools after EXTERNAL_DIRTY', async () => {
    await plugin.onAgentStart!({ runId: 'r1' } as any);
    await plugin.afterToolCall!(
      makeAfterCtx('web_fetch', 'r1', makeTool('web_fetch', 'external_egress')),
    );
    const result = await plugin.beforeToolCall!(
      makeBeforeCtx('send_email', 'r1', makeTool('send_email', 'external_egress')),
    );
    // beforeToolCall returns a ToolResult on block (with `error` set), null on allow.
    expect(result).not.toBeNull();
    expect(result!.error).toBeDefined();
  });

  it('allows whitelisted external_egress tools after EXTERNAL_DIRTY', async () => {
    // Re-load the plugin with send_email whitelisted.
    if (plugin.onUnload) await plugin.onUnload();
    plugin = createTaintTrackingPlugin();
    await plugin.onLoad!({
      config: {
        blockOutboundOnExternalDirty: true,
        outboundToolWhitelist: ['send_email'],
      },
    } as any);

    await plugin.onAgentStart!({ runId: 'r1' } as any);
    await plugin.afterToolCall!(
      makeAfterCtx('web_fetch', 'r1', makeTool('web_fetch', 'external_egress')),
    );
    const result = await plugin.beforeToolCall!(
      makeBeforeCtx('send_email', 'r1', makeTool('send_email', 'external_egress')),
    );
    expect(result).toBeNull();
  });

  it('promotes to LOCAL_DIRTY (not EXTERNAL) for internal tools', async () => {
    await plugin.onAgentStart!({ runId: 'r1' } as any);
    // code_search is internal — should NOT promote to EXTERNAL_DIRTY.
    await plugin.afterToolCall!(
      makeAfterCtx('code_search', 'r1', makeTool('code_search', 'none')),
    );
    // Outbound should still be allowed (tier is LOCAL_DIRTY, not EXTERNAL_DIRTY).
    const result = await plugin.beforeToolCall!(
      makeBeforeCtx('send_email', 'r1', makeTool('send_email', 'external_egress')),
    );
    expect(result).toBeNull();
  });

  it('fallback: tools without riskMetadata that match known external names are external', async () => {
    await plugin.onAgentStart!({ runId: 'r1' } as any);
    // web_search without riskMetadata — fallback regex should catch it and
    // promote the run to EXTERNAL_DIRTY.
    await plugin.afterToolCall!(
      makeAfterCtx('web_search', 'r1', makeTool('web_search')),
    );
    // Now send_email should be blocked.
    const result = await plugin.beforeToolCall!(
      makeBeforeCtx('send_email', 'r1', makeTool('send_email', 'external_egress')),
    );
    expect(result).not.toBeNull();
    expect(result!.error).toBeDefined();
  });
});
