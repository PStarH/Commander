export { WebSearchTool, WebFetchTool } from './webSearchTool';
export { FileReadTool, FileWriteTool, FileEditTool, FileSearchTool, FileListTool } from './fileSystemTool';
export { PythonExecuteTool, ShellExecuteTool } from './codeExecutionTool';
export { MemoryStoreTool, MemoryRecallTool, MemoryListTool } from './persistenceTool';
export { GitTool } from './gitTool';
export { BrowserSearchTool, BrowserFetchTool } from './browserTool';
export { AgentTool } from './agentTool';
export type { AgentDef } from './agentTool';

import type { Tool } from '../runtime/types';
import { WebSearchTool, WebFetchTool } from './webSearchTool';
import { FileReadTool, FileWriteTool, FileEditTool, FileSearchTool, FileListTool } from './fileSystemTool';
import { PythonExecuteTool, ShellExecuteTool } from './codeExecutionTool';
import { MemoryStoreTool, MemoryRecallTool, MemoryListTool } from './persistenceTool';
import { GitTool } from './gitTool';
import { BrowserSearchTool, BrowserFetchTool } from './browserTool';

export function createAllTools(): Map<string, Tool> {
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
  ];
  for (const [name, tool] of instances) {
    tools.set(name, tool);
  }
  return tools;
}
