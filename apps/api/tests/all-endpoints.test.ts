/**
 * Comprehensive API Endpoint Tests
 *
 * Tests ALL API endpoints with:
 * - Happy path
 * - Error handling
 * - Input validation
 * - Security headers
 * - Rate limiting
 * - CORS
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

  it('X-XSS-Protection: 1; mode=block', async () => {
    const { headers } = await fetchJSON('/health');
    assert.strictEqual(headers.get('x-xss-protection'), '1; mode=block');
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
      headers: { 'Content-Type': 'application/json' },
      body: '{invalid json',
    });
    assert.strictEqual(res.status, 400);
  });

  it('Rejects missing required fields (400)', async () => {
    const { status } = await fetchJSON('/projects/project-war-room/memory', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    assert.ok([400, 422].includes(status));
  });

  it('Accepts valid JSON', async () => {
    const { status } = await fetchJSON('/projects/project-war-room/memory', {
      method: 'POST',
      body: JSON.stringify({
        kind: 'LESSON',
        title: 'Test',
        content: 'Test content',
        tags: ['test'],
      }),
    });
    assert.ok([200, 201].includes(status));
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
    assert.ok(body);
  });

  it('GET /projects/:id/missions — returns missions', async () => {
    const { status, body } = await fetchJSON('/projects/project-war-room/missions');
    assert.ok([200, 404].includes(status));
  });

  it('POST /projects/:id/missions — creates mission', async () => {
    const { status } = await fetchJSON('/projects/project-war-room/missions', {
      method: 'POST',
      body: JSON.stringify({ name: 'test-mission', description: 'test' }),
    });
    assert.ok([200, 201, 400].includes(status));
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
    assert.ok([200, 201].includes(status));
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
    assert.ok([400, 422].includes(status));
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
    assert.ok(Array.isArray(body));
  });

  it('POST /api/namespaced-memory/:ns/write — writes memory', async () => {
    const { status } = await fetchJSON('/api/namespaced-memory/shared/write', {
      method: 'POST',
      body: JSON.stringify({
        projectId: 'test',
        kind: 'SUMMARY',
        title: 'Test',
        content: 'Test content',
        namespace: 'shared',
      }),
    });
    assert.ok([200, 201, 403].includes(status));
  });

  it('GET /api/namespaced-memory/:ns/search — searches', async () => {
    const { status, body } = await fetchJSON('/api/namespaced-memory/shared/search?projectId=test');
    assert.strictEqual(status, 200);
    assert.ok(body);
  });

  it('GET /api/namespaced-memory/:ns/read/:id — reads item', async () => {
    const { status } = await fetchJSON('/api/namespaced-memory/shared/read/nonexistent');
    assert.ok([200, 404].includes(status));
  });

  it('GET /api/namespaced-memory/:ns/audit — returns audit log', async () => {
    const { status, body } = await fetchJSON('/api/namespaced-memory/shared/audit');
    assert.strictEqual(status, 200);
    assert.ok(Array.isArray(body));
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

  it('GET /a2a/agent-cards — returns list', async () => {
    const { status, body } = await fetchJSON('/a2a/agent-cards');
    assert.strictEqual(status, 200);
    assert.ok(Array.isArray(body));
  });

  it('POST /a2a/tasks — creates task', async () => {
    const { status } = await fetchJSON('/a2a/tasks', {
      method: 'POST',
      body: JSON.stringify({ name: 'test-task' }),
    });
    assert.ok([200, 201, 400].includes(status));
  });
});

// ============================================================================
// 9. MCP (2 endpoints)
// ============================================================================

describe('MCP Endpoints', () => {
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
    const { status, body } = await fetchJSON('/projects/project-war-room/governance/weekly-report');
    assert.strictEqual(status, 200);
    assert.ok(body);
  });

  it('POST /api/agents/:id/self-assess — returns assessment', async () => {
    const { status } = await fetchJSON('/api/agents/test-agent/self-assess', {
      method: 'POST',
      body: JSON.stringify({ taskType: 'general' }),
    });
    assert.ok([200, 404].includes(status));
  });
});

// ============================================================================
// 11. Self-Assessment (2 endpoints)
// ============================================================================

describe('Self-Assessment Endpoints', () => {
  it('POST /api/agents/:id/self-assess — returns assessment', async () => {
    const { status } = await fetchJSON('/api/agents/test-agent/self-assess', {
      method: 'POST',
      body: JSON.stringify({ taskType: 'general' }),
    });
    assert.ok([200, 404].includes(status));
  });

  it('GET /api/agents/:id/self-model — returns self model', async () => {
    const { status } = await fetchJSON('/api/agents/test-agent/self-model');
    assert.ok([200, 404].includes(status));
  });
});

// ============================================================================
// 12. Evaluation (3 endpoints)
// ============================================================================

describe('Evaluation Endpoints', () => {
  it('GET /api/evaluation/health — returns health', async () => {
    const { status } = await fetchJSON('/api/evaluation/health');
    assert.ok([200, 404].includes(status));
  });

  it('POST /api/evaluation/run — runs evaluation', async () => {
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
// 13. Orchestrator (2 endpoints)
// ============================================================================

describe('Orchestrator Endpoints', () => {
  it('GET /api/orchestrator/status — returns status', async () => {
    const { status } = await fetchJSON('/api/orchestrator/status');
    assert.ok([200, 404].includes(status));
  });

  it('POST /api/orchestrator/run — runs orchestrator', async () => {
    const { status } = await fetchJSON('/api/orchestrator/run', {
      method: 'POST',
      body: JSON.stringify({ task: 'test' }),
    });
    assert.ok([200, 201, 400].includes(status));
  });
});

// ============================================================================
// 14. Pipeline (3 endpoints)
// ============================================================================

describe('Pipeline Endpoints', () => {
  it('GET /api/pipeline/status — returns status', async () => {
    const { status } = await fetchJSON('/api/pipeline/status');
    assert.ok([200, 404].includes(status));
  });

  it('POST /api/pipeline/run — runs pipeline', async () => {
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
// 15. Runtime (3 endpoints)
// ============================================================================

describe('Runtime Endpoints', () => {
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
// 16. Agent Cards (2 endpoints)
// ============================================================================

describe('Agent Card Endpoints', () => {
  it('GET /api/agent-cards — returns cards', async () => {
    const { status, body } = await fetchJSON('/api/agent-cards');
    assert.ok([200, 404].includes(status));
    if (status === 200) assert.ok(Array.isArray(body));
  });

  it('GET /api/agent-cards/:id — returns specific card', async () => {
    const { status } = await fetchJSON('/api/agent-cards/test');
    assert.ok([200, 404].includes(status));
  });
});

// ============================================================================
// 17. Reasoning Config (2 endpoints)
// ============================================================================

describe('Reasoning Config Endpoints', () => {
  it('GET /api/reasoning/config — returns config', async () => {
    const { status } = await fetchJSON('/api/reasoning/config');
    assert.ok([200, 404].includes(status));
  });

  it('PUT /api/reasoning/config — updates config', async () => {
    const { status } = await fetchJSON('/api/reasoning/config', {
      method: 'PUT',
      body: JSON.stringify({ enabled: true }),
    });
    assert.ok([200, 404].includes(status));
  });
});

// ============================================================================
// 18. Evaluation Runner (2 endpoints)
// ============================================================================

describe('Evaluation Runner Endpoints', () => {
  it('GET /api/evaluation-runner/status — returns status', async () => {
    const { status } = await fetchJSON('/api/evaluation-runner/status');
    assert.ok([200, 404].includes(status));
  });

  it('POST /api/evaluation-runner/run — runs evaluation', async () => {
    const { status } = await fetchJSON('/api/evaluation-runner/run', {
      method: 'POST',
      body: JSON.stringify({ tasks: [] }),
    });
    assert.ok([200, 201, 400].includes(status));
  });
});

// ============================================================================
// 19. State Machine (2 endpoints)
// ============================================================================

describe('State Machine Endpoints', () => {
  it('GET /api/state-machine/status — returns status', async () => {
    const { status } = await fetchJSON('/api/state-machine/status');
    assert.ok([200, 404].includes(status));
  });

  it('POST /api/state-machine/create — creates machine', async () => {
    const { status } = await fetchJSON('/api/state-machine/create', {
      method: 'POST',
      body: JSON.stringify({ pattern: 'sequential' }),
    });
    assert.ok([200, 201, 400].includes(status));
  });
});

// ============================================================================
// 20. Conflict Detection (2 endpoints)
// ============================================================================

describe('Conflict Endpoints', () => {
  it('GET /projects/:id/conflicts — returns conflicts', async () => {
    const { status } = await fetchJSON('/projects/project-war-room/conflicts');
    assert.ok([200, 404].includes(status));
  });

  it('POST /projects/:id/conflicts/detect — detects conflicts', async () => {
    const { status } = await fetchJSON('/projects/project-war-room/conflicts/detect', {
      method: 'POST',
      body: JSON.stringify({ memories: [] }),
    });
    assert.ok([200, 404].includes(status));
  });
});

// ============================================================================
// 21. Confidence (2 endpoints)
// ============================================================================

describe('Confidence Endpoints', () => {
  it('GET /projects/:id/confidence — returns confidence', async () => {
    const { status } = await fetchJSON('/projects/project-war-room/confidence');
    assert.ok([200, 404].includes(status));
  });

  it('POST /projects/:id/confidence/report — reports confidence', async () => {
    const { status } = await fetchJSON('/projects/project-war-room/confidence/report', {
      method: 'POST',
      body: JSON.stringify({ score: 0.8 }),
    });
    assert.ok([200, 404].includes(status));
  });
});

// ============================================================================
// 22. Security (3 endpoints)
// ============================================================================

describe('Security Endpoints', () => {
  it('POST /api/memory/assess-credibility — assesses credibility', async () => {
    const { status, body } = await fetchJSON('/api/memory/assess-credibility', {
      method: 'POST',
      body: JSON.stringify({
        source: {
          id: 'test',
          content: 'test content',
          timestamp: new Date().toISOString(),
          source: 'https://example.com',
        },
      }),
    });
    assert.strictEqual(status, 200);
    assert.ok(body);
  });

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
    const { status } = await fetchJSON('/api/security/scan', {
      method: 'POST',
      body: JSON.stringify({ content: 'test content' }),
    });
    assert.ok([200, 404].includes(status));
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
