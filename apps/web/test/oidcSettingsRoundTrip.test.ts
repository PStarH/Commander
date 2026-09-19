/**
 * WEB-PAGES-03: loading the OIDC settings form and saving it back unchanged
 * must preserve the tenant configuration (`tenantClaim`, `defaultTenantId`) and
 * explicitly EMPTY `adminRoles` / `operatorRoles` arrays. The pre-fix form
 * dropped both tenant fields and repopulated empty role arrays with defaults,
 * so an unchanged GET→PUT silently rewrote a working tenant login setup.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

function createStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => (map.has(key) ? map.get(key)! : null),
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
    clear: () => {
      map.clear();
    },
  };
}

const ORIGIN = 'https://app.commander.example';

(globalThis as unknown as { localStorage: unknown }).localStorage = createStorage();
(globalThis as unknown as { location: unknown }).location = {
  origin: ORIGIN,
  href: `${ORIGIN}/settings/oidc`,
};
(globalThis as unknown as { window: unknown }).window = {
  dispatchEvent: () => true,
  location: { origin: ORIGIN, href: `${ORIGIN}/settings/oidc` },
  history: { replaceState: () => undefined },
};

let currentConfig: Record<string, unknown> = {};
let putBody: Record<string, unknown> | null = null;

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const method = init?.method ?? 'GET';
  const headers = { 'content-type': 'application/json' };
  if (method === 'PUT') {
    putBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({ status: 'saved', config: currentConfig }), {
      status: 200,
      headers,
    });
  }
  return new Response(JSON.stringify(currentConfig), { status: 200, headers });
}) as typeof fetch;

const { fetchOIDCSettings, updateOIDCSettings } = await import('../src/api');
const { oidcConfigToForm, oidcFormToPayload } = await import('../src/pages/OIDCSettingsPage');

async function roundTrip(config: Record<string, unknown>): Promise<Record<string, unknown>> {
  currentConfig = config;
  putBody = null;
  const loaded = await fetchOIDCSettings();
  const form = oidcConfigToForm(loaded, ORIGIN);
  await updateOIDCSettings(oidcFormToPayload(form));
  assert.ok(putBody, 'expected the settings PUT to be issued');
  return putBody;
}

describe('OIDC settings GET → unchanged PUT round-trip (WEB-PAGES-03)', () => {
  it('preserves a custom tenantClaim, defaultTenantId and empty role arrays', async () => {
    const body = await roundTrip({
      enabled: true,
      issuer: 'https://idp.example',
      clientId: 'client-1',
      roleClaim: 'roles',
      adminRoles: [],
      operatorRoles: [],
      tenantClaim: 'org_id',
      defaultTenantId: 'tenant-a',
      redirectUri: `${ORIGIN}/login`,
    });

    assert.deepEqual(body, {
      enabled: true,
      issuer: 'https://idp.example',
      clientId: 'client-1',
      roleClaim: 'roles',
      adminRoles: [],
      operatorRoles: [],
      tenantClaim: 'org_id',
      defaultTenantId: 'tenant-a',
      redirectUri: `${ORIGIN}/login`,
    });
  });

  it('omits an unset defaultTenantId instead of sending an empty string', async () => {
    const body = await roundTrip({
      enabled: true,
      issuer: 'https://idp.example',
      clientId: 'client-1',
      roleClaim: 'roles',
      adminRoles: ['commander-admin'],
      operatorRoles: ['commander-operator'],
      tenantClaim: 'tenant_id',
      redirectUri: `${ORIGIN}/login`,
    });

    assert.equal('defaultTenantId' in body, false);
  });

  it('preserves a non-empty defaultTenantId and custom role claim', async () => {
    const body = await roundTrip({
      enabled: true,
      issuer: 'https://idp.example',
      clientId: 'client-1',
      roleClaim: 'groups',
      adminRoles: ['platform-admins'],
      operatorRoles: ['platform-operators'],
      tenantClaim: 'workspace',
      defaultTenantId: 'workspace-default',
      redirectUri: `${ORIGIN}/login`,
    });

    assert.equal(body.tenantClaim, 'workspace');
    assert.equal(body.defaultTenantId, 'workspace-default');
    assert.equal(body.roleClaim, 'groups');
    assert.deepEqual(body.adminRoles, ['platform-admins']);
    assert.deepEqual(body.operatorRoles, ['platform-operators']);
  });

  it('falls back to the default tenant claim when the server omits it', async () => {
    const body = await roundTrip({
      enabled: false,
      issuer: 'https://idp.example',
      clientId: 'client-1',
      roleClaim: 'roles',
      adminRoles: ['admin'],
      operatorRoles: ['operator', 'developer'],
      redirectUri: `${ORIGIN}/login`,
    });

    assert.equal(body.tenantClaim, 'tenant_id');
  });
});
