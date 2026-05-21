export type {
  JSONRPCRequest,
  JSONRPCResponse,
  JSONRPCError,
  MCPTool,
  MCPResource,
  MCPPrompt,
  MCPContentItem,
  MCPToolResult,
  MCPResourceContents,
  MCPJsonSchema,
  MCPTransport,
  MCPClientConfig,
  MCPInitializeResult,
  MCPServerCapabilities,
  ListToolsResult,
  CallToolResult,
} from './types';
export { MCP_ERROR_CODES } from './types';

export { MCPClient, StdioClientTransport, StreamableHTTPClientTransport, createMCPClient } from './client';
export { MCPServer } from './server';
export type { MCPToolRegistration, MCPResourceRegistration, MCPPromptRegistration } from './server';
export {
  canTransition,
  AGENT_CARD_WELL_KNOWN_PATH,
  A2A_VERSION_HEADER,
  A2A_PROTOCOL_VERSION,
  A2A_ERROR,
  A2A_METHODS,
} from './a2aCompliance';
export type {
  A2AAgentCard,
  A2AAgentCapabilities,
  A2AAgentSkill,
  A2AAgentInterface,
  A2AJsonRpcRequest,
  A2AJsonRpcResponse,
  A2ATask,
  A2ATaskState,
  A2ATaskStatus,
  A2AArtifact,
  A2AMessage,
  A2APart,
  A2ASendMessageParams,
  A2ATaskQueryParams,
  A2AListTasksParams,
  A2AListTasksResult,
} from './a2aCompliance';
export { A2A_TERMINAL_STATES, A2A_INTERRUPTED_STATES } from './a2aCompliance';

export { A2AServer, createA2AServer } from './a2aServer';
export type { A2AServerConfig } from './a2aServer';

export { A2AClient, A2ADiscoveryManager, A2ARpcError, createA2AClient, createA2ADiscoveryManager } from './a2aClient';
export type { A2ADiscoveredAgent } from './a2aClient';

export { MCPToolAdapter, MCPIntegrationManager, readMCPConfig, readA2ADiscoveryConfig } from '../tools/mcpToolAdapter';
export type { MCPIntegrationConfig, MCPIntegrationServerConfig } from '../tools/mcpToolAdapter';
