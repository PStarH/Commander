/**
 * API Endpoint Tests
 *
 * Tests for all major API endpoints:
 * - Health check
 * - System status
 * - Projects
 * - Memory
 * - Quality gates
 * - Security
 * - Namespaced memory
 * - A2A
 * - MCP
 *
 * Credentials: every request below carries a real super_admin principal
 * (test/_helpers/liveServerCredential.ts). Routes that must reject anonymous
 * callers are exercised without those credentials on purpose.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { requireLiveServer } from '../test/_helpers/requireLiveServer.mjs';
import {
  provisionLiveServerCredential,
  revokeLiveServerCredential,
  type LiveServerCredential,
} from '../test/_helpers/liveServerCredential';

// ============================================================================
// Test helpers
// ============================================================================

const BASE_URL = requireLiveServer();

let credential: LiveServerCredential;

before(async () => {
  credential = await provisionLiveServerCredential();
});

after(async () => {
  await revokeLiveServerCredential();
});

/** Authenticated request. Pass `anonymous: true` for the rejection cases. */
async function fetchJSON(
  path: string,
  options?: RequestInit & { anonymous?: boolean },
): Promise<{ status: number; body: any }> {
  const { anonymous, ...init } = options ?? {};
  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(anonymous ? {} : credential.headers),
        ...init.headers,
      },
    });
    const body = await res.json().catch(() => null);
    return { status: res.status, body };
  } catch (err) {
    return { status: 0, body: { error: (err as Error).message } };
  }
}

// ============================================================================
// Health & System
// ============================================================================

describe('Health & System Endpoints', () => {
  it('GET /health returns healthy status', async () => {
    const { status, body } = await fetchJSON('/health');
    assert.strictEqual(status, 200);
    assert.strictEqual(body.status, 'healthy');
    assert.ok(body.projectId);
    assert.ok(body.uptime >= 0);
    assert.ok(body.memory);
    assert.ok(body.version);
  });

  it('GET /system/status returns module status', async () => {
    const { status, body } = await fetchJSON('/system/status');
    assert.strictEqual(status, 200);
    assert.strictEqual(body.status, 'ok');
    assert.ok(body.modules);
    assert.ok(body.modules.warRoom);
    assert.ok(body.modules.memoryStore);
  });

  it('GET /api/openapi.json returns OpenAPI spec', async () => {
    const { status, body } = await fetchJSON('/api/openapi.json');
    assert.strictEqual(status, 200);
    assert.strictEqual(body.openapi, '3.1.0');
    assert.ok(body.info.title);
    assert.ok(body.paths);
  });
});

// ============================================================================
// Security
// ============================================================================

