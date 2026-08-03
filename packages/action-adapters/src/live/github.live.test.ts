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
import { createGitHubPullRequestCreateAdapter, EnvAdapterCredentialProvider } from '../index.js';
import {
  createGitHubResponseCutFetch,
  GitHubResponseCutError,
  type GitHubResponseCutState,
} from './githubResponseCut.js';

const tenantId = process.env.COMMANDER_CELL_TENANT_ID ?? '';
const owner = process.env.GITHUB_TEST_OWNER ?? '';
const repo = process.env.GITHUB_TEST_REPO ?? '';
const token = process.env.GITHUB_TOKEN ?? process.env.GITHUB_PAT ?? '';
const destination = owner && repo ? `github://${owner}/${repo}/pulls` : '';

/** Keep the opt-in live test write-scoped to an explicitly test-only target. */
export function isAllowlistedGitHubTestRepository(
  repositoryOwner: string,
  repositoryName: string,
  approvedRepository = process.env.COMMANDER_LIVE_APPROVED_REPO ?? '',
): boolean {
  if (!repositoryOwner || !repositoryName) return false;
  const canonicalRepository = `${repositoryOwner}/${repositoryName}`;
  return repositoryName.startsWith('commander-live-') || approvedRepository === canonicalRepository;
}

const allowlistedTarget = isAllowlistedGitHubTestRepository(owner, repo);
const liveEnabled =
  process.env.LIVE_GITHUB === '1' &&
  Boolean(tenantId) &&
  Boolean(token) &&
  Boolean(owner) &&
  Boolean(repo) &&
  allowlistedTarget;

const idempotencyKey = `live-github-${Date.now()}`;
const head = process.env.GITHUB_TEST_HEAD ?? `l4-b-live-${Date.now()}`;
const base = process.env.GITHUB_TEST_BASE ?? 'main';
const responseCutHead = process.env.GITHUB_RESPONSE_CUT_HEAD ?? '';
const responseCutEnabled =
  liveEnabled &&
  process.env.LIVE_GITHUB_RESPONSE_CUT === '1' &&
  Boolean(responseCutHead) &&
  responseCutHead !== head;
const responseCutIdempotencyKey = `live-github-response-cut-${Date.now()}`;

const remotePrNumbers: number[] = [];

function printCleanup(): void {
  if (remotePrNumbers.length === 0) return;
  console.error(
    `[LIVE_CLEANUP] adapter=github prNumbers=${remotePrNumbers.join(',')} repo=${owner}/${repo}`,
  );
}

describe('GitHub live target preflight', () => {
  it('rejects a non-test repository without an exact approval', () => {
    assert.equal(isAllowlistedGitHubTestRepository('PStarH', 'Commander'), false);
    assert.equal(
      isAllowlistedGitHubTestRepository('PStarH', 'Commander', 'other/test-repo'),
      false,
    );
  });

  it('accepts the dedicated prefix or an exact approved repository', () => {
    assert.equal(isAllowlistedGitHubTestRepository('PStarH', 'commander-live-demo'), true);
    assert.equal(
      isAllowlistedGitHubTestRepository('PStarH', 'private-test', 'PStarH/private-test'),
      true,
    );
  });
});

describe(
  'L4-02 GitHub live adapter',
  { skip: liveEnabled ? false : 'missing LIVE_GITHUB creds or explicit test-repo allowlist' },
  () => {
    after(() => {
      printCleanup();
    });

    it('create → queryOutcome → compensate → queryCompensationOutcome', async () => {
      const credentials = new EnvAdapterCredentialProvider({ cellTenantId: tenantId });
      const adapter = createGitHubPullRequestCreateAdapter({ credentials });
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
        const remotePrNumber = Number(created.prNumber);
        assert.ok(Number.isFinite(remotePrNumber));
        remotePrNumbers.push(remotePrNumber);

        const outcome = await adapter.queryOutcome({
          tenantId,
          effectId: 'eff-live-gh-1',
          idempotencyKey,
          destination,
          request: { head, base },
        });
        assert.equal(outcome.status, 'APPLIED');
        assert.equal(outcome.response?.prNumber, remotePrNumber);

        const compensated = await adapter.compensate({
          tenantId,
          effectId: 'eff-live-gh-cmp',
          originalEffectId: 'eff-live-gh-1',
          idempotencyKey: `cmp:eff-live-gh-1:1.0.0`,
          destination,
          forwardResponse: { ...created, idempotencyKey },
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
        assert.equal(compensationOutcome.status, 'APPLIED');
        assert.equal(compensationOutcome.response?.state, 'closed');
      } catch (error) {
        printCleanup();
        throw error;
      }
    });
  },
);

describe(
  'L4-04 GitHub response-cut live adapter',
  {
    skip: responseCutEnabled
      ? false
      : 'requires LIVE_GITHUB_RESPONSE_CUT=1 and a fresh GITHUB_RESPONSE_CUT_HEAD',
  },
  () => {
    after(() => {
      printCleanup();
    });

    it('cuts only after GitHub accepts the create and then queries one PR', async () => {
      const credentials = new EnvAdapterCredentialProvider({ cellTenantId: tenantId });
      const observed: GitHubResponseCutState = {
        createRequestCount: 0,
        remoteCommitConfirmed: false,
        responseCutInjected: false,
      };
      const adapter = createGitHubPullRequestCreateAdapter({
        credentials,
        fetch: createGitHubResponseCutFetch(globalThis.fetch.bind(globalThis), observed),
      });
      const signal = AbortSignal.timeout(60_000);

      try {
        await assert.rejects(
          () =>
            adapter.execute({
              tenantId,
              effectId: 'eff-live-gh-response-cut',
              idempotencyKey: responseCutIdempotencyKey,
              destination,
              args: {
                title: 'L4-B live response-cut PR',
                body: 'Live response-cut test',
                head: responseCutHead,
                base,
              },
              signal,
            }),
          (error: unknown) => error instanceof GitHubResponseCutError,
        );
        assert.equal(observed.postStatus, 201);
        assert.equal(observed.remoteCommitConfirmed, true);
        assert.equal(observed.responseCutInjected, true);

        const outcome = await adapter.queryOutcome({
          tenantId,
          effectId: 'eff-live-gh-response-cut',
          idempotencyKey: responseCutIdempotencyKey,
          destination,
          request: { head: responseCutHead, base },
          signal,
        });
        assert.equal(outcome.status, 'APPLIED');
        if (outcome.status !== 'APPLIED') throw new Error('response-cut PR was not observable');
        const remotePrNumber = Number(outcome.response.prNumber);
        assert.ok(Number.isFinite(remotePrNumber));
        remotePrNumbers.push(remotePrNumber);

        const compensated = await adapter.compensate({
          tenantId,
          effectId: 'eff-live-gh-response-cut-cmp',
          originalEffectId: 'eff-live-gh-response-cut',
          idempotencyKey: 'cmp:eff-live-gh-response-cut:1.0.0',
          destination,
          forwardResponse: { prNumber: remotePrNumber, idempotencyKey: responseCutIdempotencyKey },
          compensationPatch: {},
          signal,
        });
        assert.equal(compensated.state, 'closed');
        assert.equal(observed.createRequestCount, 1);
      } catch (error) {
        printCleanup();
        throw error;
      }
    });
  },
);
