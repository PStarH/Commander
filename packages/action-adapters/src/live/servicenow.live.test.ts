/**
 * L4-02 ServiceNow live adapter proof (opt-in).
 *
 * Requires: LIVE_SERVICENOW=1, SERVICENOW_*, COMMANDER_CELL_TENANT_ID and an
 * explicit `COMMANDER_LIVE_APPROVED_SERVICENOW_INSTANCE` test-target allowlist.
 *
 * Without creds: tests skip — matrix stays ENFORCED, not PROVEN.
 */
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { createServiceNowIncidentCreateAdapter, EnvAdapterCredentialProvider } from '../index.js';

const tenantId = process.env.COMMANDER_CELL_TENANT_ID ?? '';
const instance = process.env.SERVICENOW_INSTANCE ?? '';
const username = process.env.SERVICENOW_USERNAME ?? '';
const password = process.env.SERVICENOW_PASSWORD ?? '';
const destination = instance ? `servicenow://${instance}/incident` : '';

/**
 * The live run creates and compensates real incidents, so the instance must be
 * named explicitly. There is no name heuristic that can stand in for this: an
 * unapproved (e.g. production) instance must never be written to.
 */
export function isAllowlistedServiceNowInstance(
  candidate: string,
  approvedInstance = process.env.COMMANDER_LIVE_APPROVED_SERVICENOW_INSTANCE ?? '',
): boolean {
  if (!candidate || !approvedInstance) return false;
  return candidate === approvedInstance;
}

/** All live preconditions, including the explicit test-target allowlist. */
export function isServiceNowLiveEnabled(env: Record<string, string | undefined>): boolean {
  return (
    env.LIVE_SERVICENOW === '1' &&
    Boolean(env.COMMANDER_CELL_TENANT_ID) &&
    Boolean(env.SERVICENOW_INSTANCE) &&
    Boolean(env.SERVICENOW_USERNAME) &&
    Boolean(env.SERVICENOW_PASSWORD) &&
    isAllowlistedServiceNowInstance(
      env.SERVICENOW_INSTANCE ?? '',
      env.COMMANDER_LIVE_APPROVED_SERVICENOW_INSTANCE ?? '',
    )
  );
}

const liveEnabled = isServiceNowLiveEnabled(process.env);

const idempotencyKey = `live-sn-${Date.now()}`;

let remoteSysId: string | undefined;
let cleanupPrinted = false;

function printCleanup(): void {
  if (cleanupPrinted || !remoteSysId) return;
  cleanupPrinted = true;
  console.error(`[LIVE_CLEANUP] adapter=servicenow sysId=${remoteSysId} instance=${instance}`);
}

describe('ServiceNow live target preflight', () => {
  it('requires an exact approved instance and refuses everything else', () => {
    assert.equal(isAllowlistedServiceNowInstance('dev12345', 'dev12345'), true);
    assert.equal(isAllowlistedServiceNowInstance('prod99999', 'dev12345'), false);
    assert.equal(isAllowlistedServiceNowInstance('dev12345', ''), false, 'no allowlist ⇒ deny');
    assert.equal(isAllowlistedServiceNowInstance('', 'dev12345'), false);
    // A production instance whose name merely contains the approved one must not pass.
    assert.equal(isAllowlistedServiceNowInstance('dev12345prod', 'dev12345'), false);
  });

  it('never enables the live run without an approved test instance', () => {
    const creds = {
      LIVE_SERVICENOW: '1',
      COMMANDER_CELL_TENANT_ID: 'tenant-a',
      SERVICENOW_INSTANCE: 'dev12345',
      SERVICENOW_USERNAME: 'admin',
      SERVICENOW_PASSWORD: 'secret',
    };
    assert.equal(isServiceNowLiveEnabled(creds), false, 'creds alone must not enable live writes');
    assert.equal(
      isServiceNowLiveEnabled({
        ...creds,
        COMMANDER_LIVE_APPROVED_SERVICENOW_INSTANCE: 'prod99999',
      }),
      false,
      'a mismatched allowlist must not enable live writes',
    );
    assert.equal(
      isServiceNowLiveEnabled({
        ...creds,
        COMMANDER_LIVE_APPROVED_SERVICENOW_INSTANCE: 'dev12345',
      }),
      true,
    );
  });
});

describe(
  'L4-02 ServiceNow live adapter',
  {
    skip: liveEnabled
      ? false
      : 'missing LIVE_SERVICENOW creds or COMMANDER_LIVE_APPROVED_SERVICENOW_INSTANCE allowlist',
  },
  () => {
    after(() => {
      printCleanup();
    });

    it('create → queryOutcome → compensate → queryOutcome', async () => {
      const credentials = new EnvAdapterCredentialProvider({ cellTenantId: tenantId });
      const adapter = createServiceNowIncidentCreateAdapter({ credentials });
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
