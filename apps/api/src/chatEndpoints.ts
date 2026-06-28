/**
 * chatEndpoints — Conversational interaction endpoint for Human-Agent interaction.
 *
 * Endpoint:
 *   POST /api/chat          — send a message and get a response from an Agent
 *   GET  /api/chat/history   — retrieve conversation history
 *
 * This closes GAP-02 from the UX audit report: the framework had conversationStore
 * and agentInbox infrastructure but no conversational interaction entry point.
 *
 * The endpoint delegates to the shared AgentRuntime, using the user's message
 * as the execution goal. Responses are streamed via the existing SSE infrastructure
 * (/projects/:projectId/events) for real-time thought/tool_call/output chunks.
 */
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { getSharedRuntime } from './sharedRuntime';
import { getMessageBus } from '@commander/core';
import type { MessageBusTopic } from '@commander/core';
import { toErrorMessage } from './routeHelpers';
import { validateBody } from './validationMiddleware';

const MESSAGE_MAX_LENGTH = 8192;

const chatBodySchema = z.object({
  message: z.string().min(1).max(MESSAGE_MAX_LENGTH),
  agentId: z.string().max(128).optional(),
  missionId: z.string().max(128).optional(),
  projectId: z.string().max(128).optional(),
});

interface ChatHistoryEntry {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
  agentId?: string;
  runId?: string;
}

// ── In-memory conversation store (per project) ─────────────────────────
const conversations = new Map<string, ChatHistoryEntry[]>();

function getHistory(projectId: string): ChatHistoryEntry[] {
  if (!conversations.has(projectId)) {
    conversations.set(projectId, []);
  }
  return conversations.get(projectId)!;
}

function addToHistory(projectId: string, entry: ChatHistoryEntry): void {
  const history = getHistory(projectId);
  history.push(entry);
  // Keep last 100 messages to prevent unbounded growth
  if (history.length > 100) {
    history.splice(0, history.length - 100);
  }
}

function sanitizeMessage(input: unknown): string | null {
  if (typeof input !== 'string' || input.length === 0) return null;
  if (input.length > MESSAGE_MAX_LENGTH) return null;
  // Strip control characters except newlines/tabs
  return input.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
}

