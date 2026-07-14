import { describe, it, expect } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  assertBodyTenant,
  assertTenantAccess,
  hashSecret,
  requireTenant,
  resolveTenantFromAuth,
} from '../../src/runtime/httpTenantGate';

function mockRes(): ServerResponse & { status: number; body: string; writableEnded: boolean } {
  let status = 0;
  let body = '';
  let ended = false;
  return {
    writableEnded: false,
    get status() {
      return status;
    },
    get body() {
      return body;
    },
    writeHead(code: number) {
      status = code;
      ended = true;
      this.writableEnded = true;
    },
    end(chunk?: string) {
      if (chunk) body = chunk;
      ended = true;
      this.writableEnded = true;
    },
  } as ServerResponse & { status: number; body: string; writableEnded: boolean };
}

describe('httpTenantGate', () => {
  const tenantMap = new Map<string, string>([[hashSecret('tenant-a-key'), 'tenant-a']]);

  it('resolveTenantFromAuth maps hashed bearer key to tenant', () => {
    const req = {
      headers: { authorization: 'Bearer tenant-a-key' },
    } as IncomingMessage;
    expect(resolveTenantFromAuth(req, tenantMap)).toBe('tenant-a');
  });

  it('requireTenant returns 401 when multi-tenant mode has no mapped key', () => {
    const res = mockRes();
    const req = { url: '/api/v1/execute', headers: {} } as IncomingMessage;
    const tenantId = requireTenant(req, res, tenantMap);
    expect(tenantId).toBeUndefined();
    expect(res.status).toBe(401);
    expect(res.body).toMatch(/Tenant required/);
  });

  it('assertTenantAccess denies cross-tenant access with 403', () => {
    const res = mockRes();
    const allowed = assertTenantAccess(res, 'tenant-a', 'tenant-b', '/api/v1/execute', tenantMap);
    expect(allowed).toBe(false);
    expect(res.status).toBe(403);
    expect(res.body).toMatch(/Cross-tenant access denied/);
  });

  it('assertBodyTenant allows matching tenantId in request body', () => {
    const res = mockRes();
    const req = { url: '/api/v1/execute' } as IncomingMessage;
    expect(assertBodyTenant(req, res, 'tenant-a', { tenantId: 'tenant-a' }, tenantMap)).toBe(true);
    expect(res.writableEnded).toBe(false);
  });

  it('assertBodyTenant rejects mismatched tenantId in request body', () => {
    const res = mockRes();
    const req = { url: '/api/v1/execute' } as IncomingMessage;
    expect(assertBodyTenant(req, res, 'tenant-a', { tenantId: 'tenant-b' }, tenantMap)).toBe(false);
    expect(res.status).toBe(403);
  });

  it('single-tenant mode passes through without tenant map', () => {
    const emptyMap = new Map<string, string>();
    const res = mockRes();
    expect(assertTenantAccess(res, undefined, 'any-tenant', '/x', emptyMap)).toBe(true);
  });
});
