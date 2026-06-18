/**
 * Notion compensation handler.
 *
 * Notion's API is REST with a Notion-Version header. The key
 * compensation pattern is `archived: true` → set to `false` to restore.
 * Notion does NOT support true "delete and undelete" — once a page
 * is fully deleted, it is gone. Archive is the canonical undo.
 *
 *   Source: https://developers.notion.com/reference/archive-a-page
 *
 * Inverse operation mapping:
 *   - post-page          → PATCH archived=true
 *   - patch-page         → PATCH (revert fields; needs priorPage)
 *   - post-block (create child) → DELETE block
 *   - update-block       → PATCH (revert fields; needs priorBlock)
 *   - delete-block       → post-block (re-create; needs priorBlock)
 *   - create-database    → PATCH archived=true
 *   - add-row            → PATCH archived=true on the page
 *   - update-row         → PATCH (revert properties; needs priorRow)
 *   - share-invite       → not reversible; flag for review
 *   - comment-create     → DELETE comment
 *
 * Idempotency: archive is idempotent (already-archived is success).
 * DELETE on a non-existent block → 404 → success.
 */

import type { CompensationHandler } from '../../runtime/compensationRegistry';
import { ResilientHttp, nodeFetchHttp, type HttpSendFn } from './httpClient';
import type { CompensationOutcome } from './types';

export interface NotionConfig {
  token: string;
  notionVersion?: string;
  baseUrl?: string;
  send?: HttpSendFn;
}

const NOTION_API = 'https://api.notion.com/v1';
const DEFAULT_NOTION_VERSION = '2022-06-28';

interface NotionArgs {
  pageId?: string;
  blockId?: string;
  databaseId?: string;
  commentId?: string;
  /** Prior page/block properties for revert-style compensations. */
  priorPage?: Record<string, unknown>;
  priorBlock?: Record<string, unknown>;
  priorRow?: Record<string, unknown>;
  resourceUrl?: string;
}

function notionHeaders(cfg: NotionConfig): Record<string, string> {
  return {
    Authorization: `Bearer ${cfg.token}`,
    'Notion-Version': cfg.notionVersion ?? DEFAULT_NOTION_VERSION,
    'Content-Type': 'application/json',
  };
}

function classifyNotion(res: { status: number; body: string }): {
  success: boolean;
  alreadyCompensated?: boolean;
  permanent?: boolean;
  error?: string;
} {
  if (res.status >= 200 && res.status < 300) {
    return { success: true };
  }
  let msg = `HTTP ${res.status}: ${res.body.slice(0, 200)}`;
  try {
    const parsed = JSON.parse(res.body) as { code?: string; message?: string };
    if (parsed.message) msg = parsed.message;
    // 404 / "object_not_found" → already gone
    if (res.status === 404 || parsed.code === 'object_not_found') {
      return { success: true, alreadyCompensated: true };
    }
    // Auth errors → permanent
    if (res.status === 401 || res.status === 403) {
      return { success: false, permanent: true, error: msg };
    }
    // Validation errors → permanent
    if (res.status === 400 || res.status === 409) {
      return { success: false, permanent: true, error: msg };
    }
  } catch {
    // not JSON
  }
  if (res.status === 429 || res.status >= 500) {
    return { success: false, error: msg };
  }
  return { success: false, permanent: true, error: msg };
}

let _config: NotionConfig | null = null;
export function configureNotion(config: NotionConfig): void {
  _config = config;
}

function ensureConfig(): NotionConfig {
  if (_config) return _config;
  const token = process.env.NOTION_TOKEN;
  if (!token) {
    throw new Error('Notion compensation: no config — call configureNotion() or set NOTION_TOKEN');
  }
  return { token };
}

