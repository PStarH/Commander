/**
 * Slack compensation handler.
 *
 * Slack's API has limited "undo" semantics — bots cannot unsend or
 * edit messages on the user's behalf. The closest compensations:
 *
 *   - chat.postMessage       → chat.delete (delete the message)
 *   - chat.update            → chat.update (restore prior text; needs priorText)
 *   - reactions.add          → reactions.remove
 *   - chat.scheduleMessage   → chat.deleteScheduledMessage
 *   - conversations.invite   → conversations.kick
 *   - users.profile.set      → not reversible; flag for review
 *   - files.upload           → files.delete
 *   - pins.add               → pins.remove
 *   - bookmarks.add          → bookmarks.remove
 *
 * Idempotency: Slack's Web API does not natively support idempotency
 * keys. DELETE is naturally idempotent (second call returns
 * `message_not_found` → treat as success). For POSTs that need
 * deduplication, the `Idempotency-Key` header is silently passed
 * through if Slack adds support in the future.
 *
 *   Source: https://api.slack.com/web
 */

import type { CompensationHandler } from '../../runtime/compensationRegistry';
import { ResilientHttp, nodeFetchHttp, type HttpSendFn } from './httpClient';
import type { CompensationOutcome } from './types';

export interface SlackConfig {
  token: string;
  baseUrl?: string;
  send?: HttpSendFn;
}

const SLACK_API = 'https://slack.com/api';

interface SlackArgs {
  channel?: string;
  ts?: string;
  scheduledMessageId?: string;
  user?: string;
  fileId?: string;
  pinChannel?: string;
  bookmarkId?: string;
  priorText?: string;
  priorBlocks?: unknown;
  resourceUrl?: string;
}

function slackHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json; charset=utf-8',
  };
}

function formBody(args: Record<string, unknown>): string {
  return JSON.stringify(args);
}

/**
 * Slack returns 200 with a `{"ok": false, "error": "..."}` body when
 * the request "fails" at the protocol level. We need to inspect that
 * envelope, not just the status.
 */
function parseSlackOk(body: string): { ok: boolean; error?: string; warning?: string } {
  try {
    const parsed = JSON.parse(body) as { ok?: boolean; error?: string; warning?: string };
    return { ok: parsed.ok === true, error: parsed.error, warning: parsed.warning };
  } catch {
    return { ok: false, error: 'non-JSON response' };
  }
}

function classifySlack(
  parsed: { ok: boolean; error?: string },
  status: number,
): { success: boolean; alreadyCompensated?: boolean; permanent?: boolean; error?: string } {
  if (parsed.ok) return { success: true };
  if (!parsed.error) {
    if (status >= 500 || status === 429)
      return { success: false, error: `retryable HTTP ${status}` };
    return { success: false, permanent: true, error: `HTTP ${status}` };
  }
  // Specific Slack errors that mean "already compensated"
  const alreadyGone = [
    'message_not_found',
    'channel_not_found',
    'file_not_found',
    'no_item_specified',
    'pin_not_found',
    'bookmark_not_found',
    'already_deleted',
    'cant_delete_message',
    'not_in_channel', // kicking someone who isn't there → success
  ];
  if (alreadyGone.includes(parsed.error)) {
    return { success: true, alreadyCompensated: true };
  }
  // Permanent errors
  const permanent = [
    'invalid_auth',
    'not_authed',
    'account_inactive',
    'token_revoked',
    'missing_scope',
    'restricted_action',
  ];
  if (permanent.includes(parsed.error)) {
    return { success: false, permanent: true, error: parsed.error };
  }
  // Rate limit
  if (parsed.error === 'ratelimited') {
    return { success: false, error: 'rate_limited' };
  }
  // Default: treat as retryable for safety
  return { success: false, error: parsed.error };
}

let _config: SlackConfig | null = null;
export function configureSlack(config: SlackConfig): void {
  _config = config;
}

function ensureConfig(): SlackConfig {
  if (_config) return _config;
  const token = process.env.SLACK_BOT_TOKEN ?? process.env.SLACK_TOKEN;
  if (!token) {
    throw new Error('Slack compensation: no config — call configureSlack() or set SLACK_BOT_TOKEN');
  }
  return { token };
}

