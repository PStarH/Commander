import { describe, it, expect, beforeEach } from 'vitest';
import { AuthManager } from '../../src/runtime/authManager';
import {
  resolveHttpAuthContext,
  requireMinRole,
  isRbacEnabled,
} from '../../src/runtime/httpRbacGate';
import { hashSecret } from '../../src/runtime/httpTenantGate';
import type { ServerResponse } from 'node:http';

describe('httpRbacGate', () => {
  let auth: AuthManager;
  let ended = false;
  let statusCode = 200;
  let body: unknown;

  const res = {
    get writableEnded() {
      return ended;
    },
    writeHead(code: number) {
      statusCode = code;
    },
    end(payload: string) {
      ended = true;
      body = JSON.parse(payload);
    },
  } as unknown as ServerResponse;

  beforeEach(() => {
    auth = new AuthManager();
    auth.createUser('dev1', 'viewer');
    ended = false;
    statusCode = 200;
    body = undefined;
    process.env.COMMANDER_RBAC_ENABLED = '1';
  });

  it('resolves AuthManager role from API key', () => {
    const { rawKey } = auth.generateApiKey('dev1', 'test', undefined);
    auth.updateUser('dev1', { role: 'developer' });
    const ctx = resolveHttpAuthContext(
      { headers: { authorization: `Bearer ${rawKey}` } } as never,
      new Map(),
    );
    expect(ctx.authSource).toBe('auth_manager');
    expect(ctx.role).toBe('developer');
  });

  it('requireMinRole sends 403 when role is insufficient', () => {
    const ctx = resolveHttpAuthContext({ headers: {} } as never, new Map());
    const ok = requireMinRole(res, ctx, 'admin', '/test');
    expect(ok).toBe(false);
    expect(statusCode).toBe(403);
    expect(body).toMatchObject({ error: expect.stringContaining('Insufficient permissions') });
  });

  it('tenant key maps to operator role by default', () => {
    const key = 'tenant-secret-key';
    const hashes = new Map([[hashSecret(key), 'tenant-a']]);
    const ctx = resolveHttpAuthContext(
      { headers: { authorization: `Bearer ${key}` } } as never,
      hashes,
    );
    expect(ctx.tenantId).toBe('tenant-a');
    expect(ctx.role).toBe('operator');
  });

  it('isRbacEnabled reflects env flag', () => {
    process.env.COMMANDER_RBAC_ENABLED = '0';
    expect(isRbacEnabled()).toBe(false);
  });
});
