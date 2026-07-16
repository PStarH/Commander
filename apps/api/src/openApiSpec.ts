const API_PORT = parseInt(process.env.PORT ?? '4000', 10);

export function getOpenApiSpec(version: string) {
  return {
    openapi: '3.1.0',
    info: {
      title: 'Commander Multi-Agent Framework API',
      version,
      description:
        'Local-first multi-agent orchestration (v0.2 · beta). The /v1 surface is the Enterprise Gateway SKU: a durable, multi-tenant kernel path (alpha) with governance, quality gates, and memory management.',
    },
    servers: [{ url: `http://localhost:${API_PORT}`, description: 'Local development' }],
    tags: [
      { name: 'Projects', description: 'Project and agent management' },
      { name: 'Missions', description: 'Mission lifecycle' },
      { name: 'Memory', description: 'Memory stores (standard, namespaced, RBAC)' },
      { name: 'Quality', description: 'Quality gates: hallucination, consensus, handoff' },
      { name: 'Governance', description: 'Governance monitoring and alerts' },
      { name: 'Evaluation', description: 'Agent evaluation and grading' },
      { name: 'A2A', description: 'Google Agent-to-Agent protocol' },
      { name: 'System', description: 'Health and status' },
    ],
    paths: {
      '/v1/runs': {
        post: {
          tags: ['Runs'],
          summary: 'Submit a durable agent run',
          description:
            'Asynchronously submits work to the shared execution kernel. Requires Idempotency-Key and a tenant-bound identity.',
          parameters: [
            {
              name: 'Idempotency-Key',
              in: 'header',
              required: true,
              schema: { type: 'string', minLength: 8, maxLength: 256 },
            },
          ],
          responses: {
            '202': { description: 'Run accepted for scheduling' },
            '200': { description: 'Idempotent replay of an existing run' },
            '409': { description: 'Idempotency key reused with a different request' },
            '503': { description: 'Shared kernel or policy snapshot unavailable' },
          },
        },
      },
      '/v1/runs/{runId}': {
        get: {
          tags: ['Runs'],
          summary: 'Get a durable run',
          parameters: [{ name: 'runId', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': { description: 'Run' }, '404': { description: 'Not found' } },
        },
      },
      '/v1/runs/{runId}/events': {
        get: {
          tags: ['Runs'],
          summary: 'List durable run events',
          parameters: [{ name: 'runId', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': { description: 'Ordered event timeline' } },
        },
      },
      '/health': {
        get: {
          tags: ['System'],
          summary: 'Health check',
          responses: { '200': { description: 'OK' } },
        },
      },
      '/system/status': {
        get: {
          tags: ['System'],
          summary: 'Module health status',
          responses: { '200': { description: 'Status of all modules' } },
        },
      },
      '/projects': {
        get: {
          tags: ['Projects'],
          summary: 'List all projects',
          responses: { '200': { description: 'Project list' } },
        },
      },
      '/projects/{projectId}/war-room': {
        get: {
          tags: ['Projects'],
          summary: 'War room snapshot',
          parameters: [
            { name: 'projectId', in: 'path', required: true, schema: { type: 'string' } },
          ],
          responses: { '200': { description: 'War room data' } },
        },
      },
      '/projects/{projectId}/missions': {
        post: {
          tags: ['Missions'],
          summary: 'Create mission',
          responses: { '201': { description: 'Created' } },
        },
      },
      '/missions/{missionId}': {
        patch: {
          tags: ['Missions'],
          summary: 'Update mission',
          responses: { '200': { description: 'Updated' } },
        },
      },
      '/missions/{missionId}/logs': {
        post: {
          tags: ['Missions'],
          summary: 'Add mission log',
          responses: { '200': { description: 'OK' } },
        },
      },
      '/projects/{projectId}/memory': {
        get: { tags: ['Memory'], summary: 'List memories' },
        post: { tags: ['Memory'], summary: 'Create memory' },
      },
      '/projects/{projectId}/memory/search': {
        get: { tags: ['Memory'], summary: 'Search memories' },
      },
      '/api/quality/check': {
        post: {
          tags: ['Quality'],
          summary: 'Run all quality gates',
          requestBody: {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    input: { type: 'string' },
                    output: { type: 'string', required: true },
                  },
                },
              },
            },
          },
          responses: { '200': { description: 'Quality gate results' } },
        },
      },
      '/api/quality/hallucination-check': {
        post: {
          tags: ['Quality'],
          summary: 'Hallucination detection',
          responses: { '200': { description: 'Hallucination report' } },
        },
      },
      '/api/memory/assess-credibility': {
        post: {
          tags: ['Memory'],
          summary: 'Source credibility assessment',
          responses: { '200': { description: 'Credibility score' } },
        },
      },
      '/api/memory/detect-poisoning': {
        post: {
          tags: ['Memory'],
          summary: 'Batch poisoning detection',
          responses: { '200': { description: 'Poisoning indicators' } },
        },
      },
      '/api/agents/{agentId}/self-assess': {
        post: {
          tags: ['Governance'],
          summary: 'Agent self-assessment',
          responses: { '200': { description: 'Assessment result' } },
        },
      },
      '/api/agents/{agentId}/self-model': {
        get: {
          tags: ['Governance'],
          summary: 'Agent self-model',
          responses: { '200': { description: 'Self model' } },
        },
      },
      '/projects/{projectId}/governance/stats': {
        get: {
          tags: ['Governance'],
          summary: 'Governance statistics',
          responses: { '200': { description: 'Stats' } },
        },
      },
      '/projects/{projectId}/governance/alerts': {
        get: {
          tags: ['Governance'],
          summary: 'Governance alerts',
          responses: { '200': { description: 'Alerts' } },
        },
      },
      '/projects/{projectId}/governance/weekly-report': {
        get: {
          tags: ['Governance'],
          summary: 'Weekly governance report',
          responses: { '200': { description: 'Report' } },
        },
      },
      '/api/namespaced-memory/{namespace}/write': {
        post: {
          tags: ['Memory'],
          summary: 'RBAC memory write',
          responses: {
            '200': { description: 'Written' },
            '403': { description: 'Permission denied' },
          },
        },
      },
      '/api/namespaced-memory/{namespace}/read/{id}': {
        get: {
          tags: ['Memory'],
          summary: 'RBAC memory read',
          responses: {
            '200': { description: 'Memory item' },
            '403': { description: 'Permission denied' },
          },
        },
      },
      '/api/namespaced-memory/{namespace}/search': {
        get: {
          tags: ['Memory'],
          summary: 'RBAC memory search',
          responses: { '200': { description: 'Search results' } },
        },
      },
      '/api/namespaced-memory/{namespace}/stats': {
        get: {
          tags: ['Memory'],
          summary: 'Namespace stats',
          responses: { '200': { description: 'Stats' } },
        },
      },
      '/api/namespaced-memory/{namespace}/audit': {
        get: {
          tags: ['Memory'],
          summary: 'Audit log',
          responses: { '200': { description: 'Audit entries' } },
        },
      },
      '/api/namespaced-memory/acl': {
        get: {
          tags: ['Memory'],
          summary: 'ACL rules',
          responses: { '200': { description: 'Rules' } },
        },
      },
      '/a2a/.well-known/agent-card': {
        get: {
          tags: ['A2A'],
          summary: 'Agent card (A2A protocol)',
          responses: { '200': { description: 'Agent card' } },
        },
      },
      '/a2a/agent-cards': {
        get: {
          tags: ['A2A'],
          summary: 'List agent cards',
          responses: { '200': { description: 'Cards' } },
        },
      },
      '/a2a/tasks': {
        post: {
          tags: ['A2A'],
          summary: 'Create A2A task',
          responses: { '201': { description: 'Task created' } },
        },
      },
    },
  };
}