export function createChatRouter(): Router {
  const router = Router();

  // ── POST /api/chat — send message to Agent ──────────────────────────
  // Supports `?stream=true` for Server-Sent Events (SSE) streaming.
  //   Non-stream: returns a single JSON { reply, agentId, runId, timestamp }.
  //   Stream:     emits `start` → 0..n `step` (thought/tool_call/tool_result)
  //               → `done` → `data: [DONE]` frames.
  router.post(
    '/api/chat',
    validateBody(chatBodySchema),
    async (req: Request, res: Response) => {
      try {
        const { message, agentId, missionId, projectId } = req.body;
        const sanitized = sanitizeMessage(message);
        if (!sanitized) {
          return res.status(400).json({ error: 'Message is required and must be non-empty' });
        }

        const resolvedAgentId = agentId || 'agent-commander';
        const resolvedProjectId = projectId || 'project-war-room';
        const stream = req.query.stream === 'true';

        // Record user message in conversation history
        addToHistory(resolvedProjectId, {
          role: 'user',
          content: sanitized,
          timestamp: new Date().toISOString(),
          agentId: resolvedAgentId,
        });

        const runtime = getSharedRuntime();

        // ── Streaming mode: SSE ───────────────────────────────────────
        if (stream) {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
          });

          const writeFrame = (event: string, data: unknown): void => {
            res.write(`event: ${event}\n`);
            res.write(`data: ${JSON.stringify(data)}\n\n`);
          };

          // Signal the start of the stream so the client can render a placeholder.
          writeFrame('start', {
            agentId: resolvedAgentId,
            timestamp: new Date().toISOString(),
          });

          // Forward MessageBus events as `step` chunks for real-time UX.
          // The runtime publishes these topics during execution; we translate
          // them into thought/tool_call/tool_result step frames.
          const bus = getMessageBus();
          const busTopics: MessageBusTopic[] = [
            'agent.message',
            'tool.started',
            'tool.executed',
            'tool.completed',
          ];
          let clientClosed = false;
          const unsubscribe = bus.subscribeMany(busTopics, (msg) => {
            if (clientClosed) return;
            try {
              const payload =
                (msg as { payload?: Record<string, unknown> }).payload ?? {};
              if (msg.topic === 'agent.message' && typeof payload.content === 'string') {
                writeFrame('step', {
                  type: 'thought',
                  content: payload.content,
                  timestamp: msg.timestamp,
                });
              } else if (msg.topic === 'tool.started' && typeof payload.toolName === 'string') {
                writeFrame('step', {
                  type: 'tool_call',
                  content: `Calling tool: ${payload.toolName}`,
                  toolName: payload.toolName,
                  timestamp: msg.timestamp,
                });
              } else if (
                (msg.topic === 'tool.executed' || msg.topic === 'tool.completed') &&
                typeof payload.toolName === 'string'
              ) {
                const success = payload.success !== false;
                writeFrame('step', {
                  type: 'tool_result',
                  content: `Tool ${payload.toolName} ${success ? 'completed' : 'failed'}`,
                  toolName: payload.toolName,
                  success,
                  timestamp: msg.timestamp,
                });
              }
            } catch {
              /* best-effort — never let bus forwarding break the stream */
            }
          });

          const cleanupBus = (): void => {
            if (clientClosed) return;
            clientClosed = true;
            try {
              unsubscribe();
            } catch {
              /* best-effort */
            }
          };
          req.on('close', cleanupBus);
          req.on('error', cleanupBus);

          try {
            const result = await runtime.execute({
              agentId: resolvedAgentId,
              projectId: resolvedProjectId,
              missionId,
              goal: sanitized,
              contextData: {},
              availableTools: [],
              tokenBudget: 50000,
              maxSteps: 20,
            });

            cleanupBus();

            const reply =
              result.summary ||
              (result.status === 'success' ? 'Task completed.' : `Task ${result.status}.`);

            const responseEntry: ChatHistoryEntry = {
              role: 'assistant',
              content: reply,
              timestamp: new Date().toISOString(),
              agentId: resolvedAgentId,
              runId: result.runId,
            };
            addToHistory(resolvedProjectId, responseEntry);

            // Final consolidated reply + completion marker.
            writeFrame('done', {
              reply,
              agentId: resolvedAgentId,
              runId: result.runId,
              timestamp: responseEntry.timestamp,
            });
            res.write('data: [DONE]\n\n');
            res.end();
          } catch (err) {
            cleanupBus();
            writeFrame('error', { error: toErrorMessage(err) });
            res.write('data: [DONE]\n\n');
            res.end();
          }
          return;
        }

        // ── Default (non-streaming) mode ─────────────────────────────
        const result = await runtime.execute({
          agentId: resolvedAgentId,
          projectId: resolvedProjectId,
          missionId,
          goal: sanitized,
          contextData: {},
          availableTools: [],
          tokenBudget: 50000,
          maxSteps: 20,
        });

        // Extract the reply text from the result
        const reply =
          result.summary ||
          (result.status === 'success' ? 'Task completed.' : `Task ${result.status}.`);

        const responseEntry: ChatHistoryEntry = {
          role: 'assistant',
          content: reply,
          timestamp: new Date().toISOString(),
          agentId: resolvedAgentId,
          runId: result.runId,
        };
        addToHistory(resolvedProjectId, responseEntry);

        res.json({
          reply,
          agentId: resolvedAgentId,
          runId: result.runId,
          timestamp: responseEntry.timestamp,
        });
      } catch (error) {
        res.status(500).json({ error: toErrorMessage(error) });
      }
    },
  );

  // ── GET /api/chat/history — retrieve conversation history ───────────
  router.get('/api/chat/history', (req: Request, res: Response) => {
    try {
      const projectId = (req.query.projectId as string) || 'project-war-room';
      const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);
      const history = getHistory(projectId);
      const recent = history.slice(-limit);
      res.json({ messages: recent, total: history.length });
    } catch (error) {
      res.status(500).json({ error: toErrorMessage(error) });
    }
  });

  // ── DELETE /api/chat/history — clear conversation history ───────────
  router.delete('/api/chat/history', (req: Request, res: Response) => {
    try {
      const projectId = (req.query.projectId as string) || 'project-war-room';
      conversations.delete(projectId);
      res.json({ status: 'cleared' });
    } catch (error) {
      res.status(500).json({ error: toErrorMessage(error) });
    }
  });

  return router;
}
