/**
 * Capacity Baseline Load Test
 *
 * Exercises the local Commander API with mocked LLM providers (no API keys).
 * Reports throughput, latency distribution, queue depth, and memory growth.
 */
import { reportSilentFailure } from '../packages/core/src/silentFailureReporter';
import http from 'http';

const API_PORT = process.env.PORT || '4000';
const BASE_URL = `http://localhost:${API_PORT}`;

interface LoadTestOptions {
  concurrency: number;
  totalRequests: number;
  tenantCount: number;
}

interface LoadTestResult {
  totalRequests: number;
  successfulRuns: number;
  failedRuns: number;
  averageLatencyMs: number;
  p95LatencyMs: number;
  p99LatencyMs: number;
  maxConcurrentRuns: number;
  peakQueueDepth: number;
  memoryGrowthMB: number;
  throughputRps: number;
  capacity: unknown;
}

function postJson(path: string, body: unknown, tenantId?: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      `${BASE_URL}${path}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Tenant-ID': tenantId ?? 'load-test',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (err) {
            reportSilentFailure(err, 'capacity-baseline:54');
            resolve({ raw: data, statusCode: res.statusCode });
          }
        });
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function getJson(path: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    http
      .get(`${BASE_URL}${path}`, (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (err) {
            reportSilentFailure(err, 'capacity-baseline:78');
            resolve({ raw: data, statusCode: res.statusCode });
          }
        });
      })
      .on('error', reject);
  });
}

async function healthCheck(): Promise<void> {
  for (let i = 0; i < 30; i++) {
    try {
      const res = await getJson('/health');
      if ((res as Record<string, unknown>).status) return;
    } catch (err) {
      reportSilentFailure(err, 'capacity-baseline:93');
      /* not ready yet */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('API health check timed out');
}

async function runLoadTest(options: LoadTestOptions): Promise<LoadTestResult> {
  const { concurrency, totalRequests, tenantCount } = options;
  const latencies: number[] = [];
  let completed = 0;
  let failed = 0;

  await healthCheck();

  const startHeap = process.memoryUsage().heapUsed;
  const startTime = Date.now();
  const queue: number[] = Array.from({ length: totalRequests }, (_, i) => i);

  async function worker(): Promise<void> {
    while (true) {
      const idx = queue.pop();
      if (idx === undefined) return;
      const tenantId = `tenant-${idx % tenantCount}`;
      const start = Date.now();
      try {
        const result = (await postJson(
          '/api/runtime/execute',
          {
            agentId: `load-agent-${idx}`,
            goal: 'Return a concise greeting.',
            availableTools: [],
            tokenBudget: 1000,
          },
          tenantId,
        )) as Record<string, unknown>;
        latencies.push(Date.now() - start);
        if (result.status === 'success') completed++;
        else failed++;
      } catch (err) {
        reportSilentFailure(err, 'capacity-baseline:134');
        failed++;
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  const durationMs = Date.now() - startTime;
  const endHeap = process.memoryUsage().heapUsed;
  latencies.sort((a, b) => a - b);
  const avg = latencies.length > 0 ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0;
  const p95 = latencies[Math.floor(latencies.length * 0.95)] ?? 0;
  const p99 = latencies[Math.floor(latencies.length * 0.99)] ?? 0;

  const capacity = await getJson('/health/capacity');
  const cap = capacity as Record<string, unknown>;
  const queueInfo = (cap.queue as Record<string, unknown>) ?? {};
  const tenants = (queueInfo.tenants as Array<Record<string, unknown>>) ?? [];

  return {
    totalRequests,
    successfulRuns: completed,
    failedRuns: failed,
    averageLatencyMs: Math.round(avg),
    p95LatencyMs: p95,
    p99LatencyMs: p99,
    maxConcurrentRuns: tenants.reduce((max, t) => Math.max(max, (t.activeRuns as number) ?? 0), 0),
    peakQueueDepth: (queueInfo.totalQueued as number) ?? 0,
    memoryGrowthMB: Math.floor((endHeap - startHeap) / 1024 / 1024),
    throughputRps: Number((totalRequests / (durationMs / 1000)).toFixed(2)),
    capacity,
  };
}

const concurrency = parseInt(process.env.CAPACITY_CONCURRENCY ?? '20', 10);
const totalRequests = parseInt(process.env.CAPACITY_REQUESTS ?? '100', 10);
const tenantCount = parseInt(process.env.CAPACITY_TENANTS ?? '5', 10);

runLoadTest({ concurrency, totalRequests, tenantCount })
  .then((result) => {
    console.log(JSON.stringify(result, null, 2));
    const healthy = result.failedRuns / result.totalRequests < 0.05;
    process.exit(healthy ? 0 : 1);
  })
  .catch((err) => {
    console.error('Load test failed:', err);
    process.exit(1);
  });
