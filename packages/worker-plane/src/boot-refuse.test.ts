import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createProductionWorkerSandboxReadiness } from './sandboxReadiness.js';

describe('worker sandbox boot refusal', () => {
  it('rejects a production no-sandbox bypass before database access', async () => {
    const readiness = createProductionWorkerSandboxReadiness({
      NODE_ENV: 'production',
      COMMANDER_ALLOW_NO_SANDBOX: 'true',
      COMMANDER_PLUGIN_SANDBOX: 'required',
    });

    await assert.rejects(readiness.assertReady(), /ALLOW_NO_SANDBOX/);
  });

  // WP-08: the guard keyed off NODE_ENV alone, so every other production profile
  // skipped sandbox verification entirely and resolved as a no-op.
  for (const profile of [
    { COMMANDER_PROFILE: 'enterprise' },
    { COMMANDER_REQUIRE_EFFECT_BROKER: '1' },
    { COMMANDER_REQUIRE_WORKLOAD_BINDING: '1' },
  ]) {
    it(`verifies the sandbox under ${Object.keys(profile)[0]} without NODE_ENV=production`, async () => {
      const readiness = createProductionWorkerSandboxReadiness({
        ...profile,
        COMMANDER_ALLOW_NO_SANDBOX: 'true',
        COMMANDER_PLUGIN_SANDBOX: 'required',
      });

      await assert.rejects(readiness.assertReady(), /ALLOW_NO_SANDBOX/);
    });
  }
});
