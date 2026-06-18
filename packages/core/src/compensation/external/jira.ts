/**
 * Jira compensation handler.
 *
 * Jira Cloud REST v3 (https://developer.atlassian.com/cloud/jira/platform/rest/v3/).
 * Compensation patterns:
 *
 *   - issue.create           → DELETE /issue/{id}  (or transition to Done first)
 *   - issue.update           → PUT /issue/{id} with priorFields
 *   - issue.transition       → POST /issue/{id}/transitions with inverse ID
 *   - issue.delete           → POST /issue/{id} (re-create with priorFields)
 *   - issue.comment_create   → DELETE /issue/{id}/comment/{id}
 *   - issue.worklog_create   → DELETE /issue/{id}/worklog/{id}
 *   - issue.link_create      → DELETE /issueLink/{id}
 *   - attachment.create      → DELETE /attachment/{id}
 *   - issue.assign           → PUT /issue/{id}/assignee with original accountId
 *   - issue.label_add        → PUT /issue/{id} with labels minus the added
 *
 * The compensation for issue.create prefers DELETE over transition-back
 * because:
 *   1. The issue is a fresh entity with no downstream effects yet
 *      (compensations are triggered at the failure point).
 *   2. Finding the correct "back" transition requires a workflow lookup
 *      and may not exist.
 *
 * Idempotency: DELETE on a non-existent issue → 404 → success.
 * PUT is idempotent. POST /transitions is not — we send a `transition.id`
 * and accept that retrying the same transition is a no-op (the second
 * call either moves the issue or rejects the transition).
 */

import type { CompensationHandler } from '../../runtime/compensationRegistry';
import { ResilientHttp, nodeFetchHttp, type HttpSendFn } from './httpClient';
import type { CompensationOutcome } from './types';

export interface JiraConfig {
  baseUrl: string; // e.g. https://your.atlassian.net
  email: string;
  apiToken: string;
  send?: HttpSendFn;
}

interface JiraArgs {
  issueIdOrKey?: string;
  commentId?: string;
  worklogId?: string;
  linkId?: string;
  attachmentId?: string;
  assigneeAccountId?: string;
  label?: string;
  transitionId?: string;
  priorFields?: Record<string, unknown>;
  resourceUrl?: string;
}

