import * as crypto from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendJson } from './httpUtils';

export function hashSecret(secret: string): string {
  return crypto.createHash('sha256').update(secret).digest('hex');
}

export function extractAuthKey(req: IncomingMessage): string | undefined {
  const auth = req.headers.authorization;
  if (!auth) return undefined;
  return auth.startsWith('Bearer ') ? auth.slice(7) : auth;
}

/** Resolve tenant ID from the Authorization header using configured API key mapping. */
export function resolveTenantFromAuth(
  req: IncomingMessage,
  tenantApiKeyHashes: ReadonlyMap<string, string>,
): string | undefined {
  const key = extractAuthKey(req);
  if (!key) return undefined;
  return tenantApiKeyHashes.get(hashSecret(key));
}

/**
 * Tenant gate for multi-tenant-aware handlers.
 * Returns undefined and sends 401 when multi-tenant mode requires a mapped key.
 */
export function requireTenant(
  req: IncomingMessage,
  res: ServerResponse,
  tenantApiKeyHashes: ReadonlyMap<string, string>,
): string | undefined {
  if (tenantApiKeyHashes.size === 0) {
    return resolveTenantFromAuth(req, tenantApiKeyHashes);
  }
  const tenantId = resolveTenantFromAuth(req, tenantApiKeyHashes);
  if (!tenantId) {
    sendJson(res, 401, {
      error: `Tenant required for ${req.url}. Configure tenantApiKeyHashes and send a mapped API key.`,
    });
  }
  return tenantId;
}

/**
 * Cross-tenant authorization gate. Denies when authenticated tenant !== target tenant.
 */
export function assertTenantAccess(
  res: ServerResponse,
  authenticatedTenant: string | undefined,
  targetTenant: string | undefined,
  url: string,
  tenantApiKeyHashes: ReadonlyMap<string, string>,
): boolean {
  if (tenantApiKeyHashes.size === 0) return true;
  if (!targetTenant) return true;
  if (authenticatedTenant === targetTenant) return true;
  sendJson(res, 403, {
    error: `Cross-tenant access denied: authenticated tenant "${authenticatedTenant ?? 'unknown'}" cannot access resources for tenant "${targetTenant}" on ${url}.`,
  });
  return false;
}

/** When body carries an explicit tenantId, enforce it matches the authenticated tenant. */
export function assertBodyTenant(
  req: IncomingMessage,
  res: ServerResponse,
  authenticatedTenant: string | undefined,
  body: { tenantId?: string },
  tenantApiKeyHashes: ReadonlyMap<string, string>,
): boolean {
  if (!body.tenantId) return true;
  return assertTenantAccess(
    res,
    authenticatedTenant,
    body.tenantId,
    req.url ?? '',
    tenantApiKeyHashes,
  );
}
