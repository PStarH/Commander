export { WebSearchTool, WebFetchTool } from './webSearchTool';
export { FileReadTool, FileWriteTool, FileEditTool, FileSearchTool, FileListTool, GlobTool } from './fileSystemTool';
export { FileHashEditTool } from './fileHashEditTool';
export { PythonExecuteTool, ShellExecuteTool } from './codeExecutionTool';
export { MemoryStoreTool, MemoryRecallTool, MemoryListTool } from './persistenceTool';
export { GitTool } from './gitTool';
export { BrowserSearchTool, BrowserFetchTool } from './browserTool';
export { AgentTool } from './agentTool';
export type { AgentDef } from './agentTool';
export { A2ADelegateTool } from './a2aDelegateTool';
export { MetaTool, getBuiltinMetaSpecs, findMatchingMetaSpec } from './metaTool';
export type { MetaToolSpec, MetaToolStep } from './metaTool';
export { ExecuteScriptTool } from './scriptTool';
export { VisionAnalyzeTool } from './multimodal/visionTool';
export { PdfExtractTool } from './multimodal/pdfTool';
export { ScreenshotCaptureTool } from './multimodal/screenshotTool';
export { VerificationTool } from './verificationTool';
export { CodeSearchTool } from './codeSearchTool';
export { ApplyPatchTool } from './patchTool';
export { CodeRefinerTool } from './codeRefinerTool';
export { AnswerFormatTool } from './answerFormatTool';
export { CodeFixerTool } from './codeFixer';
export { SkillViewTool } from '../skills/skillViewTool';
export { SearchConversationsTool } from './conversationSearchTool';
export { ToolRegistry, TOOL_CATEGORIES } from './toolRegistry';
export { createRequestHumanInputTool } from './requestHumanInputTool';
export { createRequestToolTool } from './requestToolTool';
export {
  CheckpointSaveTool, CheckpointRewindTool, CheckpointListTool, CheckpointCollapseTool,
} from './checkpointTool';
export { HandoffTool, HandoffCheckTool } from './handoffTool';

// STRAP-consolidated resource tools (Single Tool Resource Action Pattern)
export {
  FileResourceTool, MemoryResourceTool, WebResourceTool,
  BrowserResourceTool, CodeResourceTool, CheckpointResourceTool,
  HandoffResourceTool, ExecResourceTool, MediaResourceTool,
  SystemResourceTool, createResourceTools, wireResourceToolDependencies,
} from './resourceTools';

import type { Tool } from '../runtime/types';
import { GitTool } from './gitTool';
import { MetaTool, getBuiltinMetaSpecs } from './metaTool';
import { ExecuteScriptTool } from './scriptTool';
import { VerificationTool } from './verificationTool';
import { ApplyPatchTool } from './patchTool';
import { CodeRefinerTool } from './codeRefinerTool';
import { AnswerFormatTool } from './answerFormatTool';
import { CodeFixerTool } from './codeFixer';
import { SkillViewTool } from '../skills/skillViewTool';
import { SearchConversationsTool } from './conversationSearchTool';
import {
  FileResourceTool, MemoryResourceTool, WebResourceTool,
  BrowserResourceTool, CodeResourceTool, CheckpointResourceTool,
  HandoffResourceTool, ExecResourceTool, MediaResourceTool,
  SystemResourceTool,
} from './resourceTools';
import { FileHashEditTool } from './fileHashEditTool';

/**
 * Create the full set of tools exposed to the LLM.
 *
 * STRAP consolidation: only domain-level resource tools are registered for
 * filesystem, memory, web, browser, code, checkpoint, handoff, execution,
 * media, and system operations. The legacy granular CRUD tools are still
 * exported and can be instantiated directly, but they are no longer exposed
 * to the model to avoid the 10–30 tool degradation cliff.
 */
export function createAllTools(options?: { enableMetaTools?: boolean }): Map<string, Tool> {
  const tools = new Map<string, Tool>();
  const instances: [string, Tool][] = [
    // STRAP-consolidated resource tools
    ['file', new FileResourceTool()],
    ['memory', new MemoryResourceTool()],
    ['web', new WebResourceTool()],
    ['browser', new BrowserResourceTool()],
    ['code', new CodeResourceTool()],
    ['checkpoint', new CheckpointResourceTool()],
    ['handoff', new HandoffResourceTool()],
    ['exec', new ExecResourceTool()],
    ['media', new MediaResourceTool()],
    ['system', new SystemResourceTool()],
    // Single-domain tools that are already consolidated
    ['git', new GitTool()],
    ['verify', new VerificationTool()],
    ['apply_patch', new ApplyPatchTool()],
    ['file_hash_edit', new FileHashEditTool()],
    ['verify_answer', new AnswerFormatTool()],
    ['skill_view', new SkillViewTool()],
    ['search_conversations', new SearchConversationsTool()],
  ];
  for (const [name, tool] of instances) {
    tools.set(name, tool);
  }

  if (options?.enableMetaTools) {
    const subToolMap = new Map<string, (args: Record<string, unknown>) => Promise<string>>();
    for (const [name, tool] of tools) {
      subToolMap.set(name, (args) => Promise.resolve(tool.execute(args)).then(String));
    }

    for (const spec of getBuiltinMetaSpecs()) {
      const name = spec.name;
      const metaTool = new MetaTool(spec, subToolMap);
      tools.set(name, metaTool);
    }
  }

  return tools;
}

/**
 * Build a map of tool executor functions from a tool map.
 * Useful for wiring programmatic tool callers (e.g., exec.script).
 */
export function buildToolExecutorMap(
  tools: Map<string, Tool>,
): Map<string, (args: Record<string, unknown>) => Promise<string>> {
  const map = new Map<string, (args: Record<string, unknown>) => Promise<string>>();
  for (const [name, tool] of tools) {
    map.set(name, (args) => Promise.resolve(tool.execute(args)).then(String));
  }
  return map;
}

/** Legacy re-export for backward compatibility. */
export { ExecuteScriptTool as _ExecuteScriptTool };
export { CodeRefinerTool as _CodeRefinerTool };
export { CodeFixerTool as _CodeFixerTool };
