/**
 * API Error Standardization
 *
 * Implements RFC 7807 Problem Details for HTTP APIs to provide
 * consistent, machine-readable error responses across all endpoints.
 *
 * Standard error response format:
 *   Content-Type: application/problem+json
 *   {
 *     "type": "https://commander.dev/errors/validation",
 *     "title": "Validation Error",
 *     "status": 400,
 *     "detail": "Field 'prompt' is required",
 *     "instance": "/api/v1/execute",
 *     "code": "VALIDATION_ERROR",
 *     "requestId": "req_abc123",
 *     "errors": [{ "field": "prompt", "message": "is required" }]
 *   }
 */

import type { IncomingMessage, ServerResponse } from 'http';

// ============================================================================
// Types
// ============================================================================

export interface ProblemDetail {
  /** A URI reference identifying the problem type */
  type: string;
  /** Short, human-readable summary */
  title: string;
  /** HTTP status code */
  status: number;
  /** Human-readable explanation specific to this occurrence */
  detail: string;
  /** URI identifying the specific occurrence (usually the request path) */
  instance: string;
  /** Machine-readable error code for programmatic handling */
  code: string;
  /** Request ID for tracing */
  requestId?: string;
  /** Field-level validation errors */
  errors?: FieldError[];
  /** Additional context */
  [key: string]: unknown;
}

export interface FieldError {
  field: string;
  message: string;
  code: string;
  value?: unknown;
}

// ============================================================================
// Error Codes
// ============================================================================

export const ErrorCodes = {
  // 400 Bad Request
  VALIDATION_ERROR: { code: 'VALIDATION_ERROR', title: 'Validation Error', status: 400 },
  INVALID_JSON: { code: 'INVALID_JSON', title: 'Invalid JSON', status: 400 },
  MISSING_FIELD: { code: 'MISSING_FIELD', title: 'Missing Required Field', status: 400 },
  INVALID_FIELD_VALUE: { code: 'INVALID_FIELD_VALUE', title: 'Invalid Field Value', status: 400 },

  // 401 Unauthorized
  UNAUTHORIZED: { code: 'UNAUTHORIZED', title: 'Unauthorized', status: 401 },
  INVALID_API_KEY: { code: 'INVALID_API_KEY', title: 'Invalid API Key', status: 401 },
  TOKEN_EXPIRED: { code: 'TOKEN_EXPIRED', title: 'Token Expired', status: 401 },

  // 403 Forbidden
  FORBIDDEN: { code: 'FORBIDDEN', title: 'Forbidden', status: 403 },
  INSUFFICIENT_PERMISSIONS: { code: 'INSUFFICIENT_PERMISSIONS', title: 'Insufficient Permissions', status: 403 },

  // 404 Not Found
  NOT_FOUND: { code: 'NOT_FOUND', title: 'Not Found', status: 404 },
  RUNTIME_NOT_FOUND: { code: 'RUNTIME_NOT_FOUND', title: 'Runtime Not Found', status: 404 },
  RESOURCE_NOT_FOUND: { code: 'RESOURCE_NOT_FOUND', title: 'Resource Not Found', status: 404 },

  // 405 Method Not Allowed
  METHOD_NOT_ALLOWED: { code: 'METHOD_NOT_ALLOWED', title: 'Method Not Allowed', status: 405 },

  // 409 Conflict
  CONFLICT: { code: 'CONFLICT', title: 'Conflict', status: 409 },
  DUPLICATE_RESOURCE: { code: 'DUPLICATE_RESOURCE', title: 'Duplicate Resource', status: 409 },

  // 413 Payload Too Large
  PAYLOAD_TOO_LARGE: { code: 'PAYLOAD_TOO_LARGE', title: 'Payload Too Large', status: 413 },

  // 429 Too Many Requests
  RATE_LIMITED: { code: 'RATE_LIMITED', title: 'Rate Limited', status: 429 },

  // 500 Internal Server Error
  INTERNAL_ERROR: { code: 'INTERNAL_ERROR', title: 'Internal Server Error', status: 500 },
  PROVIDER_ERROR: { code: 'PROVIDER_ERROR', title: 'Provider Error', status: 500 },
  EXECUTION_FAILED: { code: 'EXECUTION_FAILED', title: 'Execution Failed', status: 500 },

  // 503 Service Unavailable
  SERVICE_UNAVAILABLE: { code: 'SERVICE_UNAVAILABLE', title: 'Service Unavailable', status: 503 },
  SHUTTING_DOWN: { code: 'SHUTTING_DOWN', title: 'Server Shutting Down', status: 503 },
} as const;

export type ErrorCode = keyof typeof ErrorCodes;

// ============================================================================
// Problem Details Builder
// ============================================================================

const ERROR_TYPE_BASE = 'https://commander.dev/errors';

