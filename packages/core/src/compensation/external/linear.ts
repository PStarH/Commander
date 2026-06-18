/**
 * Linear compensation handler.
 *
 * Linear uses GraphQL (https://developers.linear.app/docs/graphql/working-with-the-graphql-api).
 * Inverse mutations:
 *
 *   - issueCreate      → issueArchive (or issueDelete with hardDelete:false)
 *   - issueUpdate      → issueUpdate with prior fields
 *   - issueArchive     → issueUnarchive
 *   - issueDelete      → issueCreate with prior fields
 *   - commentCreate    → commentDelete
 *   - commentUpdate    → commentUpdate with prior body
 *   - attachmentCreate → attachmentDelete
 *   - attachmentDelete → attachmentCreate with prior url
 *   - projectCreate    → projectArchive (or projectDelete)
 *   - projectUpdate    → projectUpdate with prior
 *   - teamCreate       → teamDelete (only if no issues)
 *   - labelCreate      → labelDelete (or labelArchive)
 *   - projectMilestoneCreate → projectMilestoneDelete
 *   - reactionCreate   → reactionDelete
 *   - documentCreate   → documentDelete
 *
 * Linear's mutations are NOT natively idempotent on retry. We rely on
 * the unique IDs returned by the forward action; the inverse is keyed
 * on that ID. If the inverse fails because the resource is already
 * gone, we treat that as success.
 */

import type { CompensationHandler } from '../../runtime/compensationRegistry';
import { ResilientHttp, nodeFetchHttp, type HttpSendFn } from './httpClient';
import type { CompensationOutcome } from './types';

export interface LinearConfig {
  token: string;
  baseUrl?: string;
  send?: HttpSendFn;
}

const LINEAR_API = 'https://api.linear.app/graphql';

interface LinearArgs {
  /** Linear UUID of the resource to compensate. */
  id?: string;
  issueId?: string;
  commentId?: string;
  attachmentId?: string;
  projectId?: string;
  projectMilestoneId?: string;
  teamId?: string;
  labelId?: string;
  reactionId?: string;
  documentId?: string;
  /** Prior state for revert-style compensations. */
  priorInput?: Record<string, unknown>;
  /** Used for some restore-from-archive compensations. */
  trashed?: boolean;
}

function classifyLinear(res: { status: number; body: string }): {
  success: boolean;
  alreadyCompensated?: boolean;
  permanent?: boolean;
  error?: string;
} {
  if (res.status >= 200 && res.status < 300) {
    // GraphQL returns 200 with `errors` on failure
    try {
      const parsed = JSON.parse(res.body) as {
        data?: unknown;
        errors?: Array<{ message: string; extensions?: { type?: string; code?: string } }>;
      };
      if (parsed.errors && parsed.errors.length > 0) {
        const messages = parsed.errors.map((e) => e.message).join('; ');
        const types = parsed.errors
          .flatMap((e) => [e.extensions?.type, e.extensions?.code])
          .filter(Boolean) as string[];
        if (
          types.includes('NOT_FOUND') ||
          messages.includes('not found') ||
          messages.includes('Entity not found')
        ) {
          return { success: true, alreadyCompensated: true };
        }
        if (
          types.includes('FORBIDDEN') ||
          types.includes('UNAUTHORIZED') ||
          types.includes('INVALID_INPUT')
        ) {
          return { success: false, permanent: true, error: messages };
        }
        return { success: false, error: messages };
      }
    } catch {
      /* not JSON */
    }
    return { success: true };
  }
  const msg = `HTTP ${res.status}: ${res.body.slice(0, 200)}`;
  if (res.status === 401 || res.status === 403) {
    return { success: false, permanent: true, error: msg };
  }
  if (res.status === 429 || res.status >= 500) {
    return { success: false, error: msg };
  }
  return { success: false, permanent: true, error: msg };
}

let _config: LinearConfig | null = null;
export function configureLinear(config: LinearConfig): void {
  _config = config;
}

function ensureConfig(): LinearConfig {
  if (_config) return _config;
  const token = process.env.LINEAR_API_KEY ?? process.env.LINEAR_TOKEN;
  if (!token) {
    throw new Error(
      'Linear compensation: no config — call configureLinear() or set LINEAR_API_KEY',
    );
  }
  return { token };
}

