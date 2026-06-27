/**
 * Request Body Schema Validation
 *
 * Lightweight runtime validation without external dependencies (no zod/joi).
 * Uses a declarative schema format that mirrors OpenAPI 3.0 schema objects
 * so the same schema can serve both validation and documentation.
 *
 * Usage:
 *   const schema = {
 *     prompt: { type: 'string', required: true, minLength: 1, maxLength: 10000 },
 *     provider: { type: 'string', enum: ['openai', 'anthropic', 'google'] },
 *     maxTokens: { type: 'number', min: 1, max: 100000 },
 *   };
 *   const errors = validateBody(body, schema);
 *   if (errors.length > 0) throw ApiError.validation(errors);
 */

import type { FieldError } from './apiErrors';
import { ApiError } from './apiErrors';

// ============================================================================
// Schema Types
// ============================================================================

export interface FieldSchema {
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  required?: boolean;
  /** For strings */
  minLength?: number;
  maxLength?: number;
  pattern?: RegExp;
  enum?: unknown[];
  /** For numbers */
  min?: number;
  max?: number;
  /** For arrays */
  items?: FieldSchema;
  minItems?: number;
  maxItems?: number;
  /** For objects — nested schema */
  properties?: Record<string, FieldSchema>;
  /** Allow additional properties not in schema */
  additionalProperties?: boolean;
  /** Custom validator */
  validate?: (value: unknown) => string | null;
}

export type Schema = Record<string, FieldSchema>;

// ============================================================================
// Validator
// ============================================================================

/**
 * Validate a request body against a schema.
 * Returns an array of field errors (empty if valid).
 */
export function validateBody(body: unknown, schema: Schema): FieldError[] {
  const errors: FieldError[] = [];

  if (body === null || body === undefined) {
    // Check if any required field exists
    for (const [field, fieldSchema] of Object.entries(schema)) {
      if (fieldSchema.required) {
        errors.push({ field, message: 'is required', code: 'MISSING_FIELD' });
      }
    }
    return errors;
  }

  if (typeof body !== 'object' || Array.isArray(body)) {
    errors.push({ field: '_root', message: 'body must be a JSON object', code: 'INVALID_TYPE' });
    return errors;
  }

  const obj = body as Record<string, unknown>;

  for (const [field, fieldSchema] of Object.entries(schema)) {
    const value = obj[field];

    // Check required
    if (value === undefined || value === null) {
      if (fieldSchema.required) {
        errors.push({ field, message: 'is required', code: 'MISSING_FIELD' });
      }
      continue;
    }

    // Type check
    const typeError = checkType(field, value, fieldSchema);
    if (typeError) {
      errors.push(typeError);
      continue;
    }

    // Type-specific validation
    switch (fieldSchema.type) {
      case 'string':
        validateString(field, value as string, fieldSchema, errors);
        break;
      case 'number':
        validateNumber(field, value as number, fieldSchema, errors);
        break;
      case 'boolean':
        // Type already checked
        break;
      case 'array':
        validateArray(field, value as unknown[], fieldSchema, errors);
        break;
      case 'object':
        validateObject(field, value as Record<string, unknown>, fieldSchema, errors);
        break;
    }

    // Enum check
    if (fieldSchema.enum && !fieldSchema.enum.includes(value)) {
      errors.push({
        field,
        message: `must be one of: ${fieldSchema.enum.map((v) => JSON.stringify(v)).join(', ')}`,
        code: 'INVALID_ENUM',
        value,
      });
    }

    // Custom validator
    if (fieldSchema.validate) {
      const customError = fieldSchema.validate(value);
      if (customError) {
        errors.push({ field, message: customError, code: 'CUSTOM_VALIDATION' });
      }
    }
  }

  return errors;
}

/**
 * Validate and return the body or throw an ApiError.
 */
export function validateOrThrow<T = Record<string, unknown>>(
  body: unknown,
  schema: Schema,
): T {
  const errors = validateBody(body, schema);
  if (errors.length > 0) {
    throw ApiError.validation(errors);
  }
  return body as T;
}

// ============================================================================
// Pre-defined Schemas for Common Endpoints
// ============================================================================

