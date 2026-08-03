import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createGitHubResponseCutFetch,
  GitHubResponseCutError,
  GitHubResponseCutPreconditionError,
  isSuccessfulGitHubCreateResponse,
  type GitHubResponseCutState,
} from './githubResponseCut.js';

const createUrl = 'https://api.github.com/repos/octo/repo/pulls';

function state(): GitHubResponseCutState {
  return {
    createRequestCount: 0,
    remoteCommitConfirmed: false,
    responseCutInjected: false,
  };
}

describe('GitHub response-cut harness', () => {
  it('requires an accepted HTTP 201 before marking a remote commit', async () => {
    assert.equal(isSuccessfulGitHubCreateResponse(new Response('{}', { status: 200 })), false);
    assert.equal(isSuccessfulGitHubCreateResponse(new Response('{}', { status: 201 })), true);

    const observed = state();
    const fetch = createGitHubResponseCutFetch(
      async () => new Response('duplicate head/base', { status: 422 }),
      observed,
    );

    await assert.rejects(
      () => fetch(createUrl, { method: 'POST' }),
      (error: unknown) => {
        assert.ok(error instanceof GitHubResponseCutPreconditionError);
        assert.equal(error.status, 422);
        return true;
      },
    );
    assert.equal(observed.createRequestCount, 1);
    assert.equal(observed.postStatus, 422);
    assert.equal(observed.remoteCommitConfirmed, false);
    assert.equal(observed.responseCutInjected, false);
  });

  it('cuts only after a successful create response', async () => {
    const observed = state();
    const fetch = createGitHubResponseCutFetch(
      async () => new Response(JSON.stringify({ number: 1 }), { status: 201 }),
      observed,
    );

    await assert.rejects(
      () => fetch(createUrl, { method: 'POST' }),
      (error: unknown) => error instanceof GitHubResponseCutError,
    );
    assert.equal(observed.createRequestCount, 1);
    assert.equal(observed.postStatus, 201);
    assert.equal(observed.remoteCommitConfirmed, true);
    assert.equal(observed.responseCutInjected, true);
  });

  it('passes a successful response when injection is disabled', async () => {
    const observed = state();
    const fetch = createGitHubResponseCutFetch(
      async () => new Response(JSON.stringify({ number: 1 }), { status: 201 }),
      observed,
      false,
    );

    const response = await fetch(createUrl, { method: 'POST' });
    assert.equal(response.status, 201);
    assert.equal(observed.remoteCommitConfirmed, true);
    assert.equal(observed.responseCutInjected, false);
  });
});
