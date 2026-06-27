/**
 * API Stability & Versioning Tests
 *
 * Verifies:
 *   1. API version manager: version parsing, endpoint registration, deprecation
 *   2. Error standardization: RFC 7807 Problem Details format
 *   3. Schema validation: all predefined schemas reject invalid input
 *   4. Backward compatibility: v1 endpoints remain functional
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  APIVersionManager,
  resetAPIVersionManager,
  getAPIVersionManager,
  DEFAULT_VERSION_CONFIG,
} from '../../src/runtime/apiVersioning';
import {
  createProblem,
  sendProblem,
  ApiError,
  errorToProblem,
  ErrorCodes,
} from '../../src/runtime/apiErrors';
import {
  validateBody,
  validateOrThrow,
  Schemas,
} from '../../src/runtime/apiValidation';
import type { ServerResponse, IncomingMessage } from 'http';

// ============================================================================
// Mock helpers
// ============================================================================

function mockResponse(): { res: ServerResponse; body: string; statusCode: number; headers: Record<string, string> } {
  const state = { body: '', statusCode: 0, headers: {} as Record<string, string> };
  const res = {
    writeHead: (code: number, hdrs?: Record<string, string>) => {
      state.statusCode = code;
      if (hdrs) Object.assign(state.headers, hdrs);
    },
    end: (data?: string) => { state.body = data ?? ''; },
    setHeader: () => {},
  } as unknown as ServerResponse;
  return { res, get body() { return state.body; }, get statusCode() { return state.statusCode; }, get headers() { return state.headers; } };
}

// ============================================================================
// API Version Manager Tests
// ============================================================================

describe('APIVersionManager', () => {
  let mgr: APIVersionManager;

  beforeEach(() => {
    resetAPIVersionManager();
    mgr = new APIVersionManager();
  });

  afterEach(() => {
    resetAPIVersionManager();
  });

  it('should parse version from /api/v1/ path', () => {
    const result = mgr.parseVersionFromPath('/api/v1/execute');
    expect(result).toEqual({ version: 1, remainingPath: '/execute' });
  });

  it('should parse version from /api/v2/ path', () => {
    mgr.registerVersion({ major: 2, stability: 'beta', releasedAt: '2026-06-01' });
    const result = mgr.parseVersionFromPath('/api/v2/plan');
    expect(result).toEqual({ version: 2, remainingPath: '/plan' });
  });

  it('should handle unversioned paths with default version', () => {
    const result = mgr.parseVersionFromPath('/api/execute');
    expect(result).toEqual({ version: 1, remainingPath: '/execute' });
  });

  it('should return null for non-API paths', () => {
    expect(mgr.parseVersionFromPath('/health')).toBeNull();
    expect(mgr.parseVersionFromPath('/metrics')).toBeNull();
  });

  it('should register and retrieve endpoints', () => {
    mgr.registerEndpoint({
      method: 'POST',
      path: '/api/v1/execute',
      stability: 'stable',
      version: 1,
      description: 'Execute agent task',
    });

    const endpoint = mgr.getEndpoint('POST', '/api/v1/execute');
    expect(endpoint).toBeDefined();
    expect(endpoint?.stability).toBe('stable');
    expect(endpoint?.version).toBe(1);
  });

  it('should list endpoints with filters', () => {
    mgr.registerEndpoint({ method: 'POST', path: '/api/v1/execute', stability: 'stable', version: 1, description: '' });
    mgr.registerEndpoint({ method: 'POST', path: '/api/v1/plan', stability: 'beta', version: 1, description: '' });
    mgr.registerEndpoint({ method: 'GET', path: '/api/v1/memory', stability: 'experimental', version: 1, description: '' });

    expect(mgr.listEndpoints({ stability: 'stable' })).toHaveLength(1);
    expect(mgr.listEndpoints({ stability: 'beta' })).toHaveLength(1);
    expect(mgr.listEndpoints()).toHaveLength(3);
  });

  it('should deprecate endpoints with Sunset and successor', () => {
    mgr.registerEndpoint({
      method: 'POST',
      path: '/api/v1/execute',
      stability: 'stable',
      version: 1,
      description: '',
    });

    const deprecated = mgr.deprecateEndpoint('POST', '/api/v1/execute', {
      sunsetAt: '2026-12-31',
      successorPath: '/api/v2/execute',
    });

    expect(deprecated).toBe(true);
    const endpoint = mgr.getEndpoint('POST', '/api/v1/execute');
    expect(endpoint?.stability).toBe('deprecated');
    expect(endpoint?.sunsetAt).toBe('2026-12-31');
    expect(endpoint?.successorPath).toBe('/api/v2/execute');
  });

  it('should generate deprecation headers', () => {
    mgr.registerEndpoint({
      method: 'POST',
      path: '/api/v1/execute',
      stability: 'stable',
      version: 1,
      description: '',
    });
    mgr.deprecateEndpoint('POST', '/api/v1/execute', {
      sunsetAt: '2026-12-31',
      successorPath: '/api/v2/execute',
    });

    const headers = mgr.getDeprecationHeaders('POST', '/api/v1/execute');
    expect(headers['Deprecation']).toBe('true');
    expect(headers['Sunset']).toBeDefined();
    expect(headers['Link']).toContain('successor-version');
    expect(headers['Warning']).toBeDefined();
  });

  it('should generate stability headers', () => {
    mgr.registerEndpoint({
      method: 'GET',
      path: '/api/v1/status',
      stability: 'stable',
      version: 1,
      description: '',
    });

    const headers = mgr.getStabilityHeaders('GET', '/api/v1/status');
    expect(headers['X-API-Version']).toBe('1');
    expect(headers['X-API-Stability']).toBe('stable');
  });

  it('should return empty headers for non-deprecated endpoints', () => {
    mgr.registerEndpoint({
      method: 'GET',
      path: '/api/v1/status',
      stability: 'stable',
      version: 1,
      description: '',
    });

    const headers = mgr.getDeprecationHeaders('GET', '/api/v1/status');
    expect(headers).toEqual({});
  });

  it('should track deprecated endpoint usage', () => {
    mgr.registerEndpoint({
      method: 'POST',
      path: '/api/v1/execute',
      stability: 'deprecated',
      version: 1,
      description: '',
      sunsetAt: '2026-12-31',
    });

    mgr.recordRequest('POST', '/api/v1/execute');
    mgr.recordRequest('POST', '/api/v1/execute');

    const usage = mgr.getDeprecatedUsage();
    expect(usage).toHaveLength(1);
    expect(usage[0].requests).toBe(2);
    expect(usage[0].sunsetAt).toBe('2026-12-31');
  });

  it('should check version support', () => {
    expect(mgr.isVersionSupported(1)).toBe(true);
    expect(mgr.isVersionSupported(99)).toBe(false);
  });

  it('should register new versions', () => {
    mgr.registerVersion({ major: 2, stability: 'beta', releasedAt: '2026-06-01' });
    expect(mgr.isVersionSupported(2)).toBe(true);
    expect(mgr.getVersionInfo(2)?.stability).toBe('beta');
  });
});

describe('Global API Version Manager singleton', () => {
  beforeEach(() => resetAPIVersionManager());
  afterEach(() => resetAPIVersionManager());

  it('should auto-register default endpoints', () => {
    const mgr = getAPIVersionManager();
    const endpoints = mgr.listEndpoints();
    expect(endpoints.length).toBeGreaterThan(10);

    // Check stability tiers
    const stable = mgr.listEndpoints({ stability: 'stable' });
    const beta = mgr.listEndpoints({ stability: 'beta' });
    const experimental = mgr.listEndpoints({ stability: 'experimental' });
    expect(stable.length).toBeGreaterThan(0);
    expect(beta.length).toBeGreaterThan(0);
    expect(experimental.length).toBeGreaterThan(0);
  });

  it('should have /api/v1/execute as stable', () => {
    const mgr = getAPIVersionManager();
    const endpoint = mgr.getEndpoint('POST', '/api/v1/execute');
    expect(endpoint).toBeDefined();
    expect(endpoint?.stability).toBe('stable');
  });
});

// ============================================================================
// Error Standardization Tests
// ============================================================================

describe('API Error Standardization (RFC 7807)', () => {
  it('should create ProblemDetail with correct fields', () => {
    const problem = createProblem('VALIDATION_ERROR', 'Field prompt is required', {
      instance: '/api/v1/execute',
      requestId: 'req_123',
    });

    expect(problem.type).toBe('https://commander.dev/errors/validation_error');
    expect(problem.title).toBe('Validation Error');
    expect(problem.status).toBe(400);
    expect(problem.code).toBe('VALIDATION_ERROR');
    expect(problem.detail).toBe('Field prompt is required');
    expect(problem.instance).toBe('/api/v1/execute');
    expect(problem.requestId).toBe('req_123');
  });

  it('should send problem response with correct Content-Type', () => {
    const mock = mockResponse();

    sendProblem(mock.res, 'NOT_FOUND', 'Runtime not found', {
      instance: '/api/v1/runtime/abc',
    });

    expect(mock.statusCode).toBe(404);
    expect(mock.headers['Content-Type']).toContain('application/problem+json');
    const parsed = JSON.parse(mock.body);
    expect(parsed.code).toBe('NOT_FOUND');
    expect(parsed.status).toBe(404);
  });

  it('should send 405 with Allow header', () => {
    const mock = mockResponse();

    sendProblem(mock.res, 'METHOD_NOT_ALLOWED', 'POST not allowed', {
      extensions: { allowedMethods: 'GET, DELETE' },
    });

    expect(mock.headers['Allow']).toBe('GET, DELETE');
  });

  it('should send 429 with Retry-After header', () => {
    const mock = mockResponse();

    sendProblem(mock.res, 'RATE_LIMITED', 'Rate limit exceeded', {
      extensions: { retryAfter: 60 },
    });

    expect(mock.headers['Retry-After']).toBe('60');
  });

  it('should create ApiError with proper code and status', () => {
    const err = new ApiError('UNAUTHORIZED', 'Invalid API key');
    expect(err.code).toBe('UNAUTHORIZED');
    expect(err.statusCode).toBe(401);
    expect(err.message).toBe('Invalid API key');
  });

  it('should support ApiError factory methods', () => {
    const validation = ApiError.validation([{ field: 'prompt', message: 'is required', code: 'MISSING_FIELD' }]);
    expect(validation.statusCode).toBe(400);
    expect(validation.fieldErrors).toHaveLength(1);

    const notFound = ApiError.notFound('Runtime');
    expect(notFound.statusCode).toBe(404);

    const methodNotAllowed = ApiError.methodNotAllowed('GET, DELETE');
    expect(methodNotAllowed.statusCode).toBe(405);
    expect(methodNotAllowed.extensions?.allowedMethods).toBe('GET, DELETE');

    const rateLimited = ApiError.rateLimited(30);
    expect(rateLimited.statusCode).toBe(429);
    expect(rateLimited.extensions?.retryAfter).toBe(30);
  });

  it('should convert unknown errors to ProblemDetail', () => {
    const problem = errorToProblem(new Error('Something went wrong'), '/api/v1/execute', 'req_123');
    expect(problem.status).toBe(500);
    expect(problem.code).toBe('INTERNAL_ERROR');
    expect(problem.detail).toBe('Something went wrong');
  });

  it('should convert ApiError to ProblemDetail', () => {
    const err = ApiError.notFound('Runtime');
    const problem = errorToProblem(err, '/api/v1/runtime/abc', 'req_456');
    expect(problem.status).toBe(404);
    expect(problem.code).toBe('NOT_FOUND');
  });

  it('should have all standard error codes defined', () => {
    const codes = Object.keys(ErrorCodes);
    // 400-level
    expect(codes).toContain('VALIDATION_ERROR');
    expect(codes).toContain('INVALID_JSON');
    expect(codes).toContain('UNAUTHORIZED');
    expect(codes).toContain('FORBIDDEN');
    expect(codes).toContain('NOT_FOUND');
    expect(codes).toContain('METHOD_NOT_ALLOWED');
    expect(codes).toContain('RATE_LIMITED');
    expect(codes).toContain('PAYLOAD_TOO_LARGE');
    // 500-level
    expect(codes).toContain('INTERNAL_ERROR');
    expect(codes).toContain('SERVICE_UNAVAILABLE');
  });
});

// ============================================================================
// Schema Validation Tests
// ============================================================================

describe('Schema Validation', () => {
  it('should validate execute schema with valid input', () => {
    const errors = validateBody({
      prompt: 'Hello, world!',
      provider: 'openai',
      model: 'gpt-4',
    }, Schemas.execute);
    expect(errors).toHaveLength(0);
  });

  it('should reject execute schema without prompt', () => {
    const errors = validateBody({
      provider: 'openai',
    }, Schemas.execute);
    expect(errors).toHaveLength(1);
    expect(errors[0].field).toBe('prompt');
    expect(errors[0].code).toBe('MISSING_FIELD');
  });

  it('should reject execute with empty prompt', () => {
    const errors = validateBody({
      prompt: '',
    }, Schemas.execute);
    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe('TOO_SHORT');
  });

  it('should reject execute with invalid provider', () => {
    const errors = validateBody({
      prompt: 'test',
      provider: 'invalid-provider',
    }, Schemas.execute);
    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe('INVALID_ENUM');
  });

  it('should reject execute with too many tokens', () => {
    const errors = validateBody({
      prompt: 'test',
      maxTokens: 2000000,
    }, Schemas.execute);
    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe('TOO_LARGE');
  });

  it('should validate createRuntime schema', () => {
    const errors = validateBody({
      provider: 'anthropic',
      model: 'claude-3',
    }, Schemas.createRuntime);
    expect(errors).toHaveLength(0);

    const errors2 = validateBody({}, Schemas.createRuntime);
    expect(errors2).toHaveLength(1);
    expect(errors2[0].field).toBe('provider');
  });

  it('should validate plan schema', () => {
    const errors = validateBody({
      task: 'Analyze the system',
    }, Schemas.plan);
    expect(errors).toHaveLength(0);

    const errors2 = validateBody({}, Schemas.plan);
    expect(errors2).toHaveLength(1);
    expect(errors2[0].field).toBe('task');
  });

  it('should validate alertRule schema', () => {
    const errors = validateBody({
      name: 'High latency',
      description: 'Test',
      metric: 'latency.p99_ms',
      condition: 'gt',
      threshold: 500,
      severity: 'warning',
      channels: ['slack'],
      forDurationMs: 0,
      autoResolveAfterMs: 5000,
      enabled: true,
    }, Schemas.alertRule);
    expect(errors).toHaveLength(0);
  });

  it('should reject alertRule with invalid condition', () => {
    const errors = validateBody({
      name: 'Test',
      metric: 'm',
      condition: 'invalid',
      threshold: 1,
      severity: 'warning',
    }, Schemas.alertRule);
    expect(errors.some((e) => e.field === 'condition' && e.code === 'INVALID_ENUM')).toBe(true);
  });

  it('should validate incident schema', () => {
    const errors = validateBody({
      title: 'Test incident',
      severity: 'SEV1',
    }, Schemas.incident);
    expect(errors).toHaveLength(0);

    const errors2 = validateBody({
      title: 'Test',
      severity: 'INVALID',
    }, Schemas.incident);
    expect(errors2.some((e) => e.field === 'severity')).toBe(true);
  });

  it('should validate or throw ApiError', () => {
    expect(() => validateOrThrow({ prompt: 'test' }, Schemas.execute)).not.toThrow();
    expect(() => validateOrThrow({}, Schemas.execute)).toThrow(ApiError);
  });

  it('should handle null body', () => {
    const errors = validateBody(null, Schemas.execute);
    expect(errors.some((e) => e.code === 'MISSING_FIELD')).toBe(true);
  });

  it('should handle non-object body', () => {
    const errors = validateBody('not an object', Schemas.execute);
    expect(errors.some((e) => e.code === 'INVALID_TYPE')).toBe(true);
  });

  it('should validate nested object properties', () => {
    const errors = validateBody({
      task: 'test',
      constraints: {
        maxSteps: -5, // invalid: min is 1
      },
    }, Schemas.plan);
    expect(errors.some((e) => e.code === 'TOO_SMALL')).toBe(true);
  });

  it('should validate array items', () => {
    const errors = validateBody({
      prompt: 'test',
      tools: ['valid', 'also-valid', 123], // 123 is not a string
    }, Schemas.execute);
    expect(errors.some((e) => e.code === 'INVALID_TYPE')).toBe(true);
  });
});

// ============================================================================
// Backward Compatibility Tests
// ============================================================================

describe('Backward Compatibility', () => {
  it('should support unversioned /api/ paths (defaults to v1)', () => {
    const mgr = new APIVersionManager();
    const result = mgr.parseVersionFromPath('/api/execute');
    expect(result?.version).toBe(1);
  });

  it('should keep v1 as default version', () => {
    const mgr = new APIVersionManager();
    expect(mgr.getDefaultVersion()).toBe(1);
  });

  it('should support all v1 stable endpoints', () => {
    const mgr = getAPIVersionManager();
    const stableEndpoints = mgr.listEndpoints({ stability: 'stable', version: 1 });
    const paths = stableEndpoints.map((e) => e.path);

    // Critical v1 endpoints that must remain stable
    expect(paths).toContain('/api/v1/execute');
    expect(paths).toContain('/api/v1/runtime');
    expect(paths).toContain('/api/v1/status');
    expect(paths).toContain('/api/v1/bus');
    expect(paths).toContain('/health');
    expect(paths).toContain('/ready');
    expect(paths).toContain('/metrics');
  });
});
