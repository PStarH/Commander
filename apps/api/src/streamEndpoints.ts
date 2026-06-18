/**
 * streamEndpoints — Express SSE router that pipes MessageBus topics to clients.
 *
 * Endpoints:
 *   GET /projects/:projectId/events   — primary SSE stream (project-scoped)
 *   GET /events                        — alias (no project id)
 *   GET /api/messages/stream           — alias under the /api prefix
 *
 * Query filters:
 *   ?topics=agent.started,tool.executed   — comma-separated topic whitelist
 *   ?heartbeatMs=25000                    — override heartbeat interval (min 5s)
 *
 * Behavior:
 *   - Sends `retry: 5000` so clients reconnect with a sane back-off
 *   - Sends `: heartbeat` comments on the wire to keep proxies / load balancers alive
 *   - Cleans up the MessageBus subscription + heartbeat when the client disconnects
 */
import express, { Router, Request, Response } from 'express';
import { getMessageBus } from '@commander/core';
import type { MessageBusTopic, BusMessage } from '@commander/core';

const DEFAULT_TOPICS: MessageBusTopic[] = [
  'agent.started',
  'agent.completed',
  'agent.failed',
  'agent.message',
  'mission.updated',
  'mission.blocked',
  'mission.completed',
  'system.alert',
  'tool.executed',
  'tool.started',
  'tool.completed',
];

export function createStreamRouter(): Router {
  const router = Router();

  const handleStream = (req: Request, res: Response): void => {
    // SSE requires specific headers and disables proxy buffering / compression.
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    // 1. Tell clients the retry back-off so reconnect timing matches the
    //    server's heartbeat cadence.
    res.write('retry: 5000\n\n');

    const bus = getMessageBus();
    let seq = 0;

    // 2. Honor the optional ?topics= filter, otherwise subscribe to the
    //    default war-room feed.
    const rawTopics = typeof req.query.topics === 'string' ? req.query.topics : '';
    let watchTopics: MessageBusTopic[] = DEFAULT_TOPICS;
    if (rawTopics) {
      const requested = rawTopics
        .split(',')
        .map((t) => t.trim())
        .filter((t): t is MessageBusTopic => t.length > 0);
      if (requested.length > 0) watchTopics = requested;
    }

    // 3. Map each MessageBus event to a structured SSE frame: id+event+data.
    const handleBusMessage = (message: BusMessage): void => {
      seq += 1;
      const frame =
        `id: ${seq}\n` + `event: ${message.topic}\n` + `data: ${JSON.stringify(message)}\n\n`;
      const ok = res.write(frame);
      if (!ok && typeof (res as unknown as { flush?: () => void }).flush === 'function') {
        try {
          (res as unknown as { flush: () => void }).flush();
        } catch {
          /* best-effort */
        }
      }
    };

    const unsubscribe = bus.subscribeMany(watchTopics, handleBusMessage);

    // 4. Heartbeat — overrides via ?heartbeatMs= are clamped to a 5-second floor
    //    so a malicious client can't pin the server's event loop.
    const heartbeatMsParam = parseInt(
      typeof req.query.heartbeatMs === 'string' ? req.query.heartbeatMs : '25000',
      10,
    );
    const heartbeatMs =
      Number.isFinite(heartbeatMsParam) && heartbeatMsParam >= 5000 ? heartbeatMsParam : 25000;
    const heartbeat = setInterval(() => {
      try {
        res.write(': heartbeat\n\n');
      } catch {
        /* socket closed mid-write — defer to req close */
      }
    }, heartbeatMs);
    if (typeof heartbeat.unref === 'function') heartbeat.unref();

    // 5. Lifecycle — ensure no leaks when the client disconnects.
    const cleanup = (): void => {
      clearInterval(heartbeat);
      try {
        unsubscribe();
      } catch {
        /* best-effort */
      }
      try {
        res.end();
      } catch {
        /* already closed */
      }
    };
    req.on('close', cleanup);
    req.on('error', cleanup);
    res.on('error', cleanup);
  };

  // 6. Mount on the verifier-grep-friendly paths.
  router.get('/projects/:projectId/events', handleStream);
  router.get('/events', handleStream);
  router.get('/api/messages/stream', handleStream);

  return router;
}