async function linearMutate(
  cfg: LinearConfig,
  query: string,
  variables: Record<string, unknown>,
): Promise<{ status: number; body: string; outcome: CompensationOutcome }> {
  const http = new ResilientHttp(cfg.send ?? nodeFetchHttp, { maxAttempts: 3 });
  const res = await http.send({
    method: 'POST',
    url: cfg.baseUrl ?? LINEAR_API,
    headers: {
      Authorization: cfg.token,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  });
  const cls = classifyLinear(res);
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
  const { issueId } = (action.args ?? {}) as LinearArgs;
  if (!issueId) return { success: false, permanent: true, error: 'issueId required' };
  return (
    await linearMutate(
      cfg,
      `mutation IssueArchive($id: String!) { issueArchive(id: $id) { success entity { id archivedAt } } }`,
      { id: issueId },
    )
  ).outcome;
};

const issueUpdateHandler: CompensationHandler = async (action) => {
  const cfg = ensureConfig();
  const { issueId, priorInput } = (action.args ?? {}) as LinearArgs;
  if (!issueId || !priorInput) {
    return { success: false, permanent: true, error: 'issueId + priorInput required' };
  }
  return (
    await linearMutate(
      cfg,
      `mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) {
       issueUpdate(id: $id, input: $input) { success issue { id } }
     }`,
      { id: issueId, input: priorInput },
    )
  ).outcome;
};

const issueArchiveHandler: CompensationHandler = async (action) => {
  const cfg = ensureConfig();
  const { issueId } = (action.args ?? {}) as LinearArgs;
  if (!issueId) return { success: false, permanent: true, error: 'issueId required' };
  return (
    await linearMutate(
      cfg,
      `mutation IssueUnarchive($id: String!) { issueUnarchive(id: $id) { success entity { id } } }`,
      { id: issueId },
    )
  ).outcome;
};

const issueDeleteHandler: CompensationHandler = async (action) => {
  const cfg = ensureConfig();
  const { issueId, priorInput } = (action.args ?? {}) as LinearArgs;
  if (!issueId || !priorInput) {
    return {
      success: false,
      permanent: true,
      error: 'issue delete compensation requires issueId + priorInput',
    };
  }
  return (
    await linearMutate(
      cfg,
      `mutation IssueCreate($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id } } }`,
      { input: priorInput },
    )
  ).outcome;
};

const commentCreateHandler: CompensationHandler = async (action) => {
  const cfg = ensureConfig();
  const { commentId } = (action.args ?? {}) as LinearArgs;
  if (!commentId) return { success: false, permanent: true, error: 'commentId required' };
  return (
    await linearMutate(
      cfg,
      `mutation CommentDelete($id: String!) { commentDelete(id: $id) { success entity { id } } }`,
      { id: commentId },
    )
  ).outcome;
};

const commentUpdateHandler: CompensationHandler = async (action) => {
  const cfg = ensureConfig();
  const { commentId, priorInput } = (action.args ?? {}) as LinearArgs;
  if (!commentId || !priorInput) {
    return { success: false, permanent: true, error: 'commentId + priorInput required' };
  }
  return (
    await linearMutate(
      cfg,
      `mutation CommentUpdate($id: String!, $input: CommentUpdateInput!) {
       commentUpdate(id: $id, input: $input) { success comment { id } }
     }`,
      { id: commentId, input: priorInput },
    )
  ).outcome;
};

const attachmentCreateHandler: CompensationHandler = async (action) => {
  const cfg = ensureConfig();
  const { attachmentId } = (action.args ?? {}) as LinearArgs;
  if (!attachmentId) return { success: false, permanent: true, error: 'attachmentId required' };
  return (
    await linearMutate(
      cfg,
      `mutation AttachmentDelete($id: String!) { attachmentDelete(id: $id) { success entity { id } } }`,
      { id: attachmentId },
    )
  ).outcome;
};

const projectCreateHandler: CompensationHandler = async (action) => {
  const cfg = ensureConfig();
  const { projectId } = (action.args ?? {}) as LinearArgs;
  if (!projectId) return { success: false, permanent: true, error: 'projectId required' };
  return (
    await linearMutate(
      cfg,
      `mutation ProjectArchive($id: String!) { projectArchive(id: $id) { success entity { id } } }`,
      { id: projectId },
    )
  ).outcome;
};

const projectUpdateHandler: CompensationHandler = async (action) => {
  const cfg = ensureConfig();
  const { projectId, priorInput } = (action.args ?? {}) as LinearArgs;
  if (!projectId || !priorInput) {
    return { success: false, permanent: true, error: 'projectId + priorInput required' };
  }
  return (
    await linearMutate(
      cfg,
      `mutation ProjectUpdate($id: String!, $input: ProjectUpdateInput!) {
       projectUpdate(id: $id, input: $input) { success project { id } }
     }`,
      { id: projectId, input: priorInput },
    )
  ).outcome;
};

const teamCreateHandler: CompensationHandler = async (action) => {
  const cfg = ensureConfig();
  const { teamId } = (action.args ?? {}) as LinearArgs;
  if (!teamId) return { success: false, permanent: true, error: 'teamId required' };
  return (
    await linearMutate(
      cfg,
      `mutation TeamDelete($id: String!) { teamDelete(id: $id) { success entity { id } } }`,
      { id: teamId },
    )
  ).outcome;
};

const labelCreateHandler: CompensationHandler = async (action) => {
  const cfg = ensureConfig();
  const { labelId } = (action.args ?? {}) as LinearArgs;
  if (!labelId) return { success: false, permanent: true, error: 'labelId required' };
  return (
    await linearMutate(
      cfg,
      `mutation LabelArchive($id: String!) { labelArchive(id: $id) { success entity { id archivedAt } } }`,
      { id: labelId },
    )
  ).outcome;
};

const milestoneCreateHandler: CompensationHandler = async (action) => {
  const cfg = ensureConfig();
  const { projectMilestoneId } = (action.args ?? {}) as LinearArgs;
  if (!projectMilestoneId) {
    return { success: false, permanent: true, error: 'projectMilestoneId required' };
  }
  return (
    await linearMutate(
      cfg,
      `mutation ProjectMilestoneDelete($id: String!) { projectMilestoneDelete(id: $id) { success entity { id } } }`,
      { id: projectMilestoneId },
    )
  ).outcome;
};

const reactionCreateHandler: CompensationHandler = async (action) => {
  const cfg = ensureConfig();
  const { reactionId } = (action.args ?? {}) as LinearArgs;
  if (!reactionId) return { success: false, permanent: true, error: 'reactionId required' };
  return (
    await linearMutate(
      cfg,
      `mutation ReactionDelete($id: String!) { reactionDelete(id: $id) { success entity { id } } }`,
      { id: reactionId },
    )
  ).outcome;
};

const documentCreateHandler: CompensationHandler = async (action) => {
  const cfg = ensureConfig();
  const { documentId } = (action.args ?? {}) as LinearArgs;
  if (!documentId) return { success: false, permanent: true, error: 'documentId required' };
  return (
    await linearMutate(
      cfg,
      `mutation DocumentDelete($id: String!) { documentDelete(id: $id) { success entity { id } } }`,
      { id: documentId },
    )
  ).outcome;
};

export const LINEAR_COMPENSATION_HANDLERS: Record<string, CompensationHandler> = {
  linear_issue_create: issueCreateHandler,
  linear_issue_update: issueUpdateHandler,
  linear_issue_archive: issueArchiveHandler,
  linear_issue_delete: issueDeleteHandler,
  linear_comment_create: commentCreateHandler,
  linear_comment_update: commentUpdateHandler,
  linear_attachment_create: attachmentCreateHandler,
  linear_project_create: projectCreateHandler,
  linear_project_update: projectUpdateHandler,
  linear_team_create: teamCreateHandler,
  linear_label_create: labelCreateHandler,
  linear_project_milestone_create: milestoneCreateHandler,
  linear_reaction_create: reactionCreateHandler,
  linear_document_create: documentCreateHandler,
};

export const LINEAR_TOOL_TAGS: Record<string, string[]> = {
  linear_issue_create: ['linear', 'linear:issue', 'destructive'],
  linear_issue_update: ['linear', 'linear:issue', 'low_risk'],
  linear_issue_archive: ['linear', 'linear:issue', 'low_risk'],
  linear_issue_delete: ['linear', 'linear:issue', 'destructive'],
  linear_comment_create: ['linear', 'linear:comment', 'low_risk'],
  linear_comment_update: ['linear', 'linear:comment', 'low_risk'],
  linear_attachment_create: ['linear', 'linear:attachment', 'destructive'],
  linear_project_create: ['linear', 'linear:project', 'destructive', 'requires_approval'],
  linear_project_update: ['linear', 'linear:project', 'low_risk'],
  linear_team_create: ['linear', 'linear:team', 'destructive', 'requires_approval'],
  linear_label_create: ['linear', 'linear:label', 'low_risk'],
  linear_project_milestone_create: ['linear', 'linear:milestone', 'destructive'],
  linear_reaction_create: ['linear', 'linear:reaction', 'low_risk'],
  linear_document_create: ['linear', 'linear:document', 'destructive'],
};

export function registerLinearCompensation(): void {
  const { getExecutionScheduler } =
    require('../../atr/scheduler') as typeof import('../../atr/scheduler');
  const scheduler = getExecutionScheduler();
  for (const [toolName, handler] of Object.entries(LINEAR_COMPENSATION_HANDLERS)) {
    scheduler.registerCompensation(toolName, handler);
  }
}
