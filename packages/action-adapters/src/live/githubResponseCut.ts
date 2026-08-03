import type { FetchFn } from '../http.js';

export interface GitHubResponseCutState {
  createRequestCount: number;
  postStatus?: number;
  remoteCommitConfirmed: boolean;
  responseCutInjected: boolean;
}

export class GitHubResponseCutPreconditionError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`GitHub response-cut precondition failed: expected HTTP 201, got ${status}`);
    this.name = 'GitHubResponseCutPreconditionError';
    this.status = status;
  }
}

export class GitHubResponseCutError extends Error {
  constructor() {
    super('GitHub response cut after a successful pull-request create');
    this.name = 'GitHubResponseCutError';
  }
}

export function isSuccessfulGitHubCreateResponse(response: Response): boolean {
  return response.ok && response.status === 201;
}

/**
 * Deterministic live-test proxy. It never labels a non-201 response as a
 * post-commit cut, and it cuts the client response only after GitHub accepted
 * the create request.
 */
export function createGitHubResponseCutFetch(
  fetchImpl: FetchFn,
  state: GitHubResponseCutState,
  cutResponse = true,
): FetchFn {
  return async (input, init) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const isPullRequestCreate = method === 'POST' && String(input).endsWith('/pulls');
    if (!isPullRequestCreate) return fetchImpl(input, init);

    state.createRequestCount += 1;
    const response = await fetchImpl(input, init);
    state.postStatus = response.status;
    if (!isSuccessfulGitHubCreateResponse(response)) {
      throw new GitHubResponseCutPreconditionError(response.status);
    }

    state.remoteCommitConfirmed = true;
    if (cutResponse && !state.responseCutInjected) {
      state.responseCutInjected = true;
      throw new GitHubResponseCutError();
    }
    return response;
  };
}