export const Schemas = {
  /**
   * POST /api/v1/execute
   */
  execute: {
    prompt: {
      type: 'string' as const,
      required: true,
      minLength: 1,
      maxLength: 50000,
    },
    provider: {
      type: 'string' as const,
      enum: ['openai', 'anthropic', 'google', 'openrouter', 'deepseek', 'glm', 'mimo', 'xiaomi', 'ollama', 'vllm', 'cohere'],
    },
    model: { type: 'string' as const, maxLength: 200 },
    maxTokens: { type: 'number' as const, min: 1, max: 1000000 },
    temperature: { type: 'number' as const, min: 0, max: 2 },
    runtimeId: { type: 'string' as const, maxLength: 100 },
    tools: {
      type: 'array' as const,
      items: { type: 'string' as const, maxLength: 100 },
      maxItems: 100,
    },
  },

  /**
   * POST /api/v1/runtime
   */
  createRuntime: {
    provider: {
      type: 'string' as const,
      required: true,
      enum: ['openai', 'anthropic', 'google', 'openrouter', 'deepseek', 'glm', 'mimo', 'xiaomi', 'ollama', 'vllm', 'cohere'],
    },
    model: { type: 'string' as const, maxLength: 200 },
    apiKey: { type: 'string' as const, maxLength: 500 },
    systemPrompt: { type: 'string' as const, maxLength: 10000 },
    maxTokens: { type: 'number' as const, min: 1, max: 1000000 },
  },

  /**
   * POST /api/v1/memory (action: write)
   */
  memoryWrite: {
    action: {
      type: 'string' as const,
      required: true,
      enum: ['write', 'query', 'stats'],
    },
    content: {
      type: 'string' as const,
      maxLength: 100000,
      validate: (value: unknown) => {
        // content is required when action is 'write'
        if (typeof value === 'string' && value.length === 0) {
          return 'content must not be empty for write action';
        }
        return null;
      },
    },
    importance: { type: 'number' as const, min: 0, max: 1 },
    layer: {
      type: 'string' as const,
      enum: ['session', 'project', 'global'],
    },
    tags: {
      type: 'array' as const,
      items: { type: 'string' as const, maxLength: 50 },
      maxItems: 20,
    },
  },

  /**
   * POST /api/v1/plan
   */
  plan: {
    task: {
      type: 'string' as const,
      required: true,
      minLength: 1,
      maxLength: 10000,
    },
    projectId: { type: 'string' as const, maxLength: 100 },
    agentId: { type: 'string' as const, maxLength: 100 },
    constraints: {
      type: 'object' as const,
      properties: {
        maxDuration: { type: 'number' as const, min: 1 },
        maxCost: { type: 'number' as const, min: 0 },
        maxSteps: { type: 'number' as const, min: 1, max: 1000 },
      },
    },
  },

  /**
   * POST /api/v1/atr/runs
   */
  atrRun: {
    goal: {
      type: 'string' as const,
      required: true,
      minLength: 1,
      maxLength: 10000,
    },
    projectId: { type: 'string' as const, maxLength: 100 },
    provider: {
      type: 'string' as const,
      enum: ['openai', 'anthropic', 'google', 'openrouter', 'deepseek', 'glm', 'mimo', 'xiaomi', 'ollama', 'vllm', 'cohere'],
    },
    model: { type: 'string' as const, maxLength: 200 },
  },

  /**
   * POST /alerts/rules
   */
  alertRule: {
    name: { type: 'string' as const, required: true, minLength: 1, maxLength: 200 },
    description: { type: 'string' as const, maxLength: 1000 },
    metric: { type: 'string' as const, required: true, minLength: 1, maxLength: 100 },
    condition: {
      type: 'string' as const,
      required: true,
      enum: ['gt', 'gte', 'lt', 'lte', 'eq', 'neq'],
    },
    threshold: { type: 'number' as const, required: true },
    severity: {
      type: 'string' as const,
      required: true,
      enum: ['info', 'warning', 'critical', 'page'],
    },
    channels: {
      type: 'array' as const,
      items: { type: 'string' as const, maxLength: 50 },
      maxItems: 10,
    },
    forDurationMs: { type: 'number' as const, min: 0, max: 86400000 },
    autoResolveAfterMs: { type: 'number' as const, min: 0, max: 86400000 },
    enabled: { type: 'boolean' as const },
  },

  /**
   * POST /incidents
   */
  incident: {
    title: { type: 'string' as const, required: true, minLength: 1, maxLength: 500 },
    severity: {
      type: 'string' as const,
      required: true,
      enum: ['SEV1', 'SEV2', 'SEV3', 'SEV4'],
    },
    affectedComponents: {
      type: 'array' as const,
      items: { type: 'string' as const, maxLength: 100 },
      maxItems: 20,
    },
  },
} satisfies Record<string, Schema>;