function jiraAuthHeader(cfg: JiraConfig): Record<string, string> {
  const creds = Buffer.from(`${cfg.email}:${cfg.apiToken}`).toString('base64');
  return {
    Authorization: `Basic ${creds}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
}

function classifyJira(res: { status: number; body: string }): {
  success: boolean;
  alreadyCompensated?: boolean;
  permanent?: boolean;
  error?: string;
} {
  if (res.status >= 200 && res.status < 300) return { success: true };
  let msg = `HTTP ${res.status}: ${res.body.slice(0, 200)}`;
  try {
    const parsed = JSON.parse(res.body) as {
      errorMessages?: string[];
      errors?: Record<string, string>;
    };
    if (parsed.errorMessages && parsed.errorMessages.length > 0) {
      msg = parsed.errorMessages.join('; ');
    }
  } catch {
    /* not JSON */
  }
  if (res.status === 404) {
    return { success: true, alreadyCompensated: true };
  }
  if (res.status === 401 || res.status === 403) {
    return { success: false, permanent: true, error: msg };
  }
  if (res.status === 400 || res.status === 409) {
    return { success: false, permanent: true, error: msg };
  }
  if (res.status === 429 || res.status >= 500) {
    return { success: false, error: msg };
  }
  return { success: false, permanent: true, error: msg };
}

let _config: JiraConfig | null = null;
export function configureJira(config: JiraConfig): void {
  _config = config;
}

function ensureConfig(): JiraConfig {
  if (_config) return _config;
  const baseUrl = process.env.JIRA_BASE_URL;
  const email = process.env.JIRA_EMAIL;
  const apiToken = process.env.JIRA_API_TOKEN;
  if (!baseUrl || !email || !apiToken) {
    throw new Error('Jira compensation: set JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN');
  }
  return { baseUrl, email, apiToken };
}

async function jiraCall(
  cfg: JiraConfig,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: string,
): Promise<{ status: number; body: string; outcome: CompensationOutcome }> {
  const http = new ResilientHttp(cfg.send ?? nodeFetchHttp, { maxAttempts: 3 });
  const res = await http.send({
    method,
    url: `${cfg.baseUrl.replace(/\/$/, '')}/rest/api/3${path}`,
    headers: jiraAuthHeader(cfg),
    body,
  });
  const cls = classifyJira(res);
  if (cls.success) {
    return {
      status: res.status,
      body: res.body,
      outcome: { success: true, alreadyCompensated: cls.alreadyCompensated },
    };
  }
  if (cls.permanent) {
    return {
      status: res.status,
      body: res.body,
      outcome: { success: false, permanent: true, error: cls.error },
    };
  }
  return { status: res.status, body: res.body, outcome: { success: false, error: cls.error } };
}

const issueCreateHandler: CompensationHandler = async (action) => {
  const cfg = ensureConfig();
  const { issueIdOrKey } = (action.args ?? {}) as JiraArgs;
  if (!issueIdOrKey) return { success: false, permanent: true, error: 'issueIdOrKey required' };
  const r = await jiraCall(cfg, 'DELETE', `/issue/${issueIdOrKey}`);
  return r.outcome;
};

const issueUpdateHandler: CompensationHandler = async (action) => {
  const cfg = ensureConfig();
  const { issueIdOrKey, priorFields } = (action.args ?? {}) as JiraArgs;
  if (!issueIdOrKey || !priorFields) {
    return { success: false, permanent: true, error: 'issueIdOrKey + priorFields required' };
  }
  const r = await jiraCall(
    cfg,
    'PUT',
    `/issue/${issueIdOrKey}`,
    JSON.stringify({ fields: priorFields }),
  );
  return r.outcome;
};

const issueTransitionHandler: CompensationHandler = async (action) => {
  const cfg = ensureConfig();
  const { issueIdOrKey, transitionId } = (action.args ?? {}) as JiraArgs;
  if (!issueIdOrKey || !transitionId) {
    return { success: false, permanent: true, error: 'issueIdOrKey + transitionId required' };
  }
  const r = await jiraCall(
    cfg,
    'POST',
    `/issue/${issueIdOrKey}/transitions`,
    JSON.stringify({ transition: { id: transitionId } }),
  );
  return r.outcome;
};

const issueDeleteHandler: CompensationHandler = async (action) => {
  const cfg = ensureConfig();
  const { issueIdOrKey, priorFields } = (action.args ?? {}) as JiraArgs;
  if (!issueIdOrKey || !priorFields) {
    return {
      success: false,
      permanent: true,
      error: 'issue delete compensation requires issueIdOrKey + priorFields to re-create',
    };
  }
  const r = await jiraCall(cfg, 'POST', '/issue', JSON.stringify({ fields: priorFields }));
  return r.outcome;
};

const commentCreateHandler: CompensationHandler = async (action) => {
  const cfg = ensureConfig();
  const { issueIdOrKey, commentId } = (action.args ?? {}) as JiraArgs;
  if (!issueIdOrKey || !commentId) {
    return { success: false, permanent: true, error: 'issueIdOrKey + commentId required' };
  }
  const r = await jiraCall(cfg, 'DELETE', `/issue/${issueIdOrKey}/comment/${commentId}`);
  return r.outcome;
};

const worklogCreateHandler: CompensationHandler = async (action) => {
  const cfg = ensureConfig();
  const { issueIdOrKey, worklogId } = (action.args ?? {}) as JiraArgs;
  if (!issueIdOrKey || !worklogId) {
    return { success: false, permanent: true, error: 'issueIdOrKey + worklogId required' };
  }
  const r = await jiraCall(cfg, 'DELETE', `/issue/${issueIdOrKey}/worklog/${worklogId}`);
  return r.outcome;
};

const linkCreateHandler: CompensationHandler = async (action) => {
  const cfg = ensureConfig();
  const { linkId } = (action.args ?? {}) as JiraArgs;
  if (!linkId) return { success: false, permanent: true, error: 'linkId required' };
  const r = await jiraCall(cfg, 'DELETE', `/issueLink/${linkId}`);
  return r.outcome;
};

const attachmentCreateHandler: CompensationHandler = async (action) => {
  const cfg = ensureConfig();
  const { attachmentId } = (action.args ?? {}) as JiraArgs;
  if (!attachmentId) return { success: false, permanent: true, error: 'attachmentId required' };
  const r = await jiraCall(cfg, 'DELETE', `/attachment/${attachmentId}`);
  return r.outcome;
};

const assignHandler: CompensationHandler = async (action) => {
  const cfg = ensureConfig();
  const { issueIdOrKey, assigneeAccountId } = (action.args ?? {}) as JiraArgs;
  if (!issueIdOrKey) {
    return { success: false, permanent: true, error: 'issueIdOrKey required' };
  }
  // Set assignee to original (or null for unassign)
  const r = await jiraCall(
    cfg,
    'PUT',
    `/issue/${issueIdOrKey}/assignee`,
    JSON.stringify({ accountId: assigneeAccountId ?? null }),
  );
  return r.outcome;
};

const labelAddHandler: CompensationHandler = async (action) => {
  const cfg = ensureConfig();
  const { issueIdOrKey, label, priorFields } = (action.args ?? {}) as JiraArgs;
  if (!issueIdOrKey || !priorFields) {
    return { success: false, permanent: true, error: 'issueIdOrKey + priorFields required' };
  }
  // The planner is responsible for computing priorFields that do NOT
  // include the label we added (i.e. the labels array as it was before).
  void label;
  const r = await jiraCall(
    cfg,
    'PUT',
    `/issue/${issueIdOrKey}`,
    JSON.stringify({ fields: priorFields }),
  );
  return r.outcome;
};

export const JIRA_COMPENSATION_HANDLERS: Record<string, CompensationHandler> = {
  jira_issue_create: issueCreateHandler,
  jira_issue_update: issueUpdateHandler,
  jira_issue_transition: issueTransitionHandler,
  jira_issue_delete: issueDeleteHandler,
  jira_issue_comment_create: commentCreateHandler,
  jira_issue_worklog_create: worklogCreateHandler,
  jira_issue_link_create: linkCreateHandler,
  jira_attachment_create: attachmentCreateHandler,
  jira_issue_assign: assignHandler,
  jira_issue_label_add: labelAddHandler,
};

export const JIRA_TOOL_TAGS: Record<string, string[]> = {
  jira_issue_create: ['jira', 'jira:issue', 'destructive', 'requires_approval'],
  jira_issue_update: ['jira', 'jira:issue', 'low_risk'],
  jira_issue_transition: ['jira', 'jira:transition', 'destructive'],
  jira_issue_delete: ['jira', 'jira:issue', 'destructive'],
  jira_issue_comment_create: ['jira', 'jira:comment', 'low_risk'],
  jira_issue_worklog_create: ['jira', 'jira:worklog', 'low_risk'],
  jira_issue_link_create: ['jira', 'jira:link', 'destructive'],
  jira_attachment_create: ['jira', 'jira:attachment', 'destructive'],
  jira_issue_assign: ['jira', 'jira:assignee', 'low_risk'],
  jira_issue_label_add: ['jira', 'jira:label', 'low_risk'],
};

export function registerJiraCompensation(): void {
  const { getExecutionScheduler } =
    require('../../atr/scheduler') as typeof import('../../atr/scheduler');
  const scheduler = getExecutionScheduler();
  for (const [toolName, handler] of Object.entries(JIRA_COMPENSATION_HANDLERS)) {
    scheduler.registerCompensation(toolName, handler);
  }
}