async function notionCall(
  cfg: NotionConfig,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body?: string,
): Promise<{ status: number; body: string; outcome: CompensationOutcome }> {
  const http = new ResilientHttp(cfg.send ?? nodeFetchHttp, { maxAttempts: 3 });
  const res = await http.send({
    method,
    url: `${cfg.baseUrl ?? NOTION_API}${path}`,
    headers: notionHeaders(cfg),
    body,
  });
  const cls = classifyNotion(res);
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

const pageCreateHandler: CompensationHandler = async (action) => {
  const cfg = ensureConfig();
  const { pageId } = (action.args ?? {}) as NotionArgs;
  if (!pageId) return { success: false, permanent: true, error: 'pageId required' };
  const r = await notionCall(cfg, 'PATCH', `/pages/${pageId}`, JSON.stringify({ archived: true }));
  return r.outcome;
};

const pageUpdateHandler: CompensationHandler = async (action) => {
  const cfg = ensureConfig();
  const { pageId, priorPage } = (action.args ?? {}) as NotionArgs;
  if (!pageId || !priorPage) {
    return { success: false, permanent: true, error: 'pageId + priorPage required' };
  }
  const r = await notionCall(cfg, 'PATCH', `/pages/${pageId}`, JSON.stringify(priorPage));
  return r.outcome;
};

const pageDeleteHandler: CompensationHandler = async (action) => {
  // Notion's "delete" is just an archive. The planner chooses this
  // because re-creating is non-trivial.
  return pageCreateHandler(action);
};

const blockCreateHandler: CompensationHandler = async (action) => {
  const cfg = ensureConfig();
  const { blockId } = (action.args ?? {}) as NotionArgs;
  if (!blockId) return { success: false, permanent: true, error: 'blockId required' };
  const r = await notionCall(cfg, 'DELETE', `/blocks/${blockId}`);
  return r.outcome;
};

const blockUpdateHandler: CompensationHandler = async (action) => {
  const cfg = ensureConfig();
  const { blockId, priorBlock } = (action.args ?? {}) as NotionArgs;
  if (!blockId || !priorBlock) {
    return { success: false, permanent: true, error: 'blockId + priorBlock required' };
  }
  const r = await notionCall(cfg, 'PATCH', `/blocks/${blockId}`, JSON.stringify(priorBlock));
  return r.outcome;
};

const blockDeleteHandler: CompensationHandler = async (action) => {
  const cfg = ensureConfig();
  const { blockId, priorBlock } = (action.args ?? {}) as NotionArgs;
  if (!blockId || !priorBlock) {
    return {
      success: false,
      permanent: true,
      error: 'block compensation requires blockId + priorBlock to re-create',
    };
  }
  // Re-create: Notion doesn't have a "create block under parent" via
  // a single endpoint — we use Append Block Children. The parent is
  // recorded in priorBlock.parent. Best-effort.
  const parent = (priorBlock as { parent?: { type?: string; page_id?: string; block_id?: string } })
    .parent;
  if (!parent || !parent.type) {
    return {
      success: false,
      permanent: true,
      error: 'priorBlock.parent required to re-create block',
    };
  }
  const parentId = (parent as Record<string, string | undefined>)[`${parent.type}_id`];
  if (!parentId) {
    return { success: false, permanent: true, error: 'parent id missing' };
  }
  const r = await notionCall(
    cfg,
    'PATCH',
    `/blocks/${parentId}/children`,
    JSON.stringify({ children: [priorBlock] }),
  );
  return r.outcome;
};

const databaseCreateHandler: CompensationHandler = async (action) => {
  const cfg = ensureConfig();
  const { databaseId } = (action.args ?? {}) as NotionArgs;
  if (!databaseId) return { success: false, permanent: true, error: 'databaseId required' };
  const r = await notionCall(
    cfg,
    'PATCH',
    `/databases/${databaseId}`,
    JSON.stringify({ archived: true }),
  );
  return r.outcome;
};

const rowCreateHandler: CompensationHandler = async (action) => {
  // Rows in Notion are pages. Compensation: archive.
  return pageCreateHandler(action);
};

const rowUpdateHandler: CompensationHandler = async (action) => {
  const cfg = ensureConfig();
  const { pageId, priorRow } = (action.args ?? {}) as NotionArgs;
  if (!pageId || !priorRow) {
    return { success: false, permanent: true, error: 'pageId + priorRow required' };
  }
  const r = await notionCall(
    cfg,
    'PATCH',
    `/pages/${pageId}`,
    JSON.stringify({ properties: priorRow }),
  );
  return r.outcome;
};

const commentCreateHandler: CompensationHandler = async (action) => {
  const cfg = ensureConfig();
  const { commentId } = (action.args ?? {}) as NotionArgs;
  if (!commentId) return { success: false, permanent: true, error: 'commentId required' };
  const r = await notionCall(cfg, 'DELETE', `/comments/${commentId}`);
  return r.outcome;
};

const shareInviteHandler: CompensationHandler = async (action) => {
  return {
    success: false,
    permanent: true,
    error:
      'Notion share-invite is not reversible via API; revoke manually. Action: ' + action.actionId,
  };
};

export const NOTION_COMPENSATION_HANDLERS: Record<string, CompensationHandler> = {
  notion_page_create: pageCreateHandler,
  notion_page_update: pageUpdateHandler,
  notion_page_delete: pageDeleteHandler,
  notion_block_create: blockCreateHandler,
  notion_block_update: blockUpdateHandler,
  notion_block_delete: blockDeleteHandler,
  notion_database_create: databaseCreateHandler,
  notion_row_create: rowCreateHandler,
  notion_row_update: rowUpdateHandler,
  notion_comment_create: commentCreateHandler,
  notion_share_invite: shareInviteHandler,
};

export const NOTION_TOOL_TAGS: Record<string, string[]> = {
  notion_page_create: ['notion', 'notion:page', 'destructive'],
  notion_page_update: ['notion', 'notion:page', 'low_risk'],
  notion_page_delete: ['notion', 'notion:page', 'destructive'],
  notion_block_create: ['notion', 'notion:block', 'low_risk'],
  notion_block_update: ['notion', 'notion:block', 'low_risk'],
  notion_block_delete: ['notion', 'notion:block', 'destructive'],
  notion_database_create: ['notion', 'notion:database', 'destructive'],
  notion_row_create: ['notion', 'notion:row', 'destructive'],
  notion_row_update: ['notion', 'notion:row', 'low_risk'],
  notion_comment_create: ['notion', 'notion:comment', 'low_risk'],
  notion_share_invite: ['notion', 'notion:share', 'non_reversible'],
};

export function registerNotionCompensation(): void {
  const { getExecutionScheduler } =
    require('../../atr/scheduler') as typeof import('../../atr/scheduler');
  const scheduler = getExecutionScheduler();
  for (const [toolName, handler] of Object.entries(NOTION_COMPENSATION_HANDLERS)) {
    scheduler.registerCompensation(toolName, handler);
  }
}
