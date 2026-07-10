import type { Request, Response, NextFunction } from 'express';
import { runWithTenant, TenantIsolationError } from '@commander/core/runtime/tenantContext';

/** Tenant ID format: alphanumeric, hyphen, underscore, dot, colon. Must not be empty. */
const TENANT_ID_RE = /^[a-zA-Z0-9._:-]{1,128}$/;

function readHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Express middleware that binds the async tenant context for the remainder of
 * the request pipeline.
 *
 * Resolution order:
 *   1. `req.tenantId` (typically set by authMiddleware from an API key mapping)
 *   2. `X-Tenant-ID` HTTP header
 *
 * If neither produces a tenant ID, the request proceeds in single-tenant mode.
 * If a tenant ID is present but does not match the allowed format, the request
 * is rejected with 400 and a `TenantIsolationError`.
 */
export function tenantContextMiddleware(req: Request, res: Response, next: NextFunction): void {
  const raw = (req as Request & { tenantId?: string }).tenantId ?? req.headers['x-tenant-id'];
  const tenantId = readHeader(raw);

  if (typeof tenantId !== 'string' || tenantId.length === 0) {
    return next();
  }

  if (!TENANT_ID_RE.test(tenantId)) {
    const err = new TenantIsolationError(
      `Invalid tenant id: must be 1-128 chars matching ${TENANT_ID_RE.source}`,
    );
    res.status(400).json({
      error: err.name,
      message: err.message,
    });
    return;
  }

  runWithTenant(tenantId, () => next());
}
