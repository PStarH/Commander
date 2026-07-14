/**
 * HTTP RBAC gate — integrates AuthManager roles with API routes (M6).
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { getAuthManager, type AuthRole } from './authManager';
import { extractAuthKey, hashSecret } from './httpTenantGate';
import { sendJson } from './httpUtils';

export interface HttpAuthContext {
  tenantId?: string;
  role: AuthRole;
  username?: string;
  authSource: 'auth_manager' | 'tenant_key' | 'anonymous';
}

const TENANT_KEY_DEFAULT_ROLE: AuthRole = 'operator';

export function isRbacEnabled(): boolean {
  return process.env.COMMANDER_RBAC_ENABLED === '1';
}

/**
 * Resolve auth context from Bearer token: AuthManager first, then tenant key map.
 */
export function resolveHttpAuthContext(
  req: IncomingMessage,
  tenantApiKeyHashes: ReadonlyMap<string, string>,
): HttpAuthContext {
  const rawKey = extractAuthKey(req);
  if (rawKey) {
    const authResult = getAuthManager().authenticate(rawKey);
    if (authResult) {
      return {
        role: authResult.role,
        username: authResult.user.username,
        authSource: 'auth_manager',
      };
    }
    const tenantId = tenantApiKeyHashes.get(hashSecret(rawKey));
    if (tenantId) {
      return {
        tenantId,
        role: TENANT_KEY_DEFAULT_ROLE,
        authSource: 'tenant_key',
      };
    }
  }
  return { role: 'viewer', authSource: 'anonymous' };
}

/**
 * Enforce minimum role when RBAC is enabled. Returns false and sends 403 when denied.
 */
export function requireMinRole(
  res: ServerResponse,
  ctx: HttpAuthContext,
  minRole: AuthRole,
  route: string,
): boolean {
  if (!isRbacEnabled()) return true;
  if (getAuthManager().hasPermission(ctx.role, minRole)) return true;
  sendJson(res, 403, {
    error: `Insufficient permissions for ${route}. Required role: ${minRole}, has: ${ctx.role}.`,
  });
  return false;
}