/**
 * Create a ProblemDetail object.
 */
export function createProblem(
  code: ErrorCode,
  detail: string,
  options: {
    instance?: string;
    requestId?: string;
    errors?: FieldError[];
    extensions?: Record<string, unknown>;
  } = {},
): ProblemDetail {
  const meta = ErrorCodes[code];
  return {
    type: `${ERROR_TYPE_BASE}/${meta.code.toLowerCase()}`,
    title: meta.title,
    status: meta.status,
    code: meta.code,
    detail,
    instance: options.instance ?? '',
    requestId: options.requestId,
    errors: options.errors,
    ...options.extensions,
  };
}

/**
 * Send a standardized error response.
 * Sets Content-Type to application/problem+json.
 */
export function sendProblem(
  res: ServerResponse,
  code: ErrorCode,
  detail: string,
  options: {
    instance?: string;
    requestId?: string;
    errors?: FieldError[];
    extraHeaders?: Record<string, string>;
    extensions?: Record<string, unknown>;
  } = {},
): void {
  const problem = createProblem(code, detail, options);
  const headers: Record<string, string> = {
    'Content-Type': 'application/problem+json; charset=utf-8',
    ...options.extraHeaders,
  };

  // Add Allow header for 405
  if (code === 'METHOD_NOT_ALLOWED' && options.extensions?.allowedMethods) {
    headers['Allow'] = options.extensions.allowedMethods as string;
  }

  // Add Retry-After for 429
  if (code === 'RATE_LIMITED' && options.extensions?.retryAfter) {
    headers['Retry-After'] = String(options.extensions.retryAfter);
  }

  res.writeHead(problem.status, headers);
  res.end(JSON.stringify(problem, null, 2));
}

/**
 * Wrap an unknown error into a ProblemDetail.
 * If the error is already an ApiError, use its code; otherwise 500.
 */
export function errorToProblem(
  err: unknown,
  instance: string,
  requestId?: string,
): ProblemDetail {
  if (err instanceof ApiError) {
    return createProblem(err.code, err.message, {
      instance,
      requestId,
      errors: err.fieldErrors,
      extensions: err.extensions,
    });
  }

  // HttpRequestError from existing codebase
  const anyErr = err as { statusCode?: number; message?: string };
  if (anyErr.statusCode && anyErr.message) {
    const code = statusToCode(anyErr.statusCode);
    return createProblem(code, anyErr.message, { instance, requestId });
  }

  return createProblem('INTERNAL_ERROR', (err as Error)?.message ?? 'An unexpected error occurred', {
    instance,
    requestId,
  });
}

/**
 * Map HTTP status code to error code.
 */
function statusToCode(status: number): ErrorCode {
  switch (status) {
    case 400: return 'VALIDATION_ERROR';
    case 401: return 'UNAUTHORIZED';
    case 403: return 'FORBIDDEN';
    case 404: return 'NOT_FOUND';
    case 405: return 'METHOD_NOT_ALLOWED';
    case 409: return 'CONFLICT';
    case 413: return 'PAYLOAD_TOO_LARGE';
    case 429: return 'RATE_LIMITED';
    case 503: return 'SERVICE_UNAVAILABLE';
    default: return 'INTERNAL_ERROR';
  }
}

// ============================================================================
// ApiError Class
// ============================================================================

/**
 * Throw this from handlers to produce a standardized error response.
 */
export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly fieldErrors?: FieldError[];
  readonly extensions?: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    message: string,
    options: {
      fieldErrors?: FieldError[];
      extensions?: Record<string, unknown>;
    } = {},
  ) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.statusCode = ErrorCodes[code].status;
    this.fieldErrors = options.fieldErrors;
    this.extensions = options.extensions;
  }

  static validation(fieldErrors: FieldError[], instance?: string): ApiError {
    return new ApiError('VALIDATION_ERROR', 'Request validation failed', { fieldErrors });
  }

  static notFound(resource: string): ApiError {
    return new ApiError('NOT_FOUND', `${resource} not found`);
  }

  static unauthorized(message = 'Authentication required'): ApiError {
    return new ApiError('UNAUTHORIZED', message);
  }

  static forbidden(message = 'Insufficient permissions'): ApiError {
    return new ApiError('FORBIDDEN', message);
  }

  static methodNotAllowed(allowedMethods: string): ApiError {
    return new ApiError('METHOD_NOT_ALLOWED', `Method not allowed. Allowed: ${allowedMethods}`, {
      extensions: { allowedMethods },
    });
  }

  static rateLimited(retryAfter: number): ApiError {
    return new ApiError('RATE_LIMITED', 'Rate limit exceeded', {
      extensions: { retryAfter },
    });
  }

  static internal(message: string): ApiError {
    return new ApiError('INTERNAL_ERROR', message);
  }
}
