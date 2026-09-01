import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  readTask1DatabaseIdentity,
  type Task1QueryClient,
  type Task1QueryPool,
} from '../src/task1ReadinessRuntime.js';

describe('Task 1 readiness startup', () => {
  it('retries an unavailable identity RPC during startup', async () => {
    let attempts = 0;
    const client: Task1QueryClient = {
      async query(text) {
        assert.match(text, /commander_database_identity\(\)/);
        attempts += 1;
        if (attempts === 1) throw new Error('database is still applying lifecycle state');
        return {
          rows: [
            {
              installation_id: '11111111-1111-4111-8111-111111111111',
              database_peer_binding_sha256: 'd'.repeat(64),
            },
          ],
        };
      },
      release() {},
    };
    const pool: Task1QueryPool = {
      connect: async () => client,
      query: (text, values) => client.query(text, values),
    };

    await assert.doesNotReject(readTask1DatabaseIdentity(pool));
    assert.equal(attempts, 2);
  });
});