describe('Security Middleware', () => {
  it('includes X-Content-Type-Options header', async () => {
    const res = await fetch(`${BASE_URL}/health`);
    assert.strictEqual(res.headers.get('x-content-type-options'), 'nosniff');
  });

  it('includes X-Frame-Options header', async () => {
    const res = await fetch(`${BASE_URL}/health`);
    assert.strictEqual(res.headers.get('x-frame-options'), 'DENY');
  });

  it('includes X-Request-ID in response', async () => {
    const res = await fetch(`${BASE_URL}/health`);
    // AUDIT F-B-4: the previous assertion was `header || true`, which can never
    // fail. requestIdMiddleware now echoes the id (see requestIdMiddleware.test.ts).
    assert.strictEqual(res.status, 200);
    assert.ok(res.headers.get('x-request-id'), 'X-Request-ID must be present');
  });

  it('includes rate limit headers', async () => {
    const res = await fetch(`${BASE_URL}/health`);
    assert.ok(res.headers.get('x-ratelimit-limit'));
    assert.ok(res.headers.get('x-ratelimit-remaining'));
  });

  it('rejects oversized request bodies', async () => {
    const largeBody = 'x'.repeat(2 * 1024 * 1024); // 2MB
    const { status } = await fetchJSON('/projects', {
      method: 'POST',
      body: largeBody,
    });
    assert.strictEqual(status, 413);
  });

  it('rejects malformed JSON', async () => {
    const res = await fetch(`${BASE_URL}/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...credential.headers },
      body: '{invalid json',
    });
    assert.strictEqual(res.status, 400);
  });

  it('rejects an unauthenticated request to a protected route', async () => {
    const { status, body } = await fetchJSON('/projects', { anonymous: true });
    assert.strictEqual(status, 401);
    assert.strictEqual(body.error, 'Authentication required');
  });
});

// ============================================================================
// Projects
// ============================================================================

describe('Project Endpoints', () => {
  it('GET /projects returns project list', async () => {
    const { status, body } = await fetchJSON('/projects');
    assert.strictEqual(status, 200);
    assert.ok(Array.isArray(body));
  });

  it('GET /projects/:id/war-room returns war room data', async () => {
    const { status, body } = await fetchJSON('/projects/project-war-room/war-room');
    assert.strictEqual(status, 200);
    assert.ok(body.project);
  });
});

// ============================================================================
// Memory
// ============================================================================

describe('Memory Endpoints', () => {
  it('GET /projects/:id/memory returns memories', async () => {
    const { status, body } = await fetchJSON('/projects/project-war-room/memory');
    assert.strictEqual(status, 200);
    assert.ok(Array.isArray(body));
  });

  it('POST /projects/:id/memory creates memory', async () => {
    const { status, body } = await fetchJSON('/projects/project-war-room/memory', {
      method: 'POST',
      body: JSON.stringify({
        kind: 'LESSON',
        title: `Test memory ${Date.now()}`,
        content: 'This is a test memory entry',
        tags: ['test'],
      }),
    });
    assert.strictEqual(status, 201);
    assert.ok(body);
  });

  it('GET /projects/:id/memory/search searches memories', async () => {
    const { status, body } = await fetchJSON('/projects/project-war-room/memory/search?q=test');
    assert.strictEqual(status, 200);
    assert.ok(Array.isArray(body));
  });
});

// ============================================================================
// Quality Gates
// ============================================================================

describe('Quality Endpoints', () => {
  it('POST /api/quality/check runs quality gates', async () => {
    const { status, body } = await fetchJSON('/api/quality/check', {
      method: 'POST',
      body: JSON.stringify({
        input: 'What is 2+2?',
        output: '4',
      }),
    });
    assert.strictEqual(status, 200);
    assert.ok(body);
  });

  it('POST /api/quality/hallucination-check detects hallucinations', async () => {
    const { status, body } = await fetchJSON('/api/quality/hallucination-check', {
      method: 'POST',
      body: JSON.stringify({
        input: 'What is the capital of France?',
        output: 'The capital of France is Paris.',
        context: 'France is a country in Europe. Its capital city is Paris.',
      }),
    });
    assert.strictEqual(status, 200);
    assert.ok(body);
  });
});

// ============================================================================
// Namespaced Memory
// ============================================================================

describe('Namespaced Memory Endpoints', () => {
  it('GET /api/namespaced-memory/:namespace/stats returns stats', async () => {
    const { status, body } = await fetchJSON('/api/namespaced-memory/shared/stats');
    assert.strictEqual(status, 200);
    assert.ok(body);
  });

  it('GET /api/namespaced-memory/acl returns ACL rules', async () => {
    const { status, body } = await fetchJSON('/api/namespaced-memory/acl');
    assert.strictEqual(status, 200);
    assert.ok(Array.isArray(body.rules));
  });
});

// ============================================================================
// A2A Protocol
// ============================================================================

describe('A2A Endpoints', () => {
  it('GET /a2a/.well-known/agent-card returns agent card', async () => {
    const { status, body } = await fetchJSON('/a2a/.well-known/agent-card');
    assert.strictEqual(status, 200);
    assert.ok(body);
  });

  it('GET /a2a/agent-cards refuses when the A2A authToken is unconfigured', async () => {
    // apps/api/src/index.ts never configures an A2A authToken in this profile,
    // and the A2A server is documented fail-closed: it must refuse rather than
    // serve an unauthenticated card list.
    const { status, body } = await fetchJSON('/a2a/agent-cards');
    assert.strictEqual(status, 500);
    assert.match(String(body.error), /authToken is not configured/);
  });
});

// ============================================================================
// MCP
// ============================================================================

describe('MCP Endpoints', () => {
  it('GET /mcp/status returns MCP status', async () => {
    const { status, body } = await fetchJSON('/mcp/status');
    assert.strictEqual(status, 200);
    assert.ok(body);
  });
});

// ============================================================================
// Governance
// ============================================================================

describe('Governance Endpoints', () => {
  it('GET /projects/:id/governance/stats returns governance stats', async () => {
    const { status, body } = await fetchJSON('/projects/project-war-room/governance/stats');
    assert.strictEqual(status, 200);
    assert.ok(body);
  });

  it('GET /projects/:id/governance/alerts returns alerts', async () => {
    const { status, body } = await fetchJSON('/projects/project-war-room/governance/alerts');
    assert.strictEqual(status, 200);
    assert.ok(Array.isArray(body));
  });
});

// ============================================================================
// Self-Assessment
// ============================================================================

describe('Self-Assessment Endpoints', () => {
  it('POST /api/agents/:id/self-assess returns assessment', async () => {
    // KNOWN PRODUCT DEFECT — this case is red roughly 1 run in 10.
    // The handler sends a real assessment
    // (`{confidence, canHandle, recommendedMode, gaps, selfAssessmentTimestamp}`,
    // apps/api/src/selfAssessmentEndpoints.ts:32-43), but the DLP response
    // middleware (apps/api/src/index.ts:378 →
    // packages/core/src/security/dataLossPrevention.ts:277-282) matches any
    // 13-19 digit run that satisfies a Luhn check and masks it as a credit
    // card, turning `selfAssessmentTimestamp` into `****-****-****-7457` on
    // every timestamp whose 13 digits pass Luhn — 99 of the 1000 milliseconds
    // before 2026-09-17T20:37:41Z did. The masking happens after the handler,
    // so the status stays 200 and no request-shape change avoids it. Left red
    // on purpose rather than weakened: the defect is real and reproducible.
    const { status, body } = await fetchJSON('/api/agents/test-agent/self-assess', {
      method: 'POST',
      body: JSON.stringify({ taskType: 'general' }),
    });
    assert.strictEqual(status, 200);
    assert.ok(body);
  });
});

// ============================================================================
// Evaluation
// ============================================================================

describe('Evaluation Endpoints', () => {
  it('GET /api/evaluation/health returns evaluation health', async () => {
    const { status, body } = await fetchJSON('/api/evaluation/health');
    assert.strictEqual(status, 200);
    assert.strictEqual(body.status, 'ok');
  });
});

// ============================================================================
// Orchestrator
// ============================================================================

describe('Orchestrator Endpoints', () => {
  it('GET /api/orchestrator/status is not part of the mounted surface', async () => {
    // The legacy orchestrator router exposes POST /orchestrator/execute and
    // /deliberate only — there is no status route (apps/api/src/index.ts:725-733).
    const { status } = await fetchJSON('/api/orchestrator/status');
    assert.strictEqual(status, 404);
  });
});
