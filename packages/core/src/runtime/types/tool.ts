// ============================================================================
// Tool System
// ============================================================================

import type { AgentExecutionContext } from './execution';

/**
 * Definition of a tool an agent can call.
 * Enhanced with BFCL-compatible fields for precise function calling.
 */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Examples of valid tool calls for few-shot disambiguation */
  examples?: Array<{ name: string; arguments: Record<string, unknown> }>;
  /** Category hint for tool selection disambiguation */
  category?: string;
  /** Whether this tool should be hidden from general-purpose models (specialized) */
  hidden?: boolean;
  /** Side-effect classification for taint tracking and security gates.
   *  - 'none': pure read, no state change
   *  - 'local_state': writes to local filesystem / DB / in-process state
   *  - 'external_egress': sends data to an external system (HTTP, email, webhook, A2A, MCP-egress)
   *
   * Fallback strategy (undefined riskMetadata):
   *   - Read operations → treated as 'none' (don't bump taint tier)
   *   - Write/Execute operations → treated as 'local_state' (bump to LOCAL_DIRTY, no outbound block)
   * This asymmetric default avoids false positives on third-party MCP tools
   * while forcing tool authors to explicitly declare 'external_egress'. */
  riskMetadata?: {
    sideEffect: 'none' | 'local_state' | 'external_egress';
  };
}

/**
 * A tool call made by the LLM.
 */
export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/**
 * Result of executing a tool.
 */
export interface ToolResult {
  toolCallId: string;
  name: string;
  output: string;
  error?: string;
  durationMs: number;
  /** True if this result was served from idempotency cache, not freshly executed. */
  fromCache?: boolean;
}

/**
 * Interface for a tool that can be executed.
 * Safety flags control concurrent execution and execution behavior.
 */
export interface IdempotencyKeyContext {
  runId: string;
  stepId: string;
}

export interface Tool {
  definition: ToolDefinition;
  execute(args: Record<string, unknown>, ctx?: AgentExecutionContext): Promise<string>;
  /** If true, tool can run in parallel with other concurrent-safe tools. Default: false */
  isConcurrencySafe?: boolean;
  /** If true, tool only reads state (no side effects). Allows speculative execution. Default: false */
  isReadOnly?: boolean;
  /** Max execution time in ms. 0 = no limit. Default: 0 */
  timeout?: number;
  /** Max output size in chars. Larger outputs are truncated and linked to file. Default: 10000 */
  maxOutputSize?: number;
  /** Compiled schema for runtime validation (populated by ToolRegistry) */
  compiledSchema?: CompiledSchema;
  /** True if tool call is safe to replay: same args + same run + same step → cached result. */
  isIdempotent?: boolean;
  /** Static or function-derivable key for ATR idempotency cache. Overrides default SHA-256 derivation. */
  idempotencyKey?: string | ((args: Record<string, unknown>, ctx: IdempotencyKeyContext) => string);
  /** External system this tool touches (e.g. 'github', 'stripe', 'shell'). For audit + safety gates. */
  externalSystem?: string;
  /** Risk level: 'low' (read), 'medium' (idempotent write), 'high' (destructive). Default: 'medium'. */
  riskLevel?: 'low' | 'medium' | 'high';
  /** If true, tool can have irreversible side effects and requires explicit user approval. Default: false */
  destructive?: boolean;
  /** Reversibility classification for compensation planning. 'reversible' = undo available, 'semi-reversible' = partial undo possible, 'irreversible' = no undo (e.g., send email, external API call). Default: 'semi-reversible'. */
  reversibility?: 'reversible' | 'semi-reversible' | 'irreversible';
}

/**
 * Compiled (pre-processed) JSON Schema for fast runtime validation.
 * Created once at tool registration time via compileSchema().
 */
export interface CompiledSchema {
  requiredFields: string[];
  propertyTypes: Map<string, string>;
  propertyEnums: Map<string, unknown[]>;
  propertyConstraints: Map<string, { minimum?: number; maximum?: number }>;
  defaults: Map<string, unknown>;
  raw: Record<string, unknown>;
}

/**
 * Result of validating tool call arguments against a compiled schema.
 */
export interface ValidationResult {
  valid: boolean;
  errors: Array<{
    path: string;
    message: string;
    expectedType?: string;
    actualValue?: unknown;
    suggestion?: string;
  }>;
  repairedArgs?: Record<string, unknown>;
  repairs?: string[];
}
