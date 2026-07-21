/**
 * L4-02 ServiceNow live adapter proof (opt-in).
 *
 * Requires: LIVE_SERVICENOW=1, SERVICENOW_*, COMMANDER_CELL_TENANT_ID.
 *
 * Without creds: tests skip — matrix stays ENFORCED, not PROVEN.
 */
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import {
  createServiceNowIncidentCreateAdapter,
  EnvAdapterCredentialProvider,
} from '@commander/action-adapters';

const tenantId = process.env.COMMANDER_CELL_TENANT_ID ?? '';
const instance = process.env.SERVICENOW_INSTANCE ?? '';
const username = process.env.SERVICENOW_USERNAME ?? '';
const password = process.env.SERVICENOW_PASSWORD ?? '';
const destination = instance ? `servicenow://${instance}/incident` : '';
const liveEnabled =
  process.env.LIVE_SERVICENOW === '1' &&
  Boolean(tenantId) &&
  Boolean(instance) &&
  Boolean(username) &&
  Boolean(password);

const idempotencyKey = `live-sn-${Date.now()}`;

let remoteSysId: string | undefined;
let cleanupPrinted = false;

function printCleanup(): void {
  if (cleanupPrinted || !remoteSysId) return;
  cleanupPrinted = true;
  console.error(`[LIVE_CLEANUP] adapter=servicenow sysId=${remoteSysId} instance=${instance}`);
}

describe(
  'L4-02 ServiceNow live adapter',
  { skip: liveEnabled ? false : 'missing LIVE_SERVICENOW creds' },
  () => {
    const credentials = new EnvAdapterCredentialProvider({ cellTenantId: tenantId });
    const adapter = createServiceNowIncidentCreateAdapter({ credentials });

    after(() => {
      printCleanup();
    });

    it('create → queryOutcome → compensate → queryOutcome', async () => {
      const signal = AbortSignal.timeout(60_000);
      try {
        const created = await adapter.execute({
          tenantId,
          effectId: 'eff-live-sn-1',
          idempotencyKey,
          destination,
          args: {
            short_description: 'L4-B live incident',
            description: 'Commander live proof',
          },
          signal,
        });
        remoteSysId = String(created.sysId);
        assert.ok(remoteSysId);

        const outcome = await adapter.queryOutcome({
          tenantId,
          effectId: 'eff-live-sn-1',
          idempotencyKey,
          destination,
          request: {},
        });
        assert.equal(outcome.status, 'COMPLETED');
        assert.equal(outcome.response?.sysId, remoteSysId);

        await adapter.compensate({
          tenantId,
          effectId: 'eff-live-sn-cmp',
          originalEffectId: 'eff-live-sn-1',
          idempotencyKey: `cmp:eff-live-sn-1:1.0.0`,
          destination,
          forwardResponse: created,
          compensationPatch: { state: '7' },
          signal,
        });

        const postCompensate = await adapter.queryCompensationOutcome({
          tenantId,
          effectId: 'eff-live-sn-cmp',
          idempotencyKey: `cmp:eff-live-sn-1:1.0.0`,
          destination,
          request: { expectedState: '7' },
          compensationResponse: { sysId: remoteSysId },
        });
        assert.equal(postCompensate.status, 'COMPLETED');
        assert.equal(postCompensate.response?.state, '7');
      } catch (error) {
        printCleanup();
        throw error;
      }
    });
  },
);
