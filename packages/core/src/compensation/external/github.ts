/**
 * GitHub compensation handler.
 *
 * Maps the GitHub REST API (https://docs.github.com/en/rest) inverse
 * operations:
 *
 *   - pull_request.create        → PATCH state=closed
 *   - pull_request.merge         → POST /repos/{owner}/{repo}/pulls/{n}/revert
 *   - pull_request.create_review → not reversible; flag for review
 *   - issue.create               → PATCH state=closed
 *   - issue.comment_create       → DELETE /repos/{o}/{r}/issues/comments/{id}
 *   - branch.create              → DELETE /repos/{o}/{r}/git/refs/heads/{b}
 *   - label.create               → DELETE /repos/{o}/{r}/labels/{name}
 *   - label.add                  → DELETE /repos/{o}/{r}/issues/{n}/labels/{name}
 *   - assignee.add               → DELETE /repos/{o}/{r}/issues/{n}/assignees
 *   - reaction.add               → DELETE /repos/{o}/{r}/.../reactions/{id}
 *   - contents.create            → DELETE /repos/{o}/{r}/contents/{path}
 *   - contents.update            → PUT /repos/{o}/{r}/contents/{path} with prior SHA
 *   - release.create             → DELETE /repos/{o}/{r}/releases/{id}
 *   - tag.create                 → DELETE /repos/{o}/{r}/git/refs/tags/{t}
 *   - team.add_member            → DELETE /orgs/{org}/teams/{slug}/memberships/{user}
 *   - project.card_create        → DELETE /projects/columns/cards/{id}
 *
 * GitHub does NOT support X-Idempotency-Key for general POSTs. DELETE
 * is naturally idempotent (second call returns 404 → we treat as
 * already-compensated). PATCH is idempotent by definition. POSTs that
 * create resources use the resource URL as the inverse idempotency
 * surface (retrying the inverse is safe).
 *
 * Authentication: token-based. The token is read from
 * `GITHUB_TOKEN` env var by default; can be overridden via
 * configureGitHub().
 */

import type { CompensableAction } from '../../runtime/compensationRegistry';
import type { CompensationHandler } from '../../runtime/compensationRegistry';
import { ResilientHttp, nodeFetchHttp, type HttpSendFn } from './httpClient';
import type { CompensationOutcome } from './types';

export interface GitHubConfig {
  token: string;
  baseUrl?: string; // for github enterprise
  send?: HttpSendFn;
}

const GITHUB_API = 'https://api.github.com';

interface GitHubArgs {
  owner?: string;
  repo?: string;
  pullNumber?: number;
  issueNumber?: number;
  commentId?: number;
  branch?: string;
  ref?: string;
  tag?: string;
  label?: string;
  name?: string;
  login?: string;
  path?: string;
  message?: string;
  sha?: string;
  reactionId?: number;
  releaseId?: number;
  /** Cached resource URL or node_id from the forward action. */
  resourceUrl?: string;
}

function ghHeaders(token: string, extra?: Record<string, string>): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
    ...(extra ?? {}),
  };
}

function notFoundOk(res: { status: number }): boolean {
  return res.status === 404 || res.status === 410;
}

async function simpleInverse(
  cfg: GitHubConfig,
  method: 'PATCH' | 'POST' | 'DELETE' | 'PUT' | 'GET',
  path: string,
  body?: string,
  result: 'ok_or_404' | 'ok' = 'ok_or_404',
): Promise<{ res: { status: number; body: string }; outcome: CompensationOutcome }> {
  const http = new ResilientHttp(cfg.send ?? nodeFetchHttp, { maxAttempts: 3 });
  const res = await http.send({
    method,
    url: `${cfg.baseUrl ?? GITHUB_API}${path}`,
    headers: ghHeaders(cfg.token),
    body,
  });
  if (res.status >= 200 && res.status < 300) {
    return { res, outcome: { success: true } };
  }
  if (notFoundOk(res) && result === 'ok_or_404') {
    return { res, outcome: { success: true, alreadyCompensated: true } };
  }
  if (res.status === 401 || res.status === 403) {
    return {
      res,
      outcome: { success: false, permanent: true, error: `Auth failed: HTTP ${res.status}` },
    };
  }
  if (res.status >= 500 || res.status === 429) {
    return {
      res,
      outcome: { success: false, error: `Retryable HTTP ${res.status}: ${res.body.slice(0, 200)}` },
    };
  }
  return {
    res,
    outcome: {
      success: false,
      permanent: true,
      error: `HTTP ${res.status}: ${res.body.slice(0, 200)}`,
    },
  };
}

