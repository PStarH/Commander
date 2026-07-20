/**
 * L4-02 GitHub live adapter proof (opt-in).
 *
 * Requires: LIVE_GITHUB=1, GITHUB_TOKEN|GITHUB_PAT, COMMANDER_CELL_TENANT_ID,
 * GITHUB_TEST_OWNER, GITHUB_TEST_REPO.
 *
 * Without creds: tests skip — matrix stays ENFORCED, not PROVEN.
 */
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { githubPrBodyMarker } from '@commander/contracts';
import {
  createGitHubPullRequestCreateAdapter,
  EnvAdapterCredentialProvider,
} from '@commander/action-adapters';

const tenantId = process.env.COMMANDER_CELL_TENANT_ID ?? '';
const owner = process.env.GITHUB_TEST_OWNER ?? '';
const repo = process.env.GITHUB_TEST_REPO ?? '';
const token = process.env.GITHUB_TOKEN ?? process.env.GITHUB_PAT ?? '';
const destination = owner && repo ? `github://${owner}/${repo}/pulls` : '';
const liveEnabled =
  process.env.LIVE_GITHUB === '1' &&
  Boolean(tenantId) &&
  Boolean(token) &&
  Boolean(owner) &&
  Boolean(repo);

const idempotencyKey = `live-github-${Date.now()}`;
const head = process.env.GITHUB_TEST_HEAD ?? `l4-b-live-${Date.now()}`;
const base = process.env.GITHUB_TEST_BASE ?? 'main';

let remotePrNumber: number | undefined;
let cleanupPrinted = false;

function printCleanup(): void {
  if (cleanupPrinted || !remotePrNumber) return;
  cleanupPrinted = true;
  console.error(`[LIVE_CLEANUP] adapter=github prNumber=${remotePrNumber} repo=${owner}/${repo}`);
}

describe('L4-02 GitHub live adapter', { skip: liveEnabled ? false : 'missing LIVE_GITHUB creds' }, () => {
  const credentials = new EnvAdapterCredentialProvider({ cellTenantId: tenantId });
  const adapter = createGitHubPullRequestCreateAdapter({ credentials });

  after(() => {
    printCleanup();
  });

  it('create → queryOutcome → compensate → queryCompensationOutcome', async () => {
    const marker = githubPrBodyMarker(tenantId, idempotencyKey);
    const signal = AbortSignal.timeout(60_000);
    try {
      const created = await adapter.execute({
        tenantId,
        effectId: 'eff-live-gh-1',
        idempotencyKey,
        destination,
        args: {
          title: 'L4-B live chaos PR',
          body: `Live test\n${marker}`,
          head,
          base,
        },
        signal,
      });
      remotePrNumber = Number(created.prNumber);
      assert.ok(Number.isFinite(remotePrNumber));

      const outcome = await adapter.queryOutcome({
        tenantId,
        effectId: 'eff-live-gh-1',
        idempotencyKey,
        destination,
        request: { head, base },
      });
      assert.equal(outcome.status, 'COMPLETED');
      assert.equal(outcome.response?.prNumber, remotePrNumber);

      const compensated = await adapter.compensate({
        tenantId,
        effectId: 'eff-live-gh-cmp',
        originalEffectId: 'eff-live-gh-1',
        idempotencyKey: `cmp:eff-live-gh-1:1.0.0`,
        destination,
        forwardResponse: created,
        compensationPatch: {},
        signal,
      });
      assert.equal(compensated.state, 'closed');

      const compensationOutcome = await adapter.queryCompensationOutcome({
        tenantId,
        effectId: 'eff-live-gh-cmp',
        idempotencyKey: `cmp:eff-live-gh-1:1.0.0`,
        destination,
        request: { prNumber: remotePrNumber },
        compensationResponse: compensated,
      });
      assert.equal(compensationOutcome.status, 'COMPLETED');
      assert.equal(compensationOutcome.response?.state, 'closed');
    } catch (error) {
      printCleanup();
      throw error;
    }
  });
});
