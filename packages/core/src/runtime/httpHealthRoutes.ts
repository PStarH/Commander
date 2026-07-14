import type { IncomingMessage, ServerResponse } from 'node:http';
import { getMetricsCollector } from './metricsCollector';
import { sendJson } from './httpUtils';
import type { HealthSources } from './healthCheck';

export interface HttpHealthRouteDeps {
  protectHealthEndpoints: boolean;
  authenticate: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;
  buildHealthSources: () => HealthSources;
  activeSessions: () => number;
  busTopicCount: () => number;
  busTopics: () => string[];
  subscriberCounts: () => Record<string, number>;
  rateLimitEntries: () => number;
}

/**
 * Handle /health, /health/detailed, /metrics, /ready.
 * Returns true when the request was handled.
 */
export async function handleHealthRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  segments: string[],
  deps: HttpHealthRouteDeps,
): Promise<boolean> {
  const method = req.method ?? 'GET';
  const protectHealth = deps.protectHealthEndpoints;

  if (segments[0] === 'health' && method === 'GET') {
    if (protectHealth && !(await deps.authenticate(req, res))) return true;
    const { HealthCollector } = await import('./healthCheck');
    const collector = new HealthCollector({ sources: deps.buildHealthSources() });
    const report = await collector.collect();
    const status = report.status === 'healthy' ? 'healthy' : 'degraded';
    sendJson(res, status === 'healthy' ? 200 : 503, {
      status,
      uptime: process.uptime(),
      activeSessions: deps.activeSessions(),
      busTopics: deps.busTopicCount(),
      degradedComponents: report.degradedComponents ?? [],
      timestamp: new Date().toISOString(),
    });
    return true;
  }

  if (segments[0] === 'health' && segments[1] === 'detailed' && method === 'GET') {
    if (protectHealth && !(await deps.authenticate(req, res))) return true;
    const { HealthCollector } = await import('./healthCheck');
    const collector = new HealthCollector({ sources: deps.buildHealthSources() });
    const report = await collector.collect();
    sendJson(res, report.status === 'healthy' ? 200 : 503, {
      ...report,
      uptime: process.uptime(),
      activeSessions: deps.activeSessions(),
      pid: process.pid,
      nodeVersion: process.version,
    });
    return true;
  }

  if (segments[0] === 'metrics' && method === 'GET') {
    if (protectHealth && !(await deps.authenticate(req, res))) return true;
    const accept = req.headers.accept ?? '';
    if (accept.includes('text/plain') || accept.includes('openmetrics')) {
      res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
      res.end(getMetricsCollector().exportOpenMetrics());
    } else {
      const mem = process.memoryUsage();
      sendJson(res, 200, {
        uptime: process.uptime(),
        activeSessions: deps.activeSessions(),
        busTopics: deps.busTopics(),
        subscriberCounts: deps.subscriberCounts(),
        rateLimitEntries: deps.rateLimitEntries(),
        memory: {
          rss: mem.rss,
          heapUsed: mem.heapUsed,
          heapTotal: mem.heapTotal,
          external: mem.external,
        },
        pid: process.pid,
        nodeVersion: process.version,
        timestamp: new Date().toISOString(),
      });
    }
    return true;
  }

  if (segments[0] === 'ready' && method === 'GET') {
    if (protectHealth && !(await deps.authenticate(req, res))) return true;
    const mem = process.memoryUsage();
    const { HealthCollector } = await import('./healthCheck');
    const collector = new HealthCollector({ sources: deps.buildHealthSources() });
    const report = await collector.collect();
    const ready = report.status === 'healthy';
    sendJson(res, ready ? 200 : 503, {
      status: ready ? 'ready' : 'not_ready',
      uptime: process.uptime(),
      activeSessions: deps.activeSessions(),
      busTopics: deps.busTopicCount(),
      memory: { rss: mem.rss, heapUsed: mem.heapUsed },
      degradedComponents: report.degradedComponents ?? [],
      timestamp: new Date().toISOString(),
    });
    return true;
  }

  return false;
}