let _config: GitHubConfig | null = null;
export function configureGitHub(config: GitHubConfig): void {
  _config = config;
}

function ensureConfig(): GitHubConfig {
  if (_config) return _config;
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error('GitHub compensation: no config — call configureGitHub() or set GITHUB_TOKEN');
  }
  return { token };
}

function requireArgs(
  action: CompensableAction,
  keys: (keyof GitHubArgs)[],
): { ok: true; args: GitHubArgs } | { ok: false; outcome: CompensationOutcome } {
  const args = (action.args ?? {}) as GitHubArgs;
  for (const k of keys) {
    if (args[k] === undefined || args[k] === null) {
      return {
        ok: false,
        outcome: { success: false, permanent: true, error: `Missing required arg: ${String(k)}` },
      };
    }
  }
  return { ok: true, args };
}

function requireRepo(
  action: CompensableAction,
): { ok: true; args: GitHubArgs; cfg: GitHubConfig } | { ok: false; outcome: CompensationOutcome } {
  let cfg: GitHubConfig;
  try {
    cfg = ensureConfig();
  } catch (err) {
    return {
      ok: false,
      outcome: { success: false, permanent: true, error: (err as Error).message },
    };
  }
  const check = requireArgs(action, ['owner', 'repo']);
  if (!check.ok) return check;
  return { ok: true, args: check.args, cfg };
}

// ============================================================================
// Per-tool handlers
// ============================================================================

const prCreateHandler: CompensationHandler = async (action) => {
  const r = requireRepo(action);
  if (!r.ok) return r.outcome;
  if (r.args.pullNumber === undefined) {
    return { success: false, permanent: true, error: 'pullNumber required' };
  }
  return simpleInverse(
    r.cfg,
    'PATCH',
    `/repos/${r.args.owner}/${r.args.repo}/pulls/${r.args.pullNumber}`,
    JSON.stringify({ state: 'closed' }),
  ).then((x) => x.outcome);
};

const prMergeHandler: CompensationHandler = async (action) => {
  const r = requireRepo(action);
  if (!r.ok) return r.outcome;
  if (r.args.pullNumber === undefined) {
    return { success: false, permanent: true, error: 'pullNumber required' };
  }
  // Revert API: https://docs.github.com/en/rest/pulls/pulls#create-a-revert-pull-request
  return simpleInverse(
    r.cfg,
    'POST',
    `/repos/${r.args.owner}/${r.args.repo}/pulls/${r.args.pullNumber}/revert`,
  ).then((x) => x.outcome);
};

const issueCreateHandler: CompensationHandler = async (action) => {
  const r = requireRepo(action);
  if (!r.ok) return r.outcome;
  if (r.args.issueNumber === undefined) {
    return { success: false, permanent: true, error: 'issueNumber required' };
  }
  return simpleInverse(
    r.cfg,
    'PATCH',
    `/repos/${r.args.owner}/${r.args.repo}/issues/${r.args.issueNumber}`,
    JSON.stringify({ state: 'closed' }),
  ).then((x) => x.outcome);
};

const issueCommentHandler: CompensationHandler = async (action) => {
  const r = requireRepo(action);
  if (!r.ok) return r.outcome;
  if (r.args.commentId === undefined) {
    return { success: false, permanent: true, error: 'commentId required' };
  }
  return simpleInverse(
    r.cfg,
    'DELETE',
    `/repos/${r.args.owner}/${r.args.repo}/issues/comments/${r.args.commentId}`,
  ).then((x) => x.outcome);
};

const branchCreateHandler: CompensationHandler = async (action) => {
  const r = requireRepo(action);
  if (!r.ok) return r.outcome;
  if (!r.args.branch && !r.args.ref) {
    return { success: false, permanent: true, error: 'branch or ref required' };
  }
  return simpleInverse(
    r.cfg,
    'DELETE',
    `/repos/${r.args.owner}/${r.args.repo}/git/refs/heads/${encodeURIComponent(r.args.branch ?? r.args.ref ?? '')}`,
  ).then((x) => x.outcome);
};

const tagCreateHandler: CompensationHandler = async (action) => {
  const r = requireRepo(action);
  if (!r.ok) return r.outcome;
  if (!r.args.tag && !r.args.ref) {
    return { success: false, permanent: true, error: 'tag or ref required' };
  }
  return simpleInverse(
    r.cfg,
    'DELETE',
    `/repos/${r.args.owner}/${r.args.repo}/git/refs/tags/${encodeURIComponent(r.args.tag ?? r.args.ref ?? '')}`,
  ).then((x) => x.outcome);
};

