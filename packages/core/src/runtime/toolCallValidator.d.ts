/**
 * Tool Call Argument Validator — Zero-Dependency JSON Schema Validation
 *
 * Validates LLM-generated arguments against tool inputSchema before execution.
 * Compiled once at tool registration time for <1ms per validation.
 *
 * Inspired by Hermes' multi-layer validation:
 * 1. Required field check
 * 2. Type check with safe coercion
 * 3. Enum validation
 * 4. Range clamping (minimum/maximum)
 * 5. Default injection
 */
import type { CompiledSchema, ValidationResult } from './types';
/**
 * Pre-process a JSON Schema into an optimized validation structure.
 * Called once at tool registration time, not per invocation.
 */
export declare function compileSchema(schema: Record<string, unknown>): CompiledSchema;
/**
 * Validate tool call arguments against a compiled schema.
 * Returns validation result with errors and optionally repaired args.
 */
export declare function validateToolCall(args: Record<string, unknown>, schema: CompiledSchema): ValidationResult;
/**
 * Format validation errors into a structured message for the LLM.
 * Designed for self-correction: the LLM should be able to read this
 * and retry with corrected arguments.
 */
export declare function formatValidationErrors(errors: ValidationResult['errors'], toolName: string, repairs?: string[]): string;
export interface ValidationErrorPayload {
    tool: string;
    valid: boolean;
    errors: Array<{
        path: string;
        message: string;
        expectedType?: string;
        actualValue?: unknown;
        suggestion?: string;
    }>;
    repairs: string[];
    repairedArgs?: Record<string, unknown>;
    retryHint: string;
}
/**
 * Format validation errors as a structured JSON payload (Tier 3.1).
 * LLMs can read JSON more reliably than free-form text and use the
 * `suggestion` field directly when regenerating the tool call.
 */
export declare function formatValidationErrorsJson(errors: ValidationResult['errors'], toolName: string, repairs?: string[], repairedArgs?: Record<string, unknown>): ValidationErrorPayload;
//# sourceMappingURL=toolCallValidator.d.ts.map