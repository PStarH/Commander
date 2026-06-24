import type { Request, Response, NextFunction } from 'express';

declare global {
  namespace Express {
    interface Request {
      apiKeyId?: string;
    }
  }
}

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

function isPublicPath(path: string): boolean {
  return PUBLIC_PATHS.has(path) || path.startsWith('/health') || path.startsWith('/system');
}

function readHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function authMiddleware(req: Request, res: Response, next: NextFunction) {
  if (process.env.AUTH_DISABLED === 'true') return next();

  const path = req.path;
  if (isPublicPath(path)) {
    return next();
  }

  const apiKeys = parseApiKeys(process.env.API_KEYS);
  const authHeader = readHeader(req.headers.authorization);
  const apiKeyHeader = readHeader(req.headers['x-api-key']);

  let keyId: string | null = null;

  if (apiKeyHeader) {
    if (!apiKeys.has(apiKeyHeader)) {
      res.status(401).json({ error: 'Invalid API key' });
      return;
    }
    keyId = apiKeys.get(apiKeyHeader)!.name;
  } else if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    if (!apiKeys.has(token)) {
      res.status(401).json({ error: 'Invalid bearer token' });
      return;
    }
    keyId = apiKeys.get(token)!.name;
  } else if (apiKeys.size > 0) {
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
