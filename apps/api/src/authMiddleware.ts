import type { Request, Response, NextFunction } from 'express';

declare global {
  namespace Express {
    interface Request {
      apiKeyId?: string;
    }
  }
}

const API_KEYS = parseApiKeys(process.env.API_KEYS);
const AUTH_DISABLED = process.env.AUTH_DISABLED === 'true';
const PUBLIC_PATHS = new Set([
  '/health',
  '/system/status',
  '/api/openapi.json',
  '/a2a/.well-known/agent-card',
  '/mcp/.well-known/mcp',
]);

function parseApiKeys(raw: string | undefined): Map<string, { name: string; scopes: string[] }> {
  const keys = new Map<string, { name: string; scopes: string[] }>();
  if (!raw) return keys;
  for (const entry of raw.split(',')) {
    const parts = entry.trim().split(':');
    if (parts.length >= 1 && parts[0]) {
      const name = parts[1] ?? parts[0].slice(0, 8);
      const scopes = parts[2]?.split(';') ?? ['read', 'write'];
      keys.set(parts[0], { name, scopes });
    }
  }
  return keys;
}

export function authMiddleware(req: Request, res: Response, next: NextFunction) {
  if (AUTH_DISABLED) return next();

  const path = req.path;
  if (PUBLIC_PATHS.has(path) || path.startsWith('/health') || path.startsWith('/system')) {
    return next();
  }

  const authHeader = req.headers.authorization;
  const apiKeyHeader = req.headers['x-api-key'] as string | undefined;

  let keyId: string | null = null;

  if (apiKeyHeader) {
    if (!API_KEYS.has(apiKeyHeader)) {
      res.status(401).json({ error: 'Invalid API key' });
      return;
    }
    keyId = API_KEYS.get(apiKeyHeader)!.name;
  } else if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    if (!API_KEYS.has(token)) {
      res.status(401).json({ error: 'Invalid bearer token' });
      return;
    }
    keyId = API_KEYS.get(token)!.name;
  } else if (API_KEYS.size > 0) {
    res.status(401).json({
      error: 'Authentication required',
      hint: 'Provide X-API-Key header or Authorization: Bearer <token>',
    });
    return;
  }

  if (keyId) {
    req.apiKeyId = keyId;
  }

  next();
}
