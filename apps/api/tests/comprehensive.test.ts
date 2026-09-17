/**
 * Comprehensive API Test Suite
 *
 * Tests the mounted endpoints with:
 * - Happy path
 * - Error handling
 * - Input validation
 * - Security headers
 * - Rate limiting
 * - CORS
 * - Edge cases
 *
 * Credentials: a real super_admin principal (test/_helpers/liveServerCredential.ts)
 * is attached to every request. That is the documented client: the API key/JWT
 * surface requires a principal by default (apps/api/src/authMiddleware.ts:272-287),
 * and the project routes additionally bind a principal to a project
 * (apps/api/src/projectEndpoints.ts:74-87).
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
// 1. Health & System (3 tests)
// ============================================================================

describe('Health & System', () => {
  it('GET /health — returns healthy', async () => {
    const { status, body } = await fetchJSON('/health');
    assert.strictEqual(status, 200);
    assert.ok(body.status === 'healthy' || body.status === 'degraded');
    assert.ok(body.projectId);
    assert.ok(typeof body.uptime === 'number');
    assert.ok(body.memory);
    assert.ok(body.version);
  });

  it('GET /system/status — returns modules', async () => {
    const { status, body } = await fetchJSON('/system/status');
    assert.strictEqual(status, 200);
    assert.strictEqual(body.status, 'ok');
    assert.ok(body.modules);
  });

  it('GET /api/openapi.json — returns spec', async () => {
    const { status, body } = await fetchJSON('/api/openapi.json');
    assert.strictEqual(status, 200);
    assert.strictEqual(body.openapi, '3.1.0');
  });
});

// ============================================================================
// 2. Security Headers (6 tests)
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

  it('X-XSS-Protection: 0', async () => {
    // Deliberate product behaviour: the legacy XSS auditor is disabled because
    // it is itself an XSS vector. apps/api/src/securityMiddleware.ts:162 sets
    // '0'; asserting '1; mode=block' here was stale.
    const { headers } = await fetchJSON('/health');
    assert.strictEqual(headers.get('x-xss-protection'), '0');
  });

  it('Referrer-Policy', async () => {
    const { headers } = await fetchJSON('/health');
    assert.strictEqual(headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
  });

  it('Rate limit headers', async () => {
    const { headers } = await fetchJSON('/health');
    assert.ok(headers.get('x-ratelimit-limit'));
    assert.ok(headers.get('x-ratelimit-remaining'));
  });

  it('CORS from whitelisted origin', async () => {
    const res = await fetch(`${BASE_URL}/health`, { headers: { Origin: 'http://localhost:3000' } });
    assert.strictEqual(res.headers.get('access-control-allow-origin'), 'http://localhost:3000');
  });
});

// ============================================================================
// 3. Input Validation (4 tests)
// ============================================================================

describe('Input Validation', () => {
  it('Rejects oversized bodies (413)', async () => {
    const { status } = await fetchJSON('/projects', {
      method: 'POST',
      body: 'x'.repeat(2 * 1024 * 1024),
    });
    assert.strictEqual(status, 413);
  });

  it('Rejects malformed JSON (400)', async () => {
    const res = await fetch(`${BASE_URL}/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...credential.headers },
      body: '{bad',
    });
    assert.strictEqual(res.status, 400);
  });

  it('Accepts valid JSON', async () => {
    const { status } = await fetchJSON('/projects/project-war-room/memory', {
      method: 'POST',
      body: JSON.stringify({
        kind: 'LESSON',
        title: `Test ${Date.now()}`,
        content: 'Test',
        tags: ['test'],
      }),
    });
    assert.strictEqual(status, 201);
  });

  it('OPTIONS preflight returns 204', async () => {
    const res = await fetch(`${BASE_URL}/health`, {
      method: 'OPTIONS',
      headers: { Origin: 'http://localhost:3000', 'Access-Control-Request-Method': 'POST' },
    });
    assert.strictEqual(res.status, 204);
  });
});

// ============================================================================
// 4. Projects (4 tests)
// ============================================================================

describe('Projects', () => {
  it('GET /projects — returns array', async () => {
    const { status, body } = await fetchJSON('/projects');
    assert.strictEqual(status, 200);
    assert.ok(Array.isArray(body));
  });

  it('GET /projects/:id/war-room — returns data', async () => {
    const { status, body } = await fetchJSON('/projects/project-war-room/war-room');
    assert.strictEqual(status, 200);
    assert.ok(body.project);
  });

  it('GET /projects/:id/missions — route is not mounted', async () => {
    // The WarRoom project router exposes agents/war-room/run-context/memory/
    // governance only; there is no /missions collection route
    // (apps/api/src/projectEndpoints.ts route list).
    const { status } = await fetchJSON('/projects/project-war-room/missions');
    assert.strictEqual(status, 404);
  });

  it('POST /projects/:id/missions — route is not mounted (memory router owns the path)', async () => {
    // There is no missions collection route; the POST falls through to the
    // memory router, which rejects the missing title/content with 400
    // (apps/api/src/projectEndpoints.ts:553-568).
    const { status, body } = await fetchJSON('/projects/project-war-room/missions', {
      method: 'POST',
      body: JSON.stringify({ name: 'test', description: 'test' }),
    });
    assert.strictEqual(status, 400);
    assert.match(String(body.error), /title is required/);
  });
});

// ============================================================================
// 5. Memory (8 tests)
// ============================================================================

describe('Memory', () => {
  it('GET /projects/:id/memory — returns array', async () => {
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
        content: 'Test',
        tags: ['test'],
      }),
    });
    assert.strictEqual(status, 201);
    assert.ok(body);
  });

  it('GET /projects/:id/memory/search — searches', async () => {
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

  it('GET /projects/:id/memory — empty search returns all', async () => {
    const { status, body } = await fetchJSON('/projects/project-war-room/memory?query=');
    assert.strictEqual(status, 200);
    assert.ok(Array.isArray(body));
  });

  it('GET /projects/:id/memory — invalid kind returns empty', async () => {
    const { status, body } = await fetchJSON('/projects/project-war-room/memory?kind=INVALID');
    assert.strictEqual(status, 200);
    assert.ok(Array.isArray(body));
  });
});

// ============================================================================
// 6. Quality Gates (3 tests)
// ============================================================================

describe('Quality Gates', () => {
  it('POST /api/quality/check — runs gates', async () => {
    const { status, body } = await fetchJSON('/api/quality/check', {
      method: 'POST',
      body: JSON.stringify({ input: 'What is 2+2?', output: '4' }),
    });
    assert.strictEqual(status, 200);
    assert.ok(body);
  });

  it('POST /api/quality/hallucination-check — detects', async () => {
    const { status, body } = await fetchJSON('/api/quality/hallucination-check', {
      method: 'POST',
      body: JSON.stringify({
        input: 'Capital of France?',
        output: 'Paris',
        context: 'France capital is Paris',
      }),
    });
    assert.strictEqual(status, 200);
    assert.ok(body);
  });

  it('POST /api/quality/check — rejects empty', async () => {
    const { status } = await fetchJSON('/api/quality/check', {
      method: 'POST',
      body: JSON.stringify({ input: '', output: '' }),
    });
    assert.strictEqual(status, 400);
  });
});

// ============================================================================
// 7. Namespaced Memory (6 tests)
// ============================================================================

describe('Namespaced Memory', () => {
  it('GET /api/namespaced-memory/:ns/stats — returns stats', async () => {
    const { status, body } = await fetchJSON('/api/namespaced-memory/shared/stats');
    assert.strictEqual(status, 200);
    assert.ok(body);
  });

  it('GET /api/namespaced-memory/acl — returns rules', async () => {
    const { status, body } = await fetchJSON('/api/namespaced-memory/acl');
    assert.strictEqual(status, 200);
    assert.ok(Array.isArray(body.rules));
  });

  it('POST /api/namespaced-memory/:ns/write — writes', async () => {
    const { status } = await fetchJSON('/api/namespaced-memory/shared/write', {
      method: 'POST',
      body: JSON.stringify({ key: `test-${Date.now()}`, value: 'test', projectId: 'test' }),
    });
    assert.strictEqual(status, 200);
  });

  it('GET /api/namespaced-memory/:ns/search — searches', async () => {
    const { status } = await fetchJSON('/api/namespaced-memory/shared/search?projectId=test');
    assert.strictEqual(status, 200);
  });

  it('GET /api/namespaced-memory/:ns/read/:id — reads', async () => {
    const { status } = await fetchJSON('/api/namespaced-memory/shared/read/nonexistent');
    assert.strictEqual(status, 404);
  });

  it('GET /api/namespaced-memory/:ns/audit — returns log', async () => {
    const { status, body } = await fetchJSON('/api/namespaced-memory/shared/audit');
    assert.strictEqual(status, 200);
    assert.ok(Array.isArray(body.entries));
  });
});

// ============================================================================
// 8. A2A Protocol (3 tests)
// ============================================================================

describe('A2A Protocol', () => {
  it('GET /a2a/.well-known/agent-card — returns card', async () => {
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
      body: JSON.stringify({ name: 'test' }),
    });
    assert.strictEqual(status, 500);
  });
});

// ============================================================================
// 9. Governance (4 tests)
// ============================================================================

describe('Governance', () => {
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
    const report = await res.text();
    assert.ok(report.length > 0);
  });

  it('POST /api/agents/:id/self-assess — returns assessment', async () => {
    const { status, body } = await fetchJSON('/api/agents/test/self-assess', {
      method: 'POST',
      body: JSON.stringify({ taskType: 'general' }),
    });
    assert.strictEqual(status, 200);
    assert.ok(body);
  });
});

// ============================================================================
// 10. Self-Assessment (1 test)
//
// The duplicate POST /api/agents/:id/self-assess case was removed: it asserted
// exactly what section 9 already asserts, against the same handler and the same
// agent id.
// ============================================================================

describe('Self-Assessment', () => {
  it('GET /api/agents/:id/self-model — returns model', async () => {
    const { status } = await fetchJSON('/api/agents/test/self-model');
    assert.strictEqual(status, 200);
  });
});

// ============================================================================
// 11. Evaluation (3 tests)
// ============================================================================

describe('Evaluation', () => {
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
// 12. Orchestrator (2 tests)
// ============================================================================

describe('Orchestrator', () => {
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
// 13. Pipeline (3 tests)
// ============================================================================

describe('Pipeline', () => {
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
// 14. Runtime (3 tests)
// ============================================================================

describe('Runtime', () => {
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
// 15. Agent Cards (2 tests)
// ============================================================================

describe('Agent Cards', () => {
  it('GET /api/agent-cards — returns cards', async () => {
    const { status, body } = await fetchJSON('/api/agent-cards');
    assert.strictEqual(status, 200);
    assert.ok(Array.isArray(body));
  });

  it('GET /api/agent-cards/:id — returns card', async () => {
    const { status } = await fetchJSON('/api/agent-cards/test');
    assert.strictEqual(status, 404);
  });
});

// ============================================================================
// 16. Reasoning Config (2 tests)
// ============================================================================

describe('Reasoning Config', () => {
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
// 17. Evaluation Runner (2 tests)
// ============================================================================

describe('Evaluation Runner', () => {
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
// 18. State Machine (2 tests)
// ============================================================================

describe('State Machine', () => {
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
// 19. Conflict Detection (2 tests)
// ============================================================================

describe('Conflict Detection', () => {
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
// 20. Confidence (2 tests)
// ============================================================================

describe('Confidence', () => {
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
// 21. Security (3 tests)
// ============================================================================

describe('Security', () => {
  it('POST /api/memory/detect-poisoning — detects', async () => {
    const { status, body } = await fetchJSON('/api/memory/detect-poisoning', {
      method: 'POST',
      body: JSON.stringify({
        newMemories: [
          {
            id: 'test',
            content: 'test',
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

  it('POST /api/security/scan — scans', async () => {
    const { status, body } = await fetchJSON('/api/security/scan', {
      method: 'POST',
      body: JSON.stringify({ content: 'test' }),
    });
    assert.strictEqual(status, 200);
    assert.ok(body);
  });

  it('POST /api/memory/assess-credibility — rejects a malformed source', async () => {
    // The canonical route validates `source` as a string; an object source is a
    // 400, not a silent pass (apps/api/src/memorySecurityEndpoints.ts).
    const { status } = await fetchJSON('/api/memory/assess-credibility', {
      method: 'POST',
      body: JSON.stringify({ source: { id: 'test' } }),
    });
    assert.strictEqual(status, 400);
  });
});

// ============================================================================
// 22. MCP (2 tests)
// ============================================================================

describe('MCP', () => {
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
// 23. Edge Cases (5 tests)
// ============================================================================

describe('Edge Cases', () => {
  it('Non-existent endpoint returns 404', async () => {
    const { status } = await fetchJSON('/nonexistent');
    assert.strictEqual(status, 404);
  });

  it('Unmatched method on a public path is short-circuited by CORS preflight handling', async () => {
    // index.ts mounts the CORS middleware ahead of routing and it answers any
    // OPTIONS request with 204 (apps/api/src/index.ts:316-321).
    const { status } = await fetchJSON('/health', { method: 'OPTIONS' });
    assert.strictEqual(status, 204);
  });

  it('Empty body on POST to an unmounted route returns 404', async () => {
    // POST /projects is not mounted at all (the project router is read-only),
    // so the express.json body parser never sees an empty body to reject.
    const { status } = await fetchJSON('/projects', { method: 'POST', body: '' });
    assert.strictEqual(status, 404);
  });

  it('Very long URL path returns 404', async () => {
    const longPath = '/' + 'a'.repeat(10000);
    const { status } = await fetchJSON(longPath);
    assert.strictEqual(status, 404);
  });

  it('Special characters in query params are handled', async () => {
    const { status } = await fetchJSON(
      '/projects/project-war-room/memory/search?q=<script>alert(1)</script>',
    );
    assert.strictEqual(status, 200);
  });
});
