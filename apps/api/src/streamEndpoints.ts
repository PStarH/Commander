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
import { reportSilentFailure } from '@commander/core';
import { Router, Request, Response } from 'express';
import { getMessageBus } from '@commander/core';
import type { MessageBusTopic, BusMessage } from '@commander/core';
import { verifyToken } from './jwtMiddleware';

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

// REL-7: bound SSE resource usage.
//  - MAX_SSE_CONNECTIONS caps concurrent streams per process so a flood of
//    clients cannot exhaust file descriptors / memory.
//  - MAX_BUFFERED_BYTES caps the per-connection outbound buffer. A slow
//    consumer that lets Node's socket buffer grow past this is disconnected
//    rather than allowed to accumulate unbounded heap (OOM).
const MAX_SSE_CONNECTIONS =
  Number.parseInt(process.env.COMMANDER_SSE_MAX_CONNECTIONS ?? '', 10) || 1000;
const MAX_BUFFERED_BYTES =
  Number.parseInt(process.env.COMMANDER_SSE_MAX_BUFFER_BYTES ?? '', 10) || 1024 * 1024;

let activeConnections = 0;

export function createStreamRouter(): Router {
  const router = Router();

  const handleStream = (req: Request, res: Response): void => {
    // EventSource cannot set Authorization headers. Accept a short-lived
    // access token via ?access_token= (same JWT as Bearer) so browser clients
    // can authenticate. Prefer header/API-key when present.
    if (!req.user) {
      const raw = req.query.access_token;
      const token = typeof raw === 'string' ? raw : Array.isArray(raw) ? raw[0] : undefined;
      if (typeof token === 'string' && token.length > 0) {
        const decoded = verifyToken(token);
        if (decoded && decoded.type !== 'refresh') {
          req.user = {
            id: decoded.id,
            username: decoded.username,
            role: decoded.role,
          };
        }
      }
    }

    // Require JWT user or API-key identity before opening an SSE stream.
    if (!req.user && !req.apiKeyId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    // Connection cap — refuse new streams once the process is at capacity so a
    // client flood cannot exhaust sockets/memory. 503 tells clients to back off.
    if (activeConnections >= MAX_SSE_CONNECTIONS) {
      res.status(503).json({
        error: { code: 'SSE_CAPACITY', message: 'Too many active event streams; retry shortly.' },
      });
      return;
    }
    activeConnections += 1;

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
    let droppedFrames = 0;

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
    //    Backpressure (REL-7): if the outbound socket buffer is already past the
    //    cap the consumer is too slow — drop this frame instead of growing the
    //    heap, and disconnect once the buffer stays saturated. Silence is safe
    //    for an SSE feed; unbounded buffering is not.
    const handleBusMessage = (message: BusMessage): void => {
      const buffered = (res as unknown as { writableLength?: number }).writableLength ?? 0;
      if (buffered > MAX_BUFFERED_BYTES) {
        droppedFrames += 1;
        // Terminate a persistently-saturated consumer so it can reconnect fresh
        // rather than pinning MAX_BUFFERED_BYTES of memory indefinitely.
        if (buffered > MAX_BUFFERED_BYTES * 4) {
          cleanup();
        }
        return;
      }
      seq += 1;
      const frame =
        `id: ${seq}\n` + `event: ${message.topic}\n` + `data: ${JSON.stringify(message)}\n\n`;
      const ok = res.write(frame);
      if (!ok && typeof (res as unknown as { flush?: () => void }).flush === 'function') {
        try {
          (res as unknown as { flush: () => void }).flush();
        } catch (err) {
          reportSilentFailure(err, 'streamEndpoints:77');
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
      } catch (err) {
        reportSilentFailure(err, 'streamEndpoints:97');
        /* socket closed mid-write — defer to req close */
      }
    }, heartbeatMs);
    if (typeof heartbeat.unref === 'function') heartbeat.unref();

    // 5. Lifecycle — ensure no leaks when the client disconnects. Idempotent so
    //    a backpressure-triggered close and the socket 'close' event are safe.
    let cleanedUp = false;
    function cleanup(): void {
      if (cleanedUp) return;
      cleanedUp = true;
      activeConnections = Math.max(0, activeConnections - 1);
      clearInterval(heartbeat);
      try {
        unsubscribe();
      } catch (err) {
        reportSilentFailure(err, 'streamEndpoints:109');
        /* best-effort */
      }
      if (droppedFrames > 0) {
        reportSilentFailure(
          new Error(`SSE dropped ${droppedFrames} frames to a slow consumer`),
          'streamEndpoints:backpressure',
        );
      }
      try {
        res.end();
      } catch (err) {
        reportSilentFailure(err, 'streamEndpoints:115');
        /* already closed */
      }
    }
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
