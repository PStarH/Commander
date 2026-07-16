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
});