// ============================================================================
// Private Validators
// ============================================================================

function checkType(field: string, value: unknown, schema: FieldSchema): FieldError | null {
  const actualType = Array.isArray(value) ? 'array' : typeof value;
  if (actualType !== schema.type) {
    return {
      field,
      message: `must be of type ${schema.type}, got ${actualType}`,
      code: 'INVALID_TYPE',
      value,
    };
  }
  return null;
}

function validateString(
  field: string,
  value: string,
  schema: FieldSchema,
  errors: FieldError[],
): void {
  if (schema.minLength !== undefined && value.length < schema.minLength) {
    errors.push({
      field,
      message: `must be at least ${schema.minLength} characters`,
      code: 'TOO_SHORT',
      value,
    });
  }
  if (schema.maxLength !== undefined && value.length > schema.maxLength) {
    errors.push({
      field,
      message: `must be at most ${schema.maxLength} characters`,
      code: 'TOO_LONG',
      value,
    });
  }
  if (schema.pattern && !schema.pattern.test(value)) {
    errors.push({
      field,
      message: `does not match required pattern`,
      code: 'PATTERN_MISMATCH',
      value,
    });
  }
}

function validateNumber(
  field: string,
  value: number,
  schema: FieldSchema,
  errors: FieldError[],
): void {
  if (schema.min !== undefined && value < schema.min) {
    errors.push({
      field,
      message: `must be >= ${schema.min}`,
      code: 'TOO_SMALL',
      value,
    });
  }
  if (schema.max !== undefined && value > schema.max) {
    errors.push({
      field,
      message: `must be <= ${schema.max}`,
      code: 'TOO_LARGE',
      value,
    });
  }
}

function validateArray(
  field: string,
  value: unknown[],
  schema: FieldSchema,
  errors: FieldError[],
): void {
  if (schema.minItems !== undefined && value.length < schema.minItems) {
    errors.push({
      field,
      message: `must have at least ${schema.minItems} items`,
      code: 'TOO_FEW_ITEMS',
    });
  }
  if (schema.maxItems !== undefined && value.length > schema.maxItems) {
    errors.push({
      field,
      message: `must have at most ${schema.maxItems} items`,
      code: 'TOO_MANY_ITEMS',
    });
  }
  if (schema.items) {
    for (let i = 0; i < value.length; i++) {
      const itemError = checkType(`${field}[${i}]`, value[i], schema.items);
      if (itemError) {
        errors.push(itemError);
      }
    }
  }
}

function validateObject(
  field: string,
  value: Record<string, unknown>,
  schema: FieldSchema,
  errors: FieldError[],
): void {
  if (schema.properties) {
    for (const [subField, subSchema] of Object.entries(schema.properties)) {
      const subValue = value[subField];
      const fullField = `${field}.${subField}`;
      if (subValue === undefined) {
        if (subSchema.required) {
          errors.push({
            field: fullField,
            message: 'is required',
            code: 'MISSING_FIELD',
          });
        }
        continue;
      }
      const typeError = checkType(fullField, subValue, subSchema);
      if (typeError) {
        errors.push(typeError);
        continue;
      }
      // Recursively validate the sub-field
      switch (subSchema.type) {
        case 'string':
          validateString(fullField, subValue as string, subSchema, errors);
          break;
        case 'number':
          validateNumber(fullField, subValue as number, subSchema, errors);
          break;
        case 'array':
          validateArray(fullField, subValue as unknown[], subSchema, errors);
          break;
        case 'object':
          validateObject(fullField, subValue as Record<string, unknown>, subSchema, errors);
          break;
      }
      if (subSchema.enum && !subSchema.enum.includes(subValue)) {
        errors.push({
          field: fullField,
          message: `must be one of: ${subSchema.enum.map((v) => JSON.stringify(v)).join(', ')}`,
          code: 'INVALID_ENUM',
          value: subValue,
        });
      }
    }
  }
}
