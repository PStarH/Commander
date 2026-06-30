/**
 * Plugin Manager — barrel re-export preserving the public API.
 *
 * Historically this file was a 1280-line monolith mixing type definitions,
 * the HookManager class (16 fire* methods + sandbox helpers + singleton),
 * the createLoggingPlugin built-in, and re-exports of built-in plugins.
 *
 * The split moves:
 *   - Types / interfaces / PluginEntry → ./pluginTypes
 *   - HookManager + buildSandboxedLoadContext + validateAndMergeConfig +
 *     withTimeout + getHookManager/resetHookManager singleton → ./hookManager
 *
 * This barrel keeps every existing `import { X } from './pluginManager'`
 * working unchanged — see the test suite (pluginManager.test.ts,
 * pluginPermissions.test.ts, plugin-hooks-integration.test.ts, runtime
 * gate harness, etc.) for confirmation of the preserved API surface.
 */

// ── Types & interfaces (from ./pluginTypes) ──────────────────────────────
export type {
  HookPoint,
  PluginCategory,
  HookContext,
  BeforeToolCallContext,
  AfterToolCallContext,
  BeforeLLMCallContext,
  AfterLLMCallContext,
  AgentStartContext,
  AgentCompleteContext,
  ErrorContext,
  BeforeToolResolveContext,
  AfterToolResolveContext,
  ToolTimeoutContext,
  ToolRetryContext,
  ContextCompactionContext,
  SessionForkContext,
  SessionArchiveContext,
  StepLifecycleContext,
  BeforeBackendSelectContext,
  AfterBackendSelectContext,
  PluginConfigField,
  PluginConfigSchema,
  PluginLoadContext,
  CommanderPlugin,
  BuiltinPluginTool,
  PluginServiceDeclaration,
  PluginEntry,
} from './pluginTypes';

// ── Value export: tool adapter helper (from ./pluginTypes) ───────────────
export { adaptBuiltinPluginTool } from './pluginTypes';

// ── HookManager + singleton (from ./hookManager) ────────────────────────
export { HookManager, getHookManager, resetHookManager } from './hookManager';

// ── Built-in plugins ──────────────────────────────────────────────────────
// createLoggingPlugin kept inline: it is small (one factory returning a
// CommanderPlugin object literal) and references only getGlobalLogger + the
// CommanderPlugin type. Extracting it to its own file would be over-engineering.
import { getGlobalLogger } from './logging';
import type { CommanderPlugin } from './pluginTypes';

export function createLoggingPlugin(): CommanderPlugin {
  return {
    name: 'builtin-logger',
    description: 'Logs all hook activity to console',
    version: '0.1.0',
    configSchema: {
      type: 'object',
      properties: {
        verbose: { type: 'boolean', description: 'Log all hook points', default: false },
        prefix: { type: 'string', description: 'Log prefix', default: '[Plugin:logger]' },
      },
    },
    onLoad: async (ctx) => {
      const prefix = (ctx.config.prefix as string) ?? '[Plugin:logger]';
      getGlobalLogger().info('PluginManager', `${prefix} loaded (verbose=${ctx.config.verbose})`);
    },
    beforeToolCall: async (ctx) => {
      getGlobalLogger().info('PluginManager', `[Plugin:logger] beforeToolCall: ${ctx.toolName}`);
      return null;
    },
    onAgentStart: async (ctx) => {
      getGlobalLogger().info(
        'PluginManager',
        `[Plugin:logger] Agent started: ${ctx.ctx.agentId}, goal: ${ctx.ctx.goal.slice(0, 60)}...`,
      );
    },
    onAgentComplete: async (ctx) => {
      getGlobalLogger().info(
        'PluginManager',
        `[Plugin:logger] Agent completed: ${ctx.result.status}`,
      );
    },
    onError: async (ctx) => {
      getGlobalLogger().error('PluginManager', `[Plugin:logger] Error: ${ctx.error.slice(0, 100)}`);
    },
  };
}

// Re-export the built-in plugin factories so hosts can
// `import { createRagPlugin, ... } from './pluginManager'`.
// All plugin files have type-only imports from this module, so there is no
// runtime circular dependency.
export { createRagPlugin } from './plugins/builtin/ragPlugin';
export { createTaintTrackingPlugin } from './plugins/builtin/taintTrackingPlugin';
export { createEvalPlugin } from './plugins/builtin/evalPlugin';
export { createReportingPlugin } from './plugins/builtin/reportingPlugin';
export { createConsensusPlugin } from './plugins/builtin/consensusPlugin';
