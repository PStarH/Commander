/**
 * A2A v1.0 Protocol Compliance Types
 * Based on a2aproject/A2A specification v1.0
 * Covers: AgentCard, Task lifecycle, Message, JSON-RPC 2.0, SSE streaming
 */
export type A2ATaskState = 'SUBMITTED' | 'WORKING' | 'COMPLETED' | 'FAILED' | 'CANCELED' | 'INPUT_REQUIRED' | 'REJECTED' | 'AUTH_REQUIRED';
export declare const A2A_TERMINAL_STATES: ReadonlySet<A2ATaskState>;
export declare const A2A_INTERRUPTED_STATES: ReadonlySet<A2ATaskState>;
export declare function canTransition(from: A2ATaskState, to: A2ATaskState): boolean;
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
export type A2APart = {
    type: 'text';
    text: string;
} | {
    type: 'file';
    file: {
        uri?: string;
        mimeType: string;
        name?: string;
    };
    content?: Uint8Array;
} | {
    type: 'data';
    data: Record<string, unknown>;
};
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
export type A2AStreamResponse = {
    task: A2ATask;
} | {
    message: A2AMessage;
} | {
    statusUpdate: A2ATaskStatusUpdate;
} | {
    artifactUpdate: A2ATaskArtifactUpdate;
};
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
    error?: {
        code: number;
        message: string;
        data?: unknown;
    };
}
export declare const A2A_ERROR: {
    readonly TASK_NOT_FOUND: -32001;
    readonly TASK_NOT_CANCELABLE: -32002;
    readonly PUSH_NOTIFICATION_UNSUPPORTED: -32003;
    readonly UNSUPPORTED_OPERATION: -32004;
    readonly CONTENT_TYPE_NOT_SUPPORTED: -32005;
    readonly INVALID_AGENT_RESPONSE: -32006;
};
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
export declare const A2A_METHODS: {
    readonly SEND_MESSAGE: "message/send";
    readonly SEND_MESSAGE_STREAM: "message/stream";
    readonly GET_TASK: "tasks/get";
    readonly LIST_TASKS: "tasks/list";
    readonly CANCEL_TASK: "tasks/cancel";
    readonly RESUBSCRIBE: "tasks/resubscribe";
    readonly GET_AGENT_CARD: "agent/getCard";
};
export declare const AGENT_CARD_WELL_KNOWN_PATH = "/.well-known/agent-card.json";
export declare const A2A_VERSION_HEADER = "A2A-Version";
export declare const A2A_PROTOCOL_VERSION = "1.0";
//# sourceMappingURL=a2aCompliance.d.ts.map