const labelCreateHandler: CompensationHandler = async (action) => {
  const r = requireRepo(action);
  if (!r.ok) return r.outcome;
  if (!r.args.name) return { success: false, permanent: true, error: 'label name required' };
  return simpleInverse(
    r.cfg,
    'DELETE',
    `/repos/${r.args.owner}/${r.args.repo}/labels/${encodeURIComponent(r.args.name)}`,
  ).then((x) => x.outcome);
};

const labelAddHandler: CompensationHandler = async (action) => {
  const r = requireRepo(action);
  if (!r.ok) return r.outcome;
  if (r.args.issueNumber === undefined || !r.args.name) {
    return { success: false, permanent: true, error: 'issueNumber + label name required' };
  }
  return simpleInverse(
    r.cfg,
    'DELETE',
    `/repos/${r.args.owner}/${r.args.repo}/issues/${r.args.issueNumber}/labels/${encodeURIComponent(r.args.name)}`,
  ).then((x) => x.outcome);
};

const assigneeAddHandler: CompensationHandler = async (action) => {
  const r = requireRepo(action);
  if (!r.ok) return r.outcome;
  if (r.args.issueNumber === undefined || !r.args.login) {
    return { success: false, permanent: true, error: 'issueNumber + login required' };
  }
  return simpleInverse(
    r.cfg,
    'DELETE',
    `/repos/${r.args.owner}/${r.args.repo}/issues/${r.args.issueNumber}/assignees`,
    JSON.stringify({ assignees: [r.args.login] }),
  ).then((x) => x.outcome);
};

const reactionAddHandler: CompensationHandler = async (action) => {
  const r = requireRepo(action);
  if (!r.ok) return r.outcome;
  if (!r.args.reactionId) {
    return { success: false, permanent: true, error: 'reactionId required' };
  }
  // Reaction URL is upstream-specific. The planner should pass the full URL.
  if (!r.args.resourceUrl) {
    return { success: false, permanent: true, error: 'resourceUrl required for reaction removal' };
  }
  return simpleInverse(r.cfg, 'DELETE', r.args.resourceUrl).then((x) => x.outcome);
};

const contentsCreateHandler: CompensationHandler = async (action) => {
  const r = requireRepo(action);
  if (!r.ok) return r.outcome;
  if (!r.args.path) {
    return { success: false, permanent: true, error: 'path required' };
  }
  // Need the file's SHA to delete. If we don't have it, we look it up.
  let sha = r.args.sha;
  if (!sha) {
    const lookup = await simpleInverse(
      r.cfg,
      'GET',
      `/repos/${r.args.owner}/${r.args.repo}/contents/${encodeURIComponent(r.args.path)}`,
      undefined,
      'ok',
    );
    if (lookup.outcome.success && lookup.res.status === 200) {
      try {
        sha = (JSON.parse(lookup.res.body) as { sha?: string }).sha;
      } catch {
        /* fall through */
      }
    }
  }
  if (!sha) {
    return {
      success: true,
      alreadyCompensated: true,
      error: 'File not present (already deleted or never existed)',
    };
  }
  return simpleInverse(
    r.cfg,
    'DELETE',
    `/repos/${r.args.owner}/${r.args.repo}/contents/${encodeURIComponent(r.args.path)}`,
    JSON.stringify({ message: r.args.message ?? 'commander: compensate file create', sha }),
  ).then((x) => x.outcome);
};

const contentsUpdateHandler: CompensationHandler = async (action) => {
  const r = requireRepo(action);
  if (!r.ok) return r.outcome;
  if (!r.args.path) {
    return { success: false, permanent: true, error: 'path required' };
  }
  // Update compensation: write the prior content back. Args must
  // include `priorContent` and `priorSha`.
  const priorContent = (action.args as { priorContent?: string }).priorContent;
  const priorSha = (action.args as { priorSha?: string }).priorSha;
  if (!priorContent || !priorSha) {
    return {
      success: false,
      permanent: true,
      error: 'contents.update compensation requires priorContent and priorSha',
    };
  }
  return simpleInverse(
    r.cfg,
    'PUT',
    `/repos/${r.args.owner}/${r.args.repo}/contents/${encodeURIComponent(r.args.path)}`,
    JSON.stringify({
      message: r.args.message ?? 'commander: compensate file update',
      content: Buffer.from(priorContent, 'utf-8').toString('base64'),
      sha: priorSha,
    }),
  ).then((x) => x.outcome);
};

