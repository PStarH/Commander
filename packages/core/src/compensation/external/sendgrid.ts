/**
 * SendGrid compensation handler — inverse operations for email delivery.
 *
 * Email is physically non-reversible once sent. Compensation strategy:
 *   1. Semantic reversal: send correction/apology email
 *   2. Audit trail: log for manual follow-up
 *   3. Recipient notification: mark original as void
 *
 * Compensation mapping:
 *   send → send correction email + audit log
 *
 * Idempotency: message IDs from SendGrid API for deduplication.
 * Auth: SENDGRID_API_KEY env var.
 */

import type { CompensationHandler } from '../../runtime/compensationRegistry';
import type { CompensableAction } from '../../runtime/compensationRegistry';
import type { CompensationOutcome } from './types';
import { ResilientHttp, nodeFetchHttp, type HttpSendFn } from './httpClient';

export interface SendGridConfig {
  apiKey: string;
  baseUrl?: string;
  send?: HttpSendFn;
  auditLogger?: AuditLogger;
}

export interface AuditLogger {
  log(entry: AuditEntry): Promise<void>;
}

export interface AuditEntry {
  type: 'email_compensation';
  originalMessageId: string;
  correctionMessageId?: string;
  reason: string;
  executionId: string;
  recipient: string;
  originalSubject: string;
  timestamp: string;
}

export interface SendGridArgs {
  to: string;
  subject: string;
  body?: string;
  html?: string;
  from?: string;
  fromName?: string;
  messageId?: string;
}

const SENDGRID_API = 'https://api.sendgrid.com/v3';

export const SENDGRID_TOOL_TAGS: Record<string, string[]> = {
  'sendgrid:send': ['email', 'sendgrid', 'external_api', 'requires_approval'],
  'sendgrid:send_batch': ['email', 'sendgrid', 'external_api', 'destructive', 'requires_approval'],
};

function sendGridHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };
}

function buildCorrectionEmail(args: SendGridArgs, executionId: string): {
  personalizations: Array<{ to: Array<{ email: string }> }>;
  from: { email: string; name?: string };
  subject: string;
  content: Array<{ type: string; value: string }>;
} {
  const from = args.from || 'noreply@example.com';
  const fromName = args.fromName || 'System';

  return {
    personalizations: [{ to: [{ email: args.to }] }],
    from: { email: from, name: fromName },
    subject: `[Correction] ${args.subject}`,
    content: [
      {
        type: 'text/plain',
        value: [
          `The previous email "${args.subject}" sent to you has been marked as void.`,
          '',
          'Reason: Automated workflow detected an error in the preceding steps.',
          `Reference: ${executionId}`,
          '',
          'We apologize for any confusion.',
        ].join('\n'),
      },
      {
        type: 'text/html',
        value: `
          <p>The previous email "<strong>${args.subject}</strong>" sent to you has been marked as void.</p>
          <p>Reason: Automated workflow detected an error in the preceding steps.</p>
          <p>Reference: ${executionId}</p>
          <p>We apologize for any confusion.</p>
        `,
      },
    ],
  };
}

const sendGridSendHandler: CompensationHandler = async (action) => {
  const config = action.args._sendGridConfig as SendGridConfig;
  const args = action.args as unknown as SendGridArgs;
  const ctx = action.args._ctx as { executionId: string } | undefined;
  const executionId = ctx?.executionId ?? 'unknown';

  const http = new ResilientHttp(config.send ?? nodeFetchHttp, { maxAttempts: 3 });

  try {
    const correctionPayload = buildCorrectionEmail(args, executionId);
    const res = await http.send({
      method: 'POST',
      url: `${config.baseUrl ?? SENDGRID_API}/mail/send`,
      headers: sendGridHeaders(config.apiKey),
      body: JSON.stringify(correctionPayload),
    });

    if (res.status >= 200 && res.status < 300) {
      const correctionMessageId = res.headers?.['x-message-id'] ?? undefined;

      if (config.auditLogger) {
        await config.auditLogger.log({
          type: 'email_compensation',
          originalMessageId: args.messageId ?? 'unknown',
          correctionMessageId,
          reason: 'saga_compensation',
          executionId,
          recipient: args.to,
          originalSubject: args.subject,
          timestamp: new Date().toISOString(),
        });
      }

      return { success: true };
    }

    if (res.status === 401 || res.status === 403) {
      return { success: false, error: `SendGrid auth failed: HTTP ${res.status}` };
    }

    return { success: false, error: `SendGrid HTTP ${res.status}: ${res.body.slice(0, 200)}` };
  } catch (err) {
    return { success: false, error: String(err) };
  }
};

const sendGridBatchSendHandler: CompensationHandler = async (action) => {
  const config = action.args._sendGridConfig as SendGridConfig;
  const recipients = action.args.recipients as string[];
  const subject = action.args.subject as string;
  const ctx = action.args._ctx as { executionId: string } | undefined;
  const executionId = ctx?.executionId ?? 'unknown';

  const http = new ResilientHttp(config.send ?? nodeFetchHttp, { maxAttempts: 3 });

  try {
    const personalizations = recipients.map((to) => ({ to: [{ email: to }] }));

    const correctionPayload = {
      personalizations,
      from: { email: config.apiKey ? 'noreply@example.com' : 'system@example.com' },
      subject: `[Correction] ${subject}`,
      content: [
        {
          type: 'text/plain',
          value: `The batch email "${subject}" has been voided due to a workflow error. Reference: ${executionId}`,
        },
      ],
    };

    const res = await http.send({
      method: 'POST',
      url: `${config.baseUrl ?? SENDGRID_API}/mail/send`,
      headers: sendGridHeaders(config.apiKey),
      body: JSON.stringify(correctionPayload),
    });

    if (res.status >= 200 && res.status < 300) {
      if (config.auditLogger) {
        await config.auditLogger.log({
          type: 'email_compensation',
          originalMessageId: 'batch',
          reason: 'saga_compensation_batch',
          executionId,
          recipient: recipients.join(','),
          originalSubject: subject,
          timestamp: new Date().toISOString(),
        });
      }
      return { success: true };
    }

    return { success: false, error: `SendGrid batch HTTP ${res.status}: ${res.body.slice(0, 200)}` };
  } catch (err) {
    return { success: false, error: String(err) };
  }
};

const SENDGRID_COMPENSATION_HANDLERS: Record<string, CompensationHandler> = {
  'sendgrid:send': sendGridSendHandler,
  'sendgrid:send_batch': sendGridBatchSendHandler,
};

export function registerSendGridCompensation(
  registry: { register: (toolName: string, handler: CompensationHandler) => void },
): void {
  for (const [toolName, handler] of Object.entries(SENDGRID_COMPENSATION_HANDLERS)) {
    registry.register(toolName, handler);
  }
}

export function getSendGridCompensationHandlers(): Record<string, CompensationHandler> {
  return { ...SENDGRID_COMPENSATION_HANDLERS };
}
