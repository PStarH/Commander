export { WebSearchTool, WebFetchTool } from './webSearchTool';
export { FileReadTool, FileWriteTool, FileEditTool, FileSearchTool, FileListTool } from './fileSystemTool';
export { PythonExecuteTool, ShellExecuteTool } from './codeExecutionTool';
export { MemoryStoreTool, MemoryRecallTool, MemoryListTool } from './persistenceTool';
export { GitTool } from './gitTool';
export { BrowserSearchTool, BrowserFetchTool } from './browserTool';
export { AgentTool } from './agentTool';
export type { AgentDef } from './agentTool';
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
export { ToolRegistry, TOOL_CATEGORIES } from './toolRegistry';

import type { Tool } from '../runtime/types';
import { WebSearchTool, WebFetchTool } from './webSearchTool';
import { FileReadTool, FileWriteTool, FileEditTool, FileSearchTool, FileListTool } from './fileSystemTool';
import { PythonExecuteTool, ShellExecuteTool } from './codeExecutionTool';
import { MemoryStoreTool, MemoryRecallTool, MemoryListTool } from './persistenceTool';
import { GitTool } from './gitTool';
import { BrowserSearchTool, BrowserFetchTool } from './browserTool';
import { MetaTool, getBuiltinMetaSpecs } from './metaTool';
import type { MetaToolSpec } from './metaTool';
import { ExecuteScriptTool } from './scriptTool';
import { VisionAnalyzeTool } from './multimodal/visionTool';
import { PdfExtractTool } from './multimodal/pdfTool';
import { ScreenshotCaptureTool } from './multimodal/screenshotTool';
import { CodeSearchTool } from './codeSearchTool';
import { ApplyPatchTool } from './patchTool';
import { CodeRefinerTool } from './codeRefinerTool';
import { AnswerFormatTool } from './answerFormatTool';

export function createAllTools(options?: { enableMetaTools?: boolean }): Map<string, Tool> {
  const tools = new Map<string, Tool>();
  const instances: [string, Tool][] = [
    ['web_search', new WebSearchTool()],
    ['web_fetch', new WebFetchTool()],
    ['browser_search', new BrowserSearchTool()],
    ['browser_fetch', new BrowserFetchTool()],
    ['file_read', new FileReadTool()],
    ['file_write', new FileWriteTool()],
    ['file_edit', new FileEditTool()],
    ['file_search', new FileSearchTool()],
    ['file_list', new FileListTool()],
    ['python_execute', new PythonExecuteTool()],
    ['shell_execute', new ShellExecuteTool()],
    ['memory_store', new MemoryStoreTool()],
    ['memory_recall', new MemoryRecallTool()],
    ['memory_list', new MemoryListTool()],
    ['git', new GitTool()],
    ['execute_script', new ExecuteScriptTool()],
    ['vision_analyze', new VisionAnalyzeTool()],
    ['pdf_extract', new PdfExtractTool()],
    ['screenshot_capture', new ScreenshotCaptureTool()],
    ['code_search', new CodeSearchTool()],
    ['apply_patch', new ApplyPatchTool()],
    ['refine_code', new CodeRefinerTool()],
    ['verify_answer', new AnswerFormatTool()],
  ];
  for (const [name, tool] of instances) {
    tools.set(name, tool);
  }

  if (options?.enableMetaTools) {
    const subToolMap = new Map<string, (args: Record<string, unknown>) => Promise<string>>();
    for (const [name, tool] of tools) {
      subToolMap.set(name, (args) => tool.execute(args));
    }

    for (const spec of getBuiltinMetaSpecs()) {
      const name = spec.name;
      const metaTool = new MetaTool(spec, subToolMap);
      tools.set(name, metaTool);
    }
  }

  return tools;
}
