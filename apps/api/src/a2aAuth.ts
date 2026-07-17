/**
 * Shared A2A bearer auth — aligns Gateway HTTP with core A2AServer hard rule:
 * authToken (≥16 chars) required; missing → 500; mismatch → 401.
 */
import crypto from 'node:crypto';
import type { RequestHandler } from 'express';

export function resolveA2AAuthToken(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const token = env.COMMANDER_A2A_AUTH_TOKEN ?? env.A2A_AUTH_TOKEN;
  if (!token || token.length < 16) return undefined;
  return token;
}

function timingSafeEqualString(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

export type A2AAuthResponseMode = 'jsonrpc' | 'rest';

export function requireA2ABearerAuth(options?: {
  /** Override token (tests). `null` simulates misconfiguration. */
  token?: string | null;
  mode?: A2AAuthResponseMode;
}): RequestHandler {
  const mode = options?.mode ?? 'jsonrpc';
  return (req, res, next) => {
    const token =
      options && 'token' in options ? options.token ?? undefined : resolveA2AAuthToken();

    if (!token) {
      const message =
        'A2A server authToken is not configured. Refusing unauthenticated requests.';
      if (mode === 'jsonrpc') {
        return res.status(500).json({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32005, message },
        });
      }
      return res.status(500).json({ error: message, code: -32005 });
    }

    const provided = req.headers.authorization ?? '';
    const expected = `Bearer ${token}`;
    if (!timingSafeEqualString(provided, expected)) {
      if (mode === 'jsonrpc') {
        return res.status(401).json({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32001, message: 'Unauthorized' },
        });
      }
      return res.status(401).json({ error: 'Unauthorized' });
    }

    return next();
  };
}
