/**
 * A2A v1.0 Protocol Compliance Types
 * Based on a2aproject/A2A specification v1.0
 * Covers: AgentCard, Task lifecycle, Message, JSON-RPC 2.0, SSE streaming
 */

// ============================================================================
// Task State Machine (8-state from proto spec)
// ============================================================================

export type A2ATaskState =
  | 'SUBMITTED'
  | 'WORKING'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELED'
  | 'INPUT_REQUIRED'
  | 'REJECTED'
  | 'AUTH_REQUIRED';

export const A2A_TERMINAL_STATES: ReadonlySet<A2ATaskState> = new Set([
  'COMPLETED', 'FAILED', 'CANCELED', 'REJECTED',
]);
export const A2A_INTERRUPTED_STATES: ReadonlySet<A2ATaskState> = new Set([
  'INPUT_REQUIRED', 'AUTH_REQUIRED',
]);

// Valid state transitions
const A2A_TRANSITIONS: Record<A2ATaskState, A2ATaskState[]> = {
  SUBMITTED: ['WORKING', 'COMPLETED', 'FAILED', 'CANCELED', 'REJECTED'],
  WORKING: ['COMPLETED', 'FAILED', 'CANCELED', 'INPUT_REQUIRED', 'AUTH_REQUIRED', 'REJECTED'],
  COMPLETED: [],
  FAILED: [],
  CANCELED: [],
  INPUT_REQUIRED: ['WORKING', 'CANCELED'],
  REJECTED: [],
  AUTH_REQUIRED: ['WORKING', 'CANCELED'],
};

export function canTransition(from: A2ATaskState, to: A2ATaskState): boolean {
  return A2A_TRANSITIONS[from]?.includes(to) ?? false;
}

// ============================================================================
// Agent Card v1.0 (from proto AgentCard message)
// ============================================================================

export interface A2AAgentInterface {
  url: string;
  protocolBinding: 'JSONRPC' | 'GRPC' | 'HTTP+JSON';
  protocolVersion: string;
  tenant?: string;
}

export interface A2AAgentCapabilities {
  streaming?: boolean;
  pushNotifications?: boolean;
  stateTransitionHistory?: boolean;
}

export interface A2AAgentSkill {
  id: string;
  name: string;
  description: string;
  tags: string[];
  examples?: string[];
  inputModes?: string[];
  outputModes?: string[];
}

export interface A2AAgentProvider {
  organization: string;
  url: string;
}

export interface A2AAgentCard {
  name: string;
  description: string;
  version: string;
  supportedInterfaces: A2AAgentInterface[];
  capabilities: A2AAgentCapabilities;
  defaultInputModes: string[];
  defaultOutputModes: string[];
  skills: A2AAgentSkill[];
  provider?: A2AAgentProvider;
  documentationUrl?: string;
  iconUrl?: string;
  securitySchemes?: Record<string, unknown>;
  securityRequirements?: Array<Record<string, string[]>>;
}

// ============================================================================
// Message & Task Models
// ============================================================================

export type A2APart =
  | { type: 'text'; text: string }
  | { type: 'file'; file: { uri?: string; mimeType: string; name?: string }; content?: Uint8Array }
  | { type: 'data'; data: Record<string, unknown> };

export interface A2AMessage {
  messageId: string;
  role: 'user' | 'agent';
  parts: A2APart[];
  contextId?: string;
  taskId?: string;
  referenceTaskIds?: string[];
  extensions?: string[];
  metadata?: Record<string, unknown>;
}

export interface A2ATaskStatus {
  state: A2ATaskState;
  timestamp: string;
  message?: string;
  errorCode?: string;
}

export interface A2AArtifact {
  artifactId: string;
  parts: A2APart[];
  metadata?: Record<string, unknown>;
}

export interface A2ATask {
  id: string;
  contextId: string;
  status: A2ATaskStatus;
  artifacts?: A2AArtifact[];
  history?: A2AMessage[];
  metadata?: Record<string, unknown>;
}

// Stream response types for SSE
export interface A2ATaskStatusUpdate {
  taskId: string;
  contextId: string;
  status: A2ATaskStatus;
}

export interface A2ATaskArtifactUpdate {
  taskId: string;
  contextId: string;
  artifact: A2AArtifact;
  append: boolean;
  lastChunk: boolean;
}

export type A2AStreamResponse =
  | { task: A2ATask }
  | { message: A2AMessage }
  | { statusUpdate: A2ATaskStatusUpdate }
  | { artifactUpdate: A2ATaskArtifactUpdate };

// ============================================================================
// JSON-RPC 2.0 Messages for A2A
// ============================================================================

export interface A2AJsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: unknown;
}

export interface A2AJsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

// A2A-specific JSON-RPC error codes
export const A2A_ERROR = {
  TASK_NOT_FOUND: -32001,
  TASK_NOT_CANCELABLE: -32002,
  PUSH_NOTIFICATION_UNSUPPORTED: -32003,
  UNSUPPORTED_OPERATION: -32004,
  CONTENT_TYPE_NOT_SUPPORTED: -32005,
  INVALID_AGENT_RESPONSE: -32006,
} as const;

// ============================================================================
// Request/Response types for each A2A method
// ============================================================================

export interface A2ASendMessageParams {
  message: A2AMessage;
  configuration?: {
    acceptedOutputModes?: string[];
    returnImmediately?: boolean;
    historyLength?: number;
    pushNotificationConfig?: Record<string, unknown>;
  };
  metadata?: Record<string, unknown>;
}

export interface A2ATaskQueryParams {
  id: string;
  historyLength?: number;
}

export interface A2AListTasksParams {
  contextId?: string;
  status?: A2ATaskState;
  pageSize?: number;
  pageToken?: string;
  historyLength?: number;
}

export interface A2AListTasksResult {
  tasks: A2ATask[];
  nextPageToken?: string;
  pageSize: number;
  totalSize: number;
}

export interface A2ATaskIdParams {
  id: string;
}

// ============================================================================
// JSON-RPC Method name constants
// ============================================================================

export const A2A_METHODS = {
  SEND_MESSAGE: 'message/send',
  SEND_MESSAGE_STREAM: 'message/stream',
  GET_TASK: 'tasks/get',
  LIST_TASKS: 'tasks/list',
  CANCEL_TASK: 'tasks/cancel',
  RESUBSCRIBE: 'tasks/resubscribe',
  GET_AGENT_CARD: 'agent/getCard',
} as const;

// Well-known agent card path
export const AGENT_CARD_WELL_KNOWN_PATH = '/.well-known/agent-card.json';
export const A2A_VERSION_HEADER = 'A2A-Version';
export const A2A_PROTOCOL_VERSION = '1.0';