async function slackCall(
  cfg: SlackConfig,
  method: string,
  args: Record<string, unknown>,
): Promise<{ status: number; body: string; outcome: CompensationOutcome }> {
  const http = new ResilientHttp(cfg.send ?? nodeFetchHttp, { maxAttempts: 3 });
  const res = await http.send({
    method: 'POST',
    url: `${cfg.baseUrl ?? SLACK_API}/${method}`,
    headers: slackHeaders(cfg.token),
    body: formBody(args),
  });
  const parsed = parseSlackOk(res.body);
  const cls = classifySlack(parsed, res.status);
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

const slackPostMessageHandler: CompensationHandler = async (action) => {
  const cfg = ensureConfig();
  const { channel, ts } = (action.args ?? {}) as SlackArgs;
  if (!channel || !ts) return { success: false, permanent: true, error: 'channel + ts required' };
  const r = await slackCall(cfg, 'chat.delete', { channel, ts });
  return r.outcome;
};

const slackUpdateMessageHandler: CompensationHandler = async (action) => {
  const cfg = ensureConfig();
  const { channel, ts, priorText, priorBlocks } = (action.args ?? {}) as SlackArgs;
  if (!channel || !ts) return { success: false, permanent: true, error: 'channel + ts required' };
  if (!priorText && !priorBlocks) {
    return {
      success: false,
      permanent: true,
      error: 'priorText or priorBlocks required to compensate update',
    };
  }
  const r = await slackCall(cfg, 'chat.update', {
    channel,
    ts,
    ...(priorText ? { text: priorText } : {}),
    ...(priorBlocks ? { blocks: priorBlocks } : {}),
  });
  return r.outcome;
};

const slackReactionAddHandler: CompensationHandler = async (action) => {
  const cfg = ensureConfig();
  const args = (action.args ?? {}) as SlackArgs & { name?: string; timestamp?: string };
  if (!args.channel || !args.timestamp || !args.name) {
    return { success: false, permanent: true, error: 'channel + timestamp + name required' };
  }
  const r = await slackCall(cfg, 'reactions.remove', {
    channel: args.channel,
    timestamp: args.timestamp,
    name: args.name,
  });
  return r.outcome;
};

const slackScheduleHandler: CompensationHandler = async (action) => {
  const cfg = ensureConfig();
  const { channel, scheduledMessageId } = (action.args ?? {}) as SlackArgs;
  if (!channel || !scheduledMessageId) {
    return { success: false, permanent: true, error: 'channel + scheduledMessageId required' };
  }
  const r = await slackCall(cfg, 'chat.deleteScheduledMessage', {
    channel,
    scheduled_message_id: scheduledMessageId,
  });
  return r.outcome;
};

const slackInviteHandler: CompensationHandler = async (action) => {
  const cfg = ensureConfig();
  const { channel, user } = (action.args ?? {}) as SlackArgs;
  if (!channel || !user) {
    return { success: false, permanent: true, error: 'channel + user required' };
  }
  const r = await slackCall(cfg, 'conversations.kick', { channel, user });
  return r.outcome;
};

const slackFileUploadHandler: CompensationHandler = async (action) => {
  const cfg = ensureConfig();
  const { fileId } = (action.args ?? {}) as SlackArgs;
  if (!fileId) return { success: false, permanent: true, error: 'fileId required' };
  const r = await slackCall(cfg, 'files.delete', { file: fileId });
  return r.outcome;
};

const slackPinHandler: CompensationHandler = async (action) => {
  const cfg = ensureConfig();
  const { channel, ts } = (action.args ?? {}) as SlackArgs;
  if (!channel || !ts) {
    return { success: false, permanent: true, error: 'channel + ts required' };
  }
  const r = await slackCall(cfg, 'pins.remove', { channel, timestamp: ts });
  return r.outcome;
};

const slackBookmarkHandler: CompensationHandler = async (action) => {
  const cfg = ensureConfig();
  const { channel, bookmarkId } = (action.args ?? {}) as SlackArgs;
  if (!channel || !bookmarkId) {
    return { success: false, permanent: true, error: 'channel + bookmarkId required' };
  }
  const r = await slackCall(cfg, 'bookmarks.remove', { channel, bookmark_id: bookmarkId });
  return r.outcome;
};

const slackProfileSetHandler: CompensationHandler = async (action) => {
  return {
    success: false,
    permanent: true,
    error:
      'Slack users.profile.set is not reversible via API; manual restoration required. Action: ' +
      action.actionId,
  };
};

export const SLACK_COMPENSATION_HANDLERS: Record<string, CompensationHandler> = {
  slack_chat_postMessage: slackPostMessageHandler,
  slack_chat_update: slackUpdateMessageHandler,
  slack_reactions_add: slackReactionAddHandler,
  slack_chat_scheduleMessage: slackScheduleHandler,
  slack_conversations_invite: slackInviteHandler,
  slack_files_upload: slackFileUploadHandler,
  slack_pins_add: slackPinHandler,
  slack_bookmarks_add: slackBookmarkHandler,
  slack_users_profile_set: slackProfileSetHandler,
  // Aliases
  slack_post: slackPostMessageHandler,
  slack_react: slackReactionAddHandler,
  slack_schedule: slackScheduleHandler,
  slack_invite: slackInviteHandler,
};

export const SLACK_TOOL_TAGS: Record<string, string[]> = {
  slack_chat_postMessage: ['slack', 'slack:message', 'destructive', 'requires_approval'],
  slack_chat_update: ['slack', 'slack:message', 'low_risk'],
  slack_reactions_add: ['slack', 'slack:reaction', 'low_risk'],
  slack_chat_scheduleMessage: ['slack', 'slack:scheduled', 'destructive'],
  slack_conversations_invite: ['slack', 'slack:invite', 'destructive', 'requires_approval'],
  slack_files_upload: ['slack', 'slack:file', 'destructive'],
  slack_pins_add: ['slack', 'slack:pin', 'low_risk'],
  slack_bookmarks_add: ['slack', 'slack:bookmark', 'low_risk'],
  slack_users_profile_set: ['slack', 'slack:profile', 'non_reversible'],
};

export function registerSlackCompensation(): void {
  const { getExecutionScheduler } =
    require('../../atr/scheduler') as typeof import('../../atr/scheduler');
  const scheduler = getExecutionScheduler();
  for (const [toolName, handler] of Object.entries(SLACK_COMPENSATION_HANDLERS)) {
    scheduler.registerCompensation(toolName, handler);
  }
}
