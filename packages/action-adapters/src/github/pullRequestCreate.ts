import {
  githubPrBodyMarker,
  GITHUB_PULL_REQUEST_CREATE_DESCRIPTOR,
} from '@commander/contracts';
import { AdapterExecutionError } from '@commander/effect-broker';
import type { EffectRemoteOutcome } from '@commander/effect-broker';
import { assertOkResponse, adapterFetch, readJsonResponse, type FetchFn } from '../http.js';
import type {
  ActionAdapter,
  AdapterCompensateInput,
  AdapterCredentialProvider,
  AdapterExecuteInput,
  AdapterQueryInput,
} from '../types.js';
import { parseGitHubDestination } from '../types.js';

interface GitHubPull {
  number: number;
  html_url: string;
  state: string;
  body: string | null;
  head: { ref: string };
  base: { ref: string };
}

export interface GitHubPullRequestCreateAdapterOptions {
  credentials: AdapterCredentialProvider;
  fetch?: FetchFn;
}

export function createGitHubPullRequestCreateAdapter(
  options: GitHubPullRequestCreateAdapterOptions,
): ActionAdapter {
  const rawFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const fetchImpl = (url: RequestInfo | URL, init?: RequestInit) => adapterFetch(rawFetch, url, init);

  async function listPullRequests(
    token: string,
    owner: string,
    repo: string,
    head?: string,
    base?: string,
  ): Promise<GitHubPull[]> {
    const params = new URLSearchParams({ state: 'all', per_page: '100' });
    if (head) params.set('head', `${owner}:${head}`);
    if (base) params.set('base', base);
    const response = await fetchImpl(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls?${params}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      },
    );
    await assertOkResponse(response, 'GitHub list pulls');
    return readJsonResponse<GitHubPull[]>(response);
  }

  function filterByMarker(
    pulls: GitHubPull[],
    marker: string,
    head?: string,
    base?: string,
  ): GitHubPull[] {
    return pulls.filter((pull) => {
      if (head && pull.head.ref !== head) return false;
      if (base && pull.base.ref !== base) return false;
      return (pull.body ?? '').includes(marker);
    });
  }

  async function findByMarker(
    input: AdapterQueryInput,
    marker: string,
  ): Promise<{ pulls: GitHubPull[]; outcome: EffectRemoteOutcome | null }> {
    const { owner, repo } = parseGitHubDestination(input.destination);
    const token = await options.credentials.getGitHubToken(input.tenantId, input.destination);
    const head = typeof input.request.head === 'string' ? input.request.head : undefined;
    const base = typeof input.request.base === 'string' ? input.request.base : undefined;
    const pulls = filterByMarker(
      await listPullRequests(token, owner, repo, head, base),
      marker,
      head,
      base,
    );
    if (pulls.length === 0) {
      return { pulls, outcome: { status: 'UNKNOWN' } };
    }
    if (pulls.length > 1) {
      return {
        pulls,
        outcome: { status: 'UNKNOWN' },
      };
    }
    const pull = pulls[0]!;
    return {
      pulls,
      outcome: {
        status: 'COMPLETED',
        response: {
          prNumber: pull.number,
          url: pull.html_url,
          state: pull.state,
        },
      },
    };
  }

  return {
    descriptor: GITHUB_PULL_REQUEST_CREATE_DESCRIPTOR,

    async execute(input: AdapterExecuteInput): Promise<Record<string, unknown>> {
      const { owner, repo } = parseGitHubDestination(input.destination);
      const marker = githubPrBodyMarker(input.tenantId, input.idempotencyKey);
      const head = String(input.args.head ?? '');
      const base = String(input.args.base ?? 'main');
      const existing = await findByMarker(
        {
          ...input,
          request: { head, base },
        },
        marker,
      );
      if (existing.pulls.length === 1) {
        const pull = existing.pulls[0]!;
        return { prNumber: pull.number, url: pull.html_url, state: pull.state };
      }
      if (existing.pulls.length > 1) {
        throw new AdapterExecutionError('Multiple PRs matched idempotency marker', {
          code: 'GITHUB_MULTI_MARKER',
          commitState: 'UNKNOWN',
          retryMode: 'QUERY_FIRST',
          details: { matchCount: existing.pulls.length },
        });
      }

      const token = await options.credentials.getGitHubToken(input.tenantId, input.destination);
      const title = String(input.args.title ?? 'Commander PR');
      const bodyText = String(input.args.body ?? '');
      const body = bodyText.includes(marker) ? bodyText : `${bodyText}\n\n${marker}`.trim();

      const response = await fetchImpl(
        `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ title, body, head, base }),
          signal: input.signal,
        },
      );
      await assertOkResponse(response, 'GitHub create PR');
      const created = await readJsonResponse<GitHubPull>(response);
      return { prNumber: created.number, url: created.html_url, state: created.state };
    },

    async queryOutcome(input: AdapterQueryInput): Promise<EffectRemoteOutcome> {
      const marker = githubPrBodyMarker(input.tenantId, input.idempotencyKey);
      const result = await findByMarker(input, marker);
      return result.outcome ?? { status: 'UNKNOWN' };
    },

    async compensate(input: AdapterCompensateInput): Promise<Record<string, unknown>> {
      const { owner, repo } = parseGitHubDestination(input.destination);
      const prNumber = Number(input.forwardResponse.prNumber);
      if (!Number.isFinite(prNumber)) {
        throw new AdapterExecutionError('Missing prNumber for compensation', {
          code: 'GITHUB_COMPENSATE_MISSING_PR',
          commitState: 'NOT_COMMITTED',
          retryMode: 'NEVER',
        });
      }
      const token = await options.credentials.getGitHubToken(input.tenantId, input.destination);
      const getResponse = await fetchImpl(
        `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${prNumber}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
          },
          signal: input.signal,
        },
      );
      await assertOkResponse(getResponse, 'GitHub get PR before compensate');
      const existing = await readJsonResponse<GitHubPull>(getResponse);
      const body = existing.body ?? '';
      // Ownership gate: only close PRs that carry a Commander action marker.
      // Exact hash needs the forward idempotency key (not the cmp:* key); when
      // forwardResponse includes it, enforce exact match; otherwise require prefix.
      const originalIdempotencyKey =
        typeof input.forwardResponse.idempotencyKey === 'string'
          ? input.forwardResponse.idempotencyKey
          : undefined;
      if (originalIdempotencyKey) {
        const expected = githubPrBodyMarker(input.tenantId, originalIdempotencyKey);
        if (!body.includes(expected)) {
          throw new AdapterExecutionError('Compensation refused: PR marker mismatch', {
            code: 'GITHUB_COMPENSATE_MARKER_MISMATCH',
            commitState: 'NOT_COMMITTED',
            retryMode: 'NEVER',
            details: { prNumber },
          });
        }
      } else if (!body.includes('<!-- commander-action:')) {
        throw new AdapterExecutionError('Compensation refused: PR lacks Commander marker', {
          code: 'GITHUB_COMPENSATE_MARKER_MISSING',
          commitState: 'NOT_COMMITTED',
          retryMode: 'NEVER',
          details: { prNumber },
        });
      }
      if (existing.state === 'closed') {
        return { prNumber: existing.number, state: existing.state };
      }
      const response = await fetchImpl(
        `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${prNumber}`,
        {
          method: 'PATCH',
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ state: 'closed' }),
          signal: input.signal,
        },
      );
      await assertOkResponse(response, 'GitHub close PR');
      const closed = await readJsonResponse<GitHubPull>(response);
      return { prNumber: closed.number, state: closed.state };
    },

    async queryCompensationOutcome(
      input: AdapterQueryInput & { compensationResponse?: Record<string, unknown> },
    ): Promise<EffectRemoteOutcome> {
      const { owner, repo } = parseGitHubDestination(input.destination);
      const prNumber = Number(
        input.compensationResponse?.prNumber ?? input.request.prNumber,
      );
      if (!Number.isFinite(prNumber)) {
        return { status: 'UNKNOWN' };
      }
      const token = await options.credentials.getGitHubToken(input.tenantId, input.destination);
      const response = await fetchImpl(
        `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${prNumber}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
          },
          signal: input.signal,
        },
      );
      await assertOkResponse(response, 'GitHub get PR');
      const pull = await readJsonResponse<GitHubPull>(response);
      if (pull.state === 'closed') {
        return {
          status: 'COMPLETED',
          response: { prNumber: pull.number, state: pull.state },
        };
      }
      return { status: 'UNKNOWN' };
    },
  };
}
