export { WebSearchTool, WebFetchTool } from './webSearchTool';
export { FileReadTool, FileWriteTool, FileEditTool, FileSearchTool, FileListTool, GlobTool, } from './fileSystemTool';
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
export { CheckpointSaveTool, CheckpointRewindTool, CheckpointListTool, CheckpointCollapseTool, } from './checkpointTool';
export { HandoffTool, HandoffCheckTool } from './handoffTool';
export { FileResourceTool, MemoryResourceTool, WebResourceTool, BrowserResourceTool, CodeResourceTool, CheckpointResourceTool, HandoffResourceTool, ExecResourceTool, MediaResourceTool, SystemResourceTool, createResourceTools, wireResourceToolDependencies, } from './resourceTools';
import type { Tool } from '../runtime/types';
import { ExecuteScriptTool } from './scriptTool';
import { CodeRefinerTool } from './codeRefinerTool';
import { CodeFixerTool } from './codeFixer';
/**
 * Create the full set of tools exposed to the LLM.
 *
 * STRAP consolidation: only domain-level resource tools are registered for
 * filesystem, memory, web, browser, code, checkpoint, handoff, execution,
 * media, and system operations. The legacy granular CRUD tools are still
 * exported and can be instantiated directly, but they are no longer exposed
 * to the model to avoid the 10–30 tool degradation cliff.
 */
export declare function createAllTools(options?: {
    enableMetaTools?: boolean;
}): Map<string, Tool>;
/**
 * Build a map of tool executor functions from a tool map.
 * Useful for wiring programmatic tool callers (e.g., exec.script).
 */
export declare function buildToolExecutorMap(tools: Map<string, Tool>): Map<string, (args: Record<string, unknown>) => Promise<string>>;
/** Legacy re-export for backward compatibility. */
export { ExecuteScriptTool as _ExecuteScriptTool };
export { CodeRefinerTool as _CodeRefinerTool };
export { CodeFixerTool as _CodeFixerTool };
//# sourceMappingURL=index.d.ts.map