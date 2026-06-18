/**
 * k6 Load Test — Commander HTTP API
 *
 * Usage:
 *   k6 run packages/core/tests/load/load-test.k6.js
 *
 * Options:
 *   K6_BASE_URL  - Base URL (default: http://127.0.0.1:3001)
 *   K6_API_KEY   - API key for authenticated endpoints (optional, public endpoints used)
 *   K6_VUS       - Virtual users (default: 10)
 *   K6_DURATION  - Test duration (default: 30s)
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';

const BASE_URL = __ENV.K6_BASE_URL || 'http://127.0.0.1:3001';
const API_KEY = __ENV.K6_API_KEY || '';

const errorRate = new Rate('errors');
const healthLatency = new Trend('health_latency');
const readyLatency = new Trend('ready_latency');
const metricsLatency = new Trend('metrics_latency');

export const options = {
  vus: __ENV.K6_VUS ? parseInt(__ENV.K6_VUS) : 10,
  duration: __ENV.K6_DURATION || '30s',
  thresholds: {
    http_req_duration: ['p(95)<500'], // 95% of requests must complete below 500ms
    errors: ['rate<0.01'], // Error rate must be below 1%
    health_latency: ['p(95)<200'], // Health endpoint should be fast
  },
};

export default function () {
  const params = {
    headers: { 'Content-Type': 'application/json' },
    timeout: '10s',
  };

  // Test /health (unauthenticated)
  {
    const res = http.get(`${BASE_URL}/health`, params);
    healthLatency.add(res.timings.duration);
    const ok = check(res, {
      'health status is 200': (r) => r.status === 200,
      'health body has status': (r) => r.json('status') === 'ok',
    });
    errorRate.add(!ok);
  }

  // Test /ready (unauthenticated)
  {
    const res = http.get(`${BASE_URL}/ready`, params);
    readyLatency.add(res.timings.duration);
    const ok = check(res, {
      'ready status is 200': (r) => r.status === 200,
      'ready body is ready': (r) => r.json('status') === 'ready',
    });
    errorRate.add(!ok);
  }

  // Test /metrics (unauthenticated)
  {
    const res = http.get(`${BASE_URL}/metrics`, params);
    metricsLatency.add(res.timings.duration);
    const ok = check(res, {
      'metrics status is 200': (r) => r.status === 200,
      'metrics has uptime': (r) => r.json('uptime') !== undefined,
    });
    errorRate.add(!ok);
  }

  // Test /openapi.json (unauthenticated)
  {
    const res = http.get(`${BASE_URL}/openapi.json`, params);
    check(res, {
      'openapi status is 200': (r) => r.status === 200,
      'openapi has valid spec': (r) => r.json('openapi') === '3.0.3',
    });
  }

  sleep(1);
}