const releaseCreateHandler: CompensationHandler = async (action) => {
  const r = requireRepo(action);
  if (!r.ok) return r.outcome;
  if (!r.args.releaseId) {
    return { success: false, permanent: true, error: 'releaseId required' };
  }
  return simpleInverse(
    r.cfg,
    'DELETE',
    `/repos/${r.args.owner}/${r.args.repo}/releases/${r.args.releaseId}`,
  ).then((x) => x.outcome);
};

const teamAddMemberHandler: CompensationHandler = async (action) => {
  const cfg = ensureConfig();
  if (!action.args.org || !action.args.teamSlug || !action.args.login) {
    return { success: false, permanent: true, error: 'org, teamSlug, login required' };
  }
  return simpleInverse(
    cfg,
    'DELETE',
    `/orgs/${action.args.org}/teams/${encodeURIComponent(String(action.args.teamSlug))}/memberships/${encodeURIComponent(String(action.args.login))}`,
  ).then((x) => x.outcome);
};

const projectCardCreateHandler: CompensationHandler = async (action) => {
  const cfg = ensureConfig();
  if (!action.args.cardId) {
    return { success: false, permanent: true, error: 'cardId required' };
  }
  return simpleInverse(cfg, 'DELETE', `/projects/columns/cards/${action.args.cardId}`).then(
    (x) => x.outcome,
  );
};

const reviewSubmitHandler: CompensationHandler = async (action) => {
  return {
    success: false,
    permanent: true,
    error:
      'GitHub pull request reviews are not reversible via API; manual dismissal required. Action: ' +
      action.actionId,
  };
};

export const GITHUB_COMPENSATION_HANDLERS: Record<string, CompensationHandler> = {
  github_pr_create: prCreateHandler,
  github_pr_merge: prMergeHandler,
  github_issue_create: issueCreateHandler,
  github_issue_comment_create: issueCommentHandler,
  github_branch_create: branchCreateHandler,
  github_tag_create: tagCreateHandler,
  github_label_create: labelCreateHandler,
  github_label_add: labelAddHandler,
  github_assignee_add: assigneeAddHandler,
  github_reaction_add: reactionAddHandler,
  github_contents_create: contentsCreateHandler,
  github_contents_update: contentsUpdateHandler,
  github_release_create: releaseCreateHandler,
  github_team_add_member: teamAddMemberHandler,
  github_project_card_create: projectCardCreateHandler,
  github_review_submit: reviewSubmitHandler,
  // Aliases
  gh_pr_create: prCreateHandler,
  gh_issue_create: issueCreateHandler,
  gh_branch_create: branchCreateHandler,
};

export const GITHUB_TOOL_TAGS: Record<string, string[]> = {
  github_pr_create: ['github', 'github:pr', 'destructive', 'requires_approval'],
  github_pr_merge: ['github', 'github:pr', 'github:merge', 'destructive', 'requires_approval'],
  github_issue_create: ['github', 'github:issue'],
  github_issue_comment_create: ['github', 'github:comment', 'low_risk'],
  github_branch_create: ['github', 'github:branch'],
  github_tag_create: ['github', 'github:tag', 'destructive'],
  github_label_create: ['github', 'github:label', 'low_risk'],
  github_label_add: ['github', 'github:label', 'low_risk'],
  github_assignee_add: ['github', 'github:assignee', 'low_risk'],
  github_reaction_add: ['github', 'github:reaction', 'low_risk'],
  github_contents_create: ['github', 'github:contents', 'destructive'],
  github_contents_update: ['github', 'github:contents', 'destructive'],
  github_release_create: ['github', 'github:release', 'destructive', 'requires_approval'],
  github_team_add_member: ['github', 'github:team', 'destructive', 'requires_approval'],
  github_project_card_create: ['github', 'github:project', 'low_risk'],
  github_review_submit: ['github', 'github:review', 'non_reversible'],
};

export const GITHUB_TOOL_COST_USD: Record<string, number> = {
  github_pr_create: 0,
  github_pr_merge: 0,
  github_issue_create: 0,
  github_release_create: 0,
  github_team_add_member: 0,
};

export function registerGitHubCompensation(): void {
  const { getExecutionScheduler } =
    require('../../atr/scheduler') as typeof import('../../atr/scheduler');
  const scheduler = getExecutionScheduler();
  for (const [toolName, handler] of Object.entries(GITHUB_COMPENSATION_HANDLERS)) {
    scheduler.registerCompensation(toolName, handler);
  }
}
