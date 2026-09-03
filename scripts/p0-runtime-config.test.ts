import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildP0RuntimeDatabaseUrls } from './p0-runtime-config.js';

describe('P0 runtime database configuration', () => {
  it('keeps app, tenant-authority, and worker credentials on separate DSNs', () => {
    const urls = buildP0RuntimeDatabaseUrls(
      'postgres://commander_owner:owner-secret@localhost:55440/fixture?sslmode=verify-full',
      {
        app: 'app-secret',
        authority: 'authority-secret',
        worker: 'worker-secret',
      },
    );

    assert.equal(new URL(urls.app).username, 'commander_app');
    assert.equal(new URL(urls.authority).username, 'commander_tenant_authority');
    assert.equal(new URL(urls.worker).username, 'commander_worker');
    assert.notEqual(urls.app, urls.authority);
    assert.notEqual(urls.app, urls.worker);
    assert.notEqual(urls.authority, urls.worker);
  });
});
