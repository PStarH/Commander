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
 * Agent execution moved to the durable V1 run surface. Conversation history is
 * retained as a read/export compatibility surface during migration.
 */
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
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

function sanitizeMessage(input: unknown): string | null {
  if (typeof input !== 'string' || input.length === 0) return null;
  if (input.length > MESSAGE_MAX_LENGTH) return null;
  // Strip control characters except newlines/tabs
  return input.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
}

export function createChatRouter(): Router {
  const router = Router();

  router.post('/api/chat', validateBody(chatBodySchema), (req: Request, res: Response) => {
    try {
      const { message } = req.body;
      const sanitized = sanitizeMessage(message);
      if (!sanitized) {
        return res.status(400).json({ error: 'Message is required and must be non-empty' });
      }
      return res.status(410).json({
        error: {
          code: 'LEGACY_EXECUTION_DISABLED',
          message: 'Synchronous chat execution has been removed.',
          replacement: 'POST /v1/runs',
        },
      });
    } catch (error) {
      res.status(500).json({ error: toErrorMessage(error) });
    }
  });

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
