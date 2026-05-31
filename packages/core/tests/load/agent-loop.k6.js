/**
 * k6 Load Test — Agent Loop & Tool Execution
 *
 * Tests the agent runtime under sustained load, measuring:
 * - Agent loop latency
 * - Tool execution throughput
 * - Error rates under concurrency
 * - Token usage patterns
 *
 * Usage:
 *   k6 run packages/core/tests/load/agent-loop.k6.js
 *
 * Options:
 *   K6_BASE_URL      - Base URL (default: http://127.0.0.1:3001)
 *   K6_VUS           - Virtual users (default: 5)
 *   K6_DURATION      - Test duration (default: 60s)
 *   K6_RAMP_UP       - Ramp up duration (default: 10s)
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend, Counter } from 'k6/metrics';

const BASE_URL = __ENV.K6_BASE_URL || 'http://127.0.0.1:3001';

// Custom metrics
const agentLoopLatency = new Trend('agent_loop_latency');
const toolExecutionLatency = new Trend('tool_execution_latency');
const errorRate = new Rate('errors');
const tokenUsage = new Counter('total_tokens');
const completedTasks = new Counter('completed_tasks');

// Test configuration
export const options = {
  stages: [
    { duration: __ENV.K6_RAMP_UP || '10s', target: __ENV.K6_VUS ? parseInt(__ENV.K6_VUS) : 5 },
    { duration: __ENV.K6_DURATION || '60s', target: __ENV.K6_VUS ? parseInt(__ENV.K6_VUS) : 5 },
    { duration: '10s', target: 0 },
  ],
  thresholds: {
    http_req_duration: ['p(95)<2000'],      // 95% under 2s
    errors: ['rate<0.05'],                   // Error rate under 5%
    agent_loop_latency: ['p(95)<5000'],      // Agent loop under 5s
    tool_execution_latency: ['p(95)<1000'],  // Tool execution under 1s
  },
};

// Test scenarios
const SCENARIOS = [
  {
    name: 'simple_query',
    goal: 'What is 2 + 2?',
    tools: [],
    weight: 0.3,
  },
  {
    name: 'file_read',
    goal: 'Read the package.json file',
    tools: ['file_read'],
    weight: 0.2,
  },
  {
    name: 'web_search',
    goal: 'Search for TypeScript documentation',
    tools: ['web_search'],
    weight: 0.2,
  },
  {
    name: 'multi_tool',
    goal: 'Read a file and search for related information',
    tools: ['file_read', 'web_search'],
    weight: 0.2,
  },
  {
    name: 'code_execution',
    goal: 'Run a simple calculation',
    tools: ['python_execute'],
    weight: 0.1,
  },
];

function selectScenario() {
  const rand = Math.random();
  let cumulative = 0;
  for (const scenario of SCENARIOS) {
    cumulative += scenario.weight;
    if (rand <= cumulative) return scenario;
  }
  return SCENARIOS[0];
}

export default function () {
  const scenario = selectScenario();
  const params = {
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${__ENV.K6_API_KEY || 'test-key'}`,
    },
    timeout: '30s',
  };

  // Test agent loop execution
  {
    const payload = JSON.stringify({
      goal: scenario.goal,
      tools: scenario.tools,
      maxSteps: 3,
      tokenBudget: 4000,
    });

    const start = Date.now();
    const res = http.post(`${BASE_URL}/api/execute`, payload, params);
    const duration = Date.now() - start;

    agentLoopLatency.add(duration);

    const ok = check(res, {
      'agent status is 200 or 202': (r) => [200, 202].includes(r.status),
      'agent has result': (r) => r.json('status') !== undefined,
    });

    if (ok && res.status === 200) {
      const body = res.json();
      if (body.tokenUsage) {
        tokenUsage.add(body.tokenUsage.totalTokens || 0);
      }
      if (body.status === 'success') {
        completedTasks.add(1);
      }
    }

    errorRate.add(!ok);
  }

  // Test tool execution directly (if available)
  if (scenario.tools.length > 0) {
    const toolName = scenario.tools[0];
    let toolPayload;

    switch (toolName) {
      case 'file_read':
        toolPayload = JSON.stringify({ path: 'package.json' });
        break;
      case 'web_search':
        toolPayload = JSON.stringify({ query: 'TypeScript' });
        break;
      case 'python_execute':
        toolPayload = JSON.stringify({ code: 'print(2 + 2)' });
        break;
      default:
        toolPayload = JSON.stringify({});
    }

    const start = Date.now();
    const res = http.post(`${BASE_URL}/api/tools/${toolName}`, toolPayload, params);
    const duration = Date.now() - start;

    toolExecutionLatency.add(duration);

    check(res, {
      [`tool ${toolName} status is 200`]: (r) => r.status === 200,
      [`tool ${toolName} has result`]: (r) => r.json('result') !== undefined || r.json('error') !== undefined,
    });
  }

  sleep(Math.random() * 2 + 0.5); // Random think time 0.5-2.5s
}

// Lifecycle hooks
export function setup() {
  // Verify server is running
  const res = http.get(`${BASE_URL}/health`);
  if (res.status !== 200) {
    throw new Error(`Server not ready at ${BASE_URL}`);
  }
  return { startTime: Date.now() };
}

export function teardown(data) {
  const duration = (Date.now() - data.startTime) / 1000;
  console.log(`Load test completed in ${duration}s`);
}
