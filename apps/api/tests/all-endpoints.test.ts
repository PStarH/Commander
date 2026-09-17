/**
 * Comprehensive API Endpoint Tests
 *
 * Tests the mounted endpoints with:
 * - Happy path
 * - Error handling
 * - Input validation
 * - Security headers
 * - Rate limiting
 * - CORS
 *
 * Credentials: a real super_admin principal (test/_helpers/liveServerCredential.ts)
 * is attached to every request; routes that require a principal reject
 * anonymous callers by design (apps/api/src/authMiddleware.ts:272-287).
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { requireLiveServer } from '../test/_helpers/requireLiveServer.mjs';
import {
  provisionLiveServerCredential,
  revokeLiveServerCredential,
  type LiveServerCredential,
} from '../test/_helpers/liveServerCredential';

const BASE_URL = requireLiveServer();

let credential: LiveServerCredential;

before(async () => {
  credential = await provisionLiveServerCredential();
});

after(async () => {
  await revokeLiveServerCredential();
});

async function fetchJSON(
  path: string,
  options?: RequestInit,
): Promise<{ status: number; body: any; headers: Headers }> {
  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...credential.headers,
        ...options?.headers,
      },
    });
    const body = await res.json().catch(() => null);
    return { status: res.status, body, headers: res.headers };
  } catch (err) {
    return { status: 0, body: { error: (err as Error).message }, headers: new Headers() };
  }
}

// ============================================================================
// 1. Health & System (2 endpoints)
// ============================================================================

describe('Health & System', () => {
  it('GET /health — returns healthy with all fields', async () => {
    const { status, body } = await fetchJSON('/health');
    assert.strictEqual(status, 200);
    assert.ok(body.status === 'healthy' || body.status === 'degraded');
    assert.ok(body.projectId);
    assert.ok(typeof body.uptime === 'number');
    assert.ok(body.memory);
    assert.ok(body.version);
    assert.ok(body.timestamp);
  });

  it('GET /system/status — returns module status', async () => {
    const { status, body } = await fetchJSON('/system/status');
    assert.strictEqual(status, 200);
    assert.strictEqual(body.status, 'ok');
    assert.ok(body.modules);
    assert.ok(body.timestamp);
  });

  it('GET /api/openapi.json — returns valid OpenAPI spec', async () => {
    const { status, body } = await fetchJSON('/api/openapi.json');
    assert.strictEqual(status, 200);
    assert.strictEqual(body.openapi, '3.1.0');
    assert.ok(body.info);
    assert.ok(body.paths);
  });
});

// ============================================================================
// 2. Security Headers (5 checks)
// ============================================================================

describe('Security Headers', () => {
  it('X-Content-Type-Options: nosniff', async () => {
    const { headers } = await fetchJSON('/health');
    assert.strictEqual(headers.get('x-content-type-options'), 'nosniff');
  });

  it('X-Frame-Options: DENY', async () => {
    const { headers } = await fetchJSON('/health');
    assert.strictEqual(headers.get('x-frame-options'), 'DENY');
  });

  it('X-XSS-Protection: 0 (legacy auditor deliberately disabled)', async () => {
    // apps/api/src/securityMiddleware.ts:162 sets '0' on purpose: the legacy
    // XSS auditor is itself an XSS vector.
    const { headers } = await fetchJSON('/health');
    assert.strictEqual(headers.get('x-xss-protection'), '0');
  });

  it('Referrer-Policy: strict-origin-when-cross-origin', async () => {
    const { headers } = await fetchJSON('/health');
    assert.strictEqual(headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
  });

  it('Rate limit headers present', async () => {
    const { headers } = await fetchJSON('/health');
    assert.ok(headers.get('x-ratelimit-limit'));
    assert.ok(headers.get('x-ratelimit-remaining'));
    assert.ok(headers.get('x-ratelimit-reset'));
  });
});

// ============================================================================
// 3. Input Validation (4 checks)
// ============================================================================

describe('Input Validation', () => {
  it('Rejects oversized request bodies (413)', async () => {
    const largeBody = 'x'.repeat(2 * 1024 * 1024);
    const { status } = await fetchJSON('/projects', { method: 'POST', body: largeBody });
    assert.strictEqual(status, 413);
  });

  it('Rejects malformed JSON (400)', async () => {
    const res = await fetch(`${BASE_URL}/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...credential.headers },
      body: '{invalid json',
    });
    assert.strictEqual(res.status, 400);
  });

  it('Rejects missing required fields (400)', async () => {
    const { status, body } = await fetchJSON('/projects/project-war-room/memory', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    assert.strictEqual(status, 400);
    assert.match(String(body.error), /title is required/);
  });

  it('Accepts valid JSON', async () => {
    const { status } = await fetchJSON('/projects/project-war-room/memory', {
      method: 'POST',
      body: JSON.stringify({
        kind: 'LESSON',
        title: `Test ${Date.now()}`,
        content: 'Test content',
        tags: ['test'],
      }),
    });
    assert.strictEqual(status, 201);
  });
});

// ============================================================================
// 4. Projects (4 endpoints)
// ============================================================================

describe('Project Endpoints', () => {
  it('GET /projects — returns array', async () => {
    const { status, body } = await fetchJSON('/projects');
    assert.strictEqual(status, 200);
    assert.ok(Array.isArray(body));
  });

  it('GET /projects/:id/war-room — returns war room', async () => {
    const { status, body } = await fetchJSON('/projects/project-war-room/war-room');
    assert.strictEqual(status, 200);
    assert.ok(body.project);
  });

  it('GET /projects/:id/missions — route is not mounted', async () => {
    const { status } = await fetchJSON('/projects/project-war-room/missions');
    assert.strictEqual(status, 404);
  });

  it('POST /projects/:id/missions — route is not mounted (memory router owns the path)', async () => {
    // There is no missions collection route; the POST falls through to the
    // memory router, which rejects the missing title/content with 400
    // (apps/api/src/projectEndpoints.ts:553-568).
    const { status, body } = await fetchJSON('/projects/project-war-room/missions', {
      method: 'POST',
      body: JSON.stringify({ name: 'test-mission', description: 'test' }),
    });
    assert.strictEqual(status, 400);
    assert.match(String(body.error), /title is required/);
  });
});

// ============================================================================
// 5. Memory (6 endpoints)
// ============================================================================

describe('Memory Endpoints', () => {
  it('GET /projects/:id/memory — returns memories', async () => {
    const { status, body } = await fetchJSON('/projects/project-war-room/memory');
    assert.strictEqual(status, 200);
    assert.ok(Array.isArray(body));
  });

  it('POST /projects/:id/memory — creates memory', async () => {
    const { status, body } = await fetchJSON('/projects/project-war-room/memory', {
      method: 'POST',
      body: JSON.stringify({
        kind: 'LESSON',
        title: `Test ${Date.now()}`,
        content: 'Test content',
        tags: ['test'],
      }),
    });
    assert.strictEqual(status, 201);
    assert.ok(body);
  });

  it('GET /projects/:id/memory/search — searches memories', async () => {
    const { status, body } = await fetchJSON('/projects/project-war-room/memory/search?q=test');
    assert.strictEqual(status, 200);
    assert.ok(Array.isArray(body));
  });

  it('GET /projects/:id/memory — filters by kind', async () => {
    const { status, body } = await fetchJSON('/projects/project-war-room/memory?kind=LESSON');
    assert.strictEqual(status, 200);
    assert.ok(Array.isArray(body));
  });

  it('GET /projects/:id/memory — filters by tags', async () => {
    const { status, body } = await fetchJSON('/projects/project-war-room/memory?tags=test');
    assert.strictEqual(status, 200);
    assert.ok(Array.isArray(body));
  });

  it('GET /projects/:id/memory — limits results', async () => {
    const { status, body } = await fetchJSON('/projects/project-war-room/memory?limit=5');
    assert.strictEqual(status, 200);
    assert.ok(Array.isArray(body));
    assert.ok(body.length <= 5);
  });
});

// ============================================================================
// 6. Quality Gates (3 endpoints)
// ============================================================================

describe('Quality Endpoints', () => {
  it('POST /api/quality/check — runs quality gates', async () => {
    const { status, body } = await fetchJSON('/api/quality/check', {
      method: 'POST',
      body: JSON.stringify({ input: 'What is 2+2?', output: '4' }),
    });
    assert.strictEqual(status, 200);
    assert.ok(body);
  });

  it('POST /api/quality/hallucination-check — detects hallucinations', async () => {
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

  it('POST /api/quality/check — rejects empty output', async () => {
    const { status } = await fetchJSON('/api/quality/check', {
      method: 'POST',
      body: JSON.stringify({ input: 'test', output: '' }),
    });
    assert.strictEqual(status, 400);
  });
});

// ============================================================================
// 7. Namespaced Memory (6 endpoints)
// ============================================================================

describe('Namespaced Memory Endpoints', () => {
  it('GET /api/namespaced-memory/:ns/stats — returns stats', async () => {
    const { status, body } = await fetchJSON('/api/namespaced-memory/shared/stats');
    assert.strictEqual(status, 200);
    assert.ok(body);
  });

  it('GET /api/namespaced-memory/acl — returns ACL rules', async () => {
    const { status, body } = await fetchJSON('/api/namespaced-memory/acl');
    assert.strictEqual(status, 200);
    assert.ok(Array.isArray(body.rules));
  });

  it('POST /api/namespaced-memory/:ns/write — writes memory', async () => {
    const { status } = await fetchJSON('/api/namespaced-memory/shared/write', {
      method: 'POST',
      body: JSON.stringify({ key: `test-${Date.now()}`, value: 'test content', projectId: 'test' }),
    });
    assert.strictEqual(status, 200);
  });

  it('GET /api/namespaced-memory/:ns/search — searches', async () => {
    const { status, body } = await fetchJSON('/api/namespaced-memory/shared/search?projectId=test');
    assert.strictEqual(status, 200);
    assert.ok(body);
  });

  it('GET /api/namespaced-memory/:ns/read/:id — reads item', async () => {
    const { status } = await fetchJSON('/api/namespaced-memory/shared/read/nonexistent');
    assert.strictEqual(status, 404);
  });

  it('GET /api/namespaced-memory/:ns/audit — returns audit log', async () => {
    const { status, body } = await fetchJSON('/api/namespaced-memory/shared/audit');
    assert.strictEqual(status, 200);
    assert.ok(Array.isArray(body.entries));
  });
});

// ============================================================================
// 8. A2A Protocol (3 endpoints)
// ============================================================================

describe('A2A Endpoints', () => {
  it('GET /a2a/.well-known/agent-card — returns agent card', async () => {
    const { status, body } = await fetchJSON('/a2a/.well-known/agent-card');
    assert.strictEqual(status, 200);
    assert.ok(body);
  });

  it('GET /a2a/agent-cards — fails closed without a configured authToken', async () => {
    const { status, body } = await fetchJSON('/a2a/agent-cards');
    assert.strictEqual(status, 500);
    assert.match(String(body.error), /authToken is not configured/);
  });

  it('POST /a2a/tasks — fails closed without a configured authToken', async () => {
    const { status } = await fetchJSON('/a2a/tasks', {
      method: 'POST',
      body: JSON.stringify({ name: 'test-task' }),
    });
    assert.strictEqual(status, 500);
  });
});

// ============================================================================
// 9. MCP (2 endpoints)
// ============================================================================

describe('MCP Endpoints', () => {
  it('GET /mcp/status — returns status', async () => {
    const { status, body } = await fetchJSON('/mcp/status');
    assert.strictEqual(status, 200);
    assert.ok(body);
  });

  it('GET /mcp/client/status — route is not mounted', async () => {
    const { status } = await fetchJSON('/mcp/client/status');
    assert.strictEqual(status, 404);
  });
});

// ============================================================================
// 10. Governance (4 endpoints)
// ============================================================================

describe('Governance Endpoints', () => {
  it('GET /projects/:id/governance/stats — returns stats', async () => {
    const { status, body } = await fetchJSON('/projects/project-war-room/governance/stats');
    assert.strictEqual(status, 200);
    assert.ok(body);
  });

  it('GET /projects/:id/governance/alerts — returns alerts', async () => {
    const { status, body } = await fetchJSON('/projects/project-war-room/governance/alerts');
    assert.strictEqual(status, 200);
    assert.ok(Array.isArray(body));
  });

  it('GET /projects/:id/governance/weekly-report — returns report', async () => {
    // The route answers with markdown, not JSON
    // (apps/api/src/projectEndpoints.ts:659-673), so it must be read as text.
    const res = await fetch(`${BASE_URL}/projects/project-war-room/governance/weekly-report`, {
      headers: credential.headers,
    });
    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/markdown/);
    assert.ok((await res.text()).length > 0);
  });

  it('POST /api/agents/:id/self-assess — returns assessment', async () => {
    const { status, body } = await fetchJSON('/api/agents/test-agent/self-assess', {
      method: 'POST',
      body: JSON.stringify({ taskType: 'general' }),
    });
    assert.strictEqual(status, 200);
    assert.ok(body);
  });
});

// ============================================================================
// 11. Self-Assessment (2 endpoints)
// ============================================================================

describe('Self-Assessment Endpoints', () => {
  it('POST /api/agents/:id/self-assess — returns assessment', async () => {
    const { status, body } = await fetchJSON('/api/agents/test-agent/self-assess', {
      method: 'POST',
      body: JSON.stringify({ taskType: 'general' }),
    });
    assert.strictEqual(status, 200);
    assert.ok(body);
  });

  it('GET /api/agents/:id/self-model — returns self model', async () => {
    // The preceding case ran a self-assessment for this agent, and the assessor
    // map is process-lifetime (apps/api/src/selfAssessmentEndpoints.ts:7-11).
    const { status, body } = await fetchJSON('/api/agents/test-agent/self-model');
    assert.strictEqual(status, 200);
    assert.strictEqual(body.agentId, 'test-agent');
  });
});

// ============================================================================
// 12. Evaluation (3 endpoints)
// ============================================================================

describe('Evaluation Endpoints', () => {
  it('GET /api/evaluation/health — returns health', async () => {
    const { status, body } = await fetchJSON('/api/evaluation/health');
    assert.strictEqual(status, 200);
    assert.strictEqual(body.status, 'ok');
  });

  it('POST /api/evaluation/run — route is not mounted', async () => {
    const { status } = await fetchJSON('/api/evaluation/run', {
      method: 'POST',
      body: JSON.stringify({ tasks: [] }),
    });
    assert.strictEqual(status, 404);
  });

  it('GET /api/evaluation/results — route is not mounted', async () => {
    const { status } = await fetchJSON('/api/evaluation/results');
    assert.strictEqual(status, 404);
  });
});

// ============================================================================
// 13. Orchestrator (2 endpoints)
// ============================================================================

describe('Orchestrator Endpoints', () => {
  it('GET /api/orchestrator/status — route is not mounted', async () => {
    const { status } = await fetchJSON('/api/orchestrator/status');
    assert.strictEqual(status, 404);
  });

  it('POST /api/orchestrator/run — route is not mounted', async () => {
    const { status } = await fetchJSON('/api/orchestrator/run', {
      method: 'POST',
      body: JSON.stringify({ task: 'test' }),
    });
    assert.strictEqual(status, 404);
  });
});

// ============================================================================
// 14. Pipeline (3 endpoints)
// ============================================================================

describe('Pipeline Endpoints', () => {
  it('GET /api/pipeline/status — route is not mounted (legacy execution retired)', async () => {
    const { status } = await fetchJSON('/api/pipeline/status');
    assert.strictEqual(status, 404);
  });

  it('POST /api/pipeline/run — route is not mounted (legacy execution retired)', async () => {
    const { status } = await fetchJSON('/api/pipeline/run', {
      method: 'POST',
      body: JSON.stringify({ steps: [] }),
    });
    assert.strictEqual(status, 404);
  });

  it('GET /api/pipeline/results — route is not mounted (legacy execution retired)', async () => {
    const { status } = await fetchJSON('/api/pipeline/results');
    assert.strictEqual(status, 404);
  });
});

// ============================================================================
// 15. Runtime (3 endpoints)
// ============================================================================

describe('Runtime Endpoints', () => {
  it('GET /api/runtime/status — route is not mounted', async () => {
    const { status } = await fetchJSON('/api/runtime/status');
    assert.strictEqual(status, 404);
  });

  it('GET /api/runtime/config — route is not mounted', async () => {
    const { status } = await fetchJSON('/api/runtime/config');
    assert.strictEqual(status, 404);
  });

  it('GET /api/runtime/metrics — route is not mounted', async () => {
    const { status } = await fetchJSON('/api/runtime/metrics');
    assert.strictEqual(status, 404);
  });
});

// ============================================================================
// 16. Agent Cards (2 endpoints)
// ============================================================================

describe('Agent Card Endpoints', () => {
  it('GET /api/agent-cards — returns cards', async () => {
    const { status, body } = await fetchJSON('/api/agent-cards');
    assert.strictEqual(status, 200);
    assert.ok(Array.isArray(body));
  });

  it('GET /api/agent-cards/:id — returns specific card', async () => {
    const { status } = await fetchJSON('/api/agent-cards/test');
    assert.strictEqual(status, 404);
  });
});

// ============================================================================
// 17. Reasoning Config (2 endpoints)
// ============================================================================

describe('Reasoning Config Endpoints', () => {
  it('GET /api/reasoning/config — route is not mounted', async () => {
    const { status } = await fetchJSON('/api/reasoning/config');
    assert.strictEqual(status, 404);
  });

  it('PUT /api/reasoning/config — route is not mounted', async () => {
    const { status } = await fetchJSON('/api/reasoning/config', {
      method: 'PUT',
      body: JSON.stringify({ enabled: true }),
    });
    assert.strictEqual(status, 404);
  });
});

// ============================================================================
// 18. Evaluation Runner (2 endpoints)
// ============================================================================

describe('Evaluation Runner Endpoints', () => {
  it('GET /api/evaluation-runner/status — route is not mounted', async () => {
    const { status } = await fetchJSON('/api/evaluation-runner/status');
    assert.strictEqual(status, 404);
  });

  it('POST /api/evaluation-runner/run — route is not mounted', async () => {
    const { status } = await fetchJSON('/api/evaluation-runner/run', {
      method: 'POST',
      body: JSON.stringify({ tasks: [] }),
    });
    assert.strictEqual(status, 404);
  });
});

// ============================================================================
// 19. State Machine (2 endpoints)
// ============================================================================

describe('State Machine Endpoints', () => {
  it('GET /api/state-machine/status — unknown machine', async () => {
    const { status } = await fetchJSON('/api/state-machine/status');
    assert.strictEqual(status, 404);
  });

  it('POST /api/state-machine/create — validates required fields', async () => {
    const { status } = await fetchJSON('/api/state-machine/create', {
      method: 'POST',
      body: JSON.stringify({ pattern: 'sequential' }),
    });
    assert.strictEqual(status, 400);
  });
});

// ============================================================================
// 20. Conflict Detection (2 endpoints)
// ============================================================================

describe('Conflict Endpoints', () => {
  it('GET /projects/:id/conflicts — route is not mounted', async () => {
    const { status } = await fetchJSON('/projects/project-war-room/conflicts');
    assert.strictEqual(status, 404);
  });

  it('POST /projects/:id/conflicts/detect — route is not mounted', async () => {
    const { status } = await fetchJSON('/projects/project-war-room/conflicts/detect', {
      method: 'POST',
      body: JSON.stringify({ memories: [] }),
    });
    assert.strictEqual(status, 404);
  });
});

// ============================================================================
// 21. Confidence (2 endpoints)
// ============================================================================

describe('Confidence Endpoints', () => {
  it('GET /projects/:id/confidence — route is not mounted', async () => {
    const { status } = await fetchJSON('/projects/project-war-room/confidence');
    assert.strictEqual(status, 404);
  });

  it('POST /projects/:id/confidence/report — route is not mounted', async () => {
    const { status } = await fetchJSON('/projects/project-war-room/confidence/report', {
      method: 'POST',
      body: JSON.stringify({ score: 0.8 }),
    });
    assert.strictEqual(status, 404);
  });
});

// ============================================================================
// 22. Security (3 endpoints)
// ============================================================================

describe('Security Endpoints', () => {
  it('POST /api/memory/detect-poisoning — detects poisoning', async () => {
    const { status, body } = await fetchJSON('/api/memory/detect-poisoning', {
      method: 'POST',
      body: JSON.stringify({
        newMemories: [
          {
            id: 'test',
            content: 'test content',
            timestamp: new Date().toISOString(),
            source: 'https://example.com',
          },
        ],
        existingMemories: [],
      }),
    });
    assert.strictEqual(status, 200);
    assert.ok(body);
  });

  it('POST /api/security/scan — scans content', async () => {
    const { status, body } = await fetchJSON('/api/security/scan', {
      method: 'POST',
      body: JSON.stringify({ content: 'test content' }),
    });
    assert.strictEqual(status, 200);
    assert.ok(body);
  });

  it('POST /api/memory/assess-credibility — rejects a malformed source', async () => {
    const { status } = await fetchJSON('/api/memory/assess-credibility', {
      method: 'POST',
      body: JSON.stringify({ source: { id: 'test' } }),
    });
    assert.strictEqual(status, 400);
  });
});

// ============================================================================
// 23. CORS (2 checks)
// ============================================================================

describe('CORS', () => {
  it('Allows requests from whitelisted origins', async () => {
    const res = await fetch(`${BASE_URL}/health`, {
      headers: { Origin: 'http://localhost:3000' },
    });
    assert.strictEqual(res.headers.get('access-control-allow-origin'), 'http://localhost:3000');
  });

  it('Withholds the allow-origin header from a non-whitelisted origin', async () => {
    // The CORS middleware only echoes origins in its allowlist
    // (apps/api/src/index.ts:284-321); an unlisted origin gets no
    // Access-Control-Allow-Origin at all (never a wildcard).
    const res = await fetch(`${BASE_URL}/health`, {
      headers: { Origin: 'https://attacker.example' },
    });
    assert.strictEqual(res.headers.get('access-control-allow-origin'), null);
  });

  it('Handles OPTIONS preflight', async () => {
    const res = await fetch(`${BASE_URL}/health`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://localhost:3000',
        'Access-Control-Request-Method': 'POST',
      },
    });
    assert.strictEqual(res.status, 204);
  });
});
