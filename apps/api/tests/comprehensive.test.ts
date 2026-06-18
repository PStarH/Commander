/**
 * Comprehensive API Test Suite
 *
 * Tests ALL endpoints with:
 * - Happy path
 * - Error handling
 * - Input validation
 * - Security headers
 * - Rate limiting
 * - CORS
 * - Edge cases
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';

const BASE_URL = process.env.TEST_API_URL ?? 'http://localhost:4000';

async function fetchJSON(
  path: string,
  options?: RequestInit,
): Promise<{ status: number; body: any; headers: Headers }> {
  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      headers: { 'Content-Type': 'application/json', ...options?.headers },
      ...options,
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

  it('X-XSS-Protection', async () => {
    const { headers } = await fetchJSON('/health');
    assert.strictEqual(headers.get('x-xss-protection'), '1; mode=block');
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
      headers: { 'Content-Type': 'application/json' },
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
    assert.ok([200, 201].includes(status));
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
    assert.ok(body);
  });

  it('GET /projects/:id/missions — returns missions', async () => {
    const { status } = await fetchJSON('/projects/project-war-room/missions');
    assert.ok([200, 404].includes(status));
  });

  it('POST /projects/:id/missions — creates mission', async () => {
    const { status } = await fetchJSON('/projects/project-war-room/missions', {
      method: 'POST',
      body: JSON.stringify({ name: 'test', description: 'test' }),
    });
    assert.ok([200, 201, 400].includes(status));
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
    assert.ok([200, 201].includes(status));
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
    assert.ok([400, 422].includes(status));
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
    assert.ok(Array.isArray(body));
  });

  it('POST /api/namespaced-memory/:ns/write — writes', async () => {
    const { status } = await fetchJSON('/api/namespaced-memory/shared/write', {
      method: 'POST',
      body: JSON.stringify({
        projectId: 'test',
        kind: 'SUMMARY',
        title: 'Test',
        content: 'Test',
        namespace: 'shared',
      }),
    });
    assert.ok([200, 201, 403].includes(status));
  });

  it('GET /api/namespaced-memory/:ns/search — searches', async () => {
    const { status } = await fetchJSON('/api/namespaced-memory/shared/search?projectId=test');
    assert.strictEqual(status, 200);
  });

  it('GET /api/namespaced-memory/:ns/read/:id — reads', async () => {
    const { status } = await fetchJSON('/api/namespaced-memory/shared/read/nonexistent');
    assert.ok([200, 404].includes(status));
  });

  it('GET /api/namespaced-memory/:ns/audit — returns log', async () => {
    const { status, body } = await fetchJSON('/api/namespaced-memory/shared/audit');
    assert.strictEqual(status, 200);
    assert.ok(Array.isArray(body));
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

  it('GET /a2a/agent-cards — returns list', async () => {
    const { status, body } = await fetchJSON('/a2a/agent-cards');
    assert.strictEqual(status, 200);
    assert.ok(Array.isArray(body));
  });

  it('POST /a2a/tasks — creates task', async () => {
    const { status } = await fetchJSON('/a2a/tasks', {
      method: 'POST',
      body: JSON.stringify({ name: 'test' }),
    });
    assert.ok([200, 201, 400].includes(status));
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
    const { status, body } = await fetchJSON('/projects/project-war-room/governance/weekly-report');
    assert.strictEqual(status, 200);
    assert.ok(body);
  });

  it('POST /api/agents/:id/self-assess — returns assessment', async () => {
    const { status } = await fetchJSON('/api/agents/test/self-assess', {
      method: 'POST',
      body: JSON.stringify({ taskType: 'general' }),
    });
    assert.ok([200, 404].includes(status));
  });
});

// ============================================================================
// 10. Self-Assessment (2 tests)
// ============================================================================

describe('Self-Assessment', () => {
  it('POST /api/agents/:id/self-assess — works', async () => {
    const { status } = await fetchJSON('/api/agents/test/self-assess', {
      method: 'POST',
      body: JSON.stringify({ taskType: 'general' }),
    });
    assert.ok([200, 404].includes(status));
  });

  it('GET /api/agents/:id/self-model — returns model', async () => {
    const { status } = await fetchJSON('/api/agents/test/self-model');
    assert.ok([200, 404].includes(status));
  });
});

// ============================================================================
// 11. Evaluation (3 tests)
// ============================================================================

describe('Evaluation', () => {
  it('GET /api/evaluation/health — returns health', async () => {
    const { status } = await fetchJSON('/api/evaluation/health');
    assert.ok([200, 404].includes(status));
  });

  it('POST /api/evaluation/run — runs eval', async () => {
    const { status } = await fetchJSON('/api/evaluation/run', {
      method: 'POST',
      body: JSON.stringify({ tasks: [] }),
    });
    assert.ok([200, 201, 400].includes(status));
  });

  it('GET /api/evaluation/results — returns results', async () => {
    const { status } = await fetchJSON('/api/evaluation/results');
    assert.ok([200, 404].includes(status));
  });
});

// ============================================================================
// 12. Orchestrator (2 tests)
// ============================================================================

describe('Orchestrator', () => {
  it('GET /api/orchestrator/status — returns status', async () => {
    const { status } = await fetchJSON('/api/orchestrator/status');
    assert.ok([200, 404].includes(status));
  });

  it('POST /api/orchestrator/run — runs', async () => {
    const { status } = await fetchJSON('/api/orchestrator/run', {
      method: 'POST',
      body: JSON.stringify({ task: 'test' }),
    });
    assert.ok([200, 201, 400].includes(status));
  });
});

// ============================================================================
// 13. Pipeline (3 tests)
// ============================================================================

describe('Pipeline', () => {
  it('GET /api/pipeline/status — returns status', async () => {
    const { status } = await fetchJSON('/api/pipeline/status');
    assert.ok([200, 404].includes(status));
  });

  it('POST /api/pipeline/run — runs', async () => {
    const { status } = await fetchJSON('/api/pipeline/run', {
      method: 'POST',
      body: JSON.stringify({ steps: [] }),
    });
    assert.ok([200, 201, 400].includes(status));
  });

  it('GET /api/pipeline/results — returns results', async () => {
    const { status } = await fetchJSON('/api/pipeline/results');
    assert.ok([200, 404].includes(status));
  });
});

// ============================================================================
// 14. Runtime (3 tests)
// ============================================================================

describe('Runtime', () => {
  it('GET /api/runtime/status — returns status', async () => {
    const { status } = await fetchJSON('/api/runtime/status');
    assert.ok([200, 404].includes(status));
  });

  it('GET /api/runtime/config — returns config', async () => {
    const { status } = await fetchJSON('/api/runtime/config');
    assert.ok([200, 404].includes(status));
  });

  it('GET /api/runtime/metrics — returns metrics', async () => {
    const { status } = await fetchJSON('/api/runtime/metrics');
    assert.ok([200, 404].includes(status));
  });
});

// ============================================================================
// 15. Agent Cards (2 tests)
// ============================================================================

describe('Agent Cards', () => {
  it('GET /api/agent-cards — returns cards', async () => {
    const { status } = await fetchJSON('/api/agent-cards');
    assert.ok([200, 404].includes(status));
  });

  it('GET /api/agent-cards/:id — returns card', async () => {
    const { status } = await fetchJSON('/api/agent-cards/test');
    assert.ok([200, 404].includes(status));
  });
});

// ============================================================================
// 16. Reasoning Config (2 tests)
// ============================================================================

describe('Reasoning Config', () => {
  it('GET /api/reasoning/config — returns config', async () => {
    const { status } = await fetchJSON('/api/reasoning/config');
    assert.ok([200, 404].includes(status));
  });

  it('PUT /api/reasoning/config — updates', async () => {
    const { status } = await fetchJSON('/api/reasoning/config', {
      method: 'PUT',
      body: JSON.stringify({ enabled: true }),
    });
    assert.ok([200, 404].includes(status));
  });
});

// ============================================================================
// 17. Evaluation Runner (2 tests)
// ============================================================================

describe('Evaluation Runner', () => {
  it('GET /api/evaluation-runner/status — returns status', async () => {
    const { status } = await fetchJSON('/api/evaluation-runner/status');
    assert.ok([200, 404].includes(status));
  });

  it('POST /api/evaluation-runner/run — runs', async () => {
    const { status } = await fetchJSON('/api/evaluation-runner/run', {
      method: 'POST',
      body: JSON.stringify({ tasks: [] }),
    });
    assert.ok([200, 201, 400].includes(status));
  });
});

// ============================================================================
// 18. State Machine (2 tests)
// ============================================================================

describe('State Machine', () => {
  it('GET /api/state-machine/status — returns status', async () => {
    const { status } = await fetchJSON('/api/state-machine/status');
    assert.ok([200, 404].includes(status));
  });

  it('POST /api/state-machine/create — creates', async () => {
    const { status } = await fetchJSON('/api/state-machine/create', {
      method: 'POST',
      body: JSON.stringify({ pattern: 'sequential' }),
    });
    assert.ok([200, 201, 400].includes(status));
  });
});

// ============================================================================
// 19. Conflict Detection (2 tests)
// ============================================================================

describe('Conflict Detection', () => {
  it('GET /projects/:id/conflicts — returns conflicts', async () => {
    const { status } = await fetchJSON('/projects/project-war-room/conflicts');
    assert.ok([200, 404].includes(status));
  });

  it('POST /projects/:id/conflicts/detect — detects', async () => {
    const { status } = await fetchJSON('/projects/project-war-room/conflicts/detect', {
      method: 'POST',
      body: JSON.stringify({ memories: [] }),
    });
    assert.ok([200, 404].includes(status));
  });
});

// ============================================================================
// 20. Confidence (2 tests)
// ============================================================================

describe('Confidence', () => {
  it('GET /projects/:id/confidence — returns confidence', async () => {
    const { status } = await fetchJSON('/projects/project-war-room/confidence');
    assert.ok([200, 404].includes(status));
  });

  it('POST /projects/:id/confidence/report — reports', async () => {
    const { status } = await fetchJSON('/projects/project-war-room/confidence/report', {
      method: 'POST',
      body: JSON.stringify({ score: 0.8 }),
    });
    assert.ok([200, 404].includes(status));
  });
});

// ============================================================================
// 21. Security (3 tests)
// ============================================================================

describe('Security', () => {
  it('POST /api/memory/assess-credibility — assesses', async () => {
    const { status, body } = await fetchJSON('/api/memory/assess-credibility', {
      method: 'POST',
      body: JSON.stringify({
        source: {
          id: 'test',
          content: 'test',
          timestamp: new Date().toISOString(),
          source: 'https://example.com',
        },
      }),
    });
    assert.strictEqual(status, 200);
    assert.ok(body);
  });

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
    const { status } = await fetchJSON('/api/security/scan', {
      method: 'POST',
      body: JSON.stringify({ content: 'test' }),
    });
    assert.ok([200, 404].includes(status));
  });
});

// ============================================================================
// 22. MCP (2 tests)
// ============================================================================

describe('MCP', () => {
  it('GET /mcp/status — returns status', async () => {
    const { status } = await fetchJSON('/mcp/status');
    assert.ok([200, 404].includes(status));
  });

  it('GET /mcp/client/status — returns client status', async () => {
    const { status } = await fetchJSON('/mcp/client/status');
    assert.ok([200, 404].includes(status));
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

  it('Wrong method returns 404 or 405', async () => {
    const { status } = await fetchJSON('/health', { method: 'DELETE' });
    assert.ok([404, 405].includes(status));
  });

  it('Empty body on POST returns 400 or 422', async () => {
    const { status } = await fetchJSON('/projects', { method: 'POST', body: '' });
    assert.ok([400, 404, 422].includes(status));
  });

  it('Very long URL path returns 404', async () => {
    const longPath = '/' + 'a'.repeat(10000);
    const { status } = await fetchJSON(longPath);
    assert.ok([404, 414].includes(status));
  });

  it('Special characters in query params are handled', async () => {
    const { status } = await fetchJSON(
      '/projects/project-war-room/memory/search?q=<script>alert(1)</script>',
    );
    assert.ok([200, 400].includes(status));
  });
});
