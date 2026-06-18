/**
 * Stripe compensation handler.
 *
 * Stripe's API is the gold standard for idempotency. Every mutating
 * endpoint accepts an `Idempotency-Key` header; we use that for both
 * forward and inverse operations so retries are safe. The pattern
 * is described in:
 *
 *   - https://stripe.com/blog/idempotency
 *   - https://docs.stripe.com/api/idempotent_requests
 *
 * Inverse operation mapping:
 *   - charge.create    → refund.create (or refund.cancel if pending)
 *   - payment_intent.create
 *     → payment_intent.cancel (or refund after capture)
 *   - invoice.pay       → refund on the underlying charge
 *   - subscription.create
 *     → subscription.cancel
 *   - customer.create
 *     → customer.delete
 *   - transfer.create   → transfer.reversal
 *   - payout.create     → non-reversible; flagged for manual review
 *
 * Refund vs cancel semantic:
 *   - Refund is appropriate for settled charges. Idempotent: a duplicate
 *     refund on the same charge returns the same refund object.
 *   - Cancel is appropriate for uncaptured payment intents. Idempotent
 *     on the second call (returns "already canceled").
 *   - For captured payment intents, refund is the only option.
 *
 * The handler is implemented as a single async function dispatched by
 * tool name. It accepts a `ResilientHttp` (defaults to nodeFetchHttp)
 * and a config block for credentials.
 */

import { createHash } from 'node:crypto';
import type { CompensableAction } from '../../runtime/compensationRegistry';
import type { CompensationHandler } from '../../runtime/compensationRegistry';
import {
  ResilientHttp,
  nodeFetchHttp,
  buildCompensationIdempotencyKey,
  type HttpSendFn,
  type HttpResponse,
} from './httpClient';
import type { CompensationOutcome } from './types';

export interface StripeConfig {
  apiKey: string;
  baseUrl?: string;
  send?: HttpSendFn;
}

const STRIPE_API = 'https://api.stripe.com/v1';

interface StripeArgs {
  chargeId?: string;
  paymentIntentId?: string;
  invoiceId?: string;
  subscriptionId?: string;
  customerId?: string;
  transferId?: string;
  payoutId?: string;
  amount?: number; // cents
  reason?: string;
}

function stripeAuthHeader(config: StripeConfig): Record<string, string> {
  return {
    Authorization: `Bearer ${config.apiKey}`,
    'Content-Type': 'application/x-www-form-urlencoded',
  };
}

function formEncode(params: Record<string, unknown>): string {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) {
      v.forEach((item, i) => usp.append(`${k}[${i}]`, String(item)));
    } else if (typeof v === 'object') {
      for (const [k2, v2] of Object.entries(v as Record<string, unknown>)) {
        usp.append(`${k}[${k2}]`, String(v2));
      }
    } else {
      usp.append(k, String(v));
    }
  }
  return usp.toString();
}

function classifyStripeError(res: HttpResponse): {
  recoverable: boolean;
  alreadyCompensated: boolean;
  msg: string;
} {
  let msg = `Stripe HTTP ${res.status}: ${res.body.slice(0, 200)}`;
  try {
    const parsed = JSON.parse(res.body) as { error?: { code?: string; message?: string } };
    if (parsed.error) {
      msg = parsed.error.message ?? msg;
      if (parsed.error.code === 'idempotency_error' || res.status === 409) {
        return { recoverable: false, alreadyCompensated: true, msg };
      }
      if (parsed.error.code === 'resource_missing' || res.status === 404) {
        return { recoverable: false, alreadyCompensated: true, msg };
      }
      if (res.status >= 400 && res.status < 500) {
        return { recoverable: false, alreadyCompensated: false, msg };
      }
    }
  } catch {
    // Non-JSON body
  }
  return { recoverable: res.status >= 500 || res.status === 429, alreadyCompensated: false, msg };
}

async function refundCharge(
  config: StripeConfig,
  chargeId: string,
  idempotencyKey: string,
  amount?: number,
): Promise<{ outcome: CompensationOutcome; res: HttpResponse }> {
  const http = new ResilientHttp(config.send ?? nodeFetchHttp, { maxAttempts: 4 });
  const body = formEncode({
    charge: chargeId,
    ...(amount !== undefined ? { amount } : {}),
  });
  const res = await http.send({
    method: 'POST',
    url: `${config.baseUrl ?? STRIPE_API}/refunds`,
    headers: stripeAuthHeader(config),
    body,
    idempotencyKey,
  });
  const cls = classifyStripeError(res);
  if (cls.alreadyCompensated) {
    return { res, outcome: { success: true, alreadyCompensated: true } };
  }
  if (cls.recoverable) {
    return { res, outcome: { success: false, error: cls.msg } };
  }
  if (res.status >= 400) {
    return { res, outcome: { success: false, permanent: true, error: cls.msg } };
  }
  return { res, outcome: { success: true } };
}

async function cancelPaymentIntent(
  config: StripeConfig,
  paymentIntentId: string,
  idempotencyKey: string,
): Promise<{ outcome: CompensationOutcome; res: HttpResponse }> {
  const http = new ResilientHttp(config.send ?? nodeFetchHttp, { maxAttempts: 4 });
  const res = await http.send({
    method: 'POST',
    url: `${config.baseUrl ?? STRIPE_API}/payment_intents/${encodeURIComponent(paymentIntentId)}/cancel`,
    headers: stripeAuthHeader(config),
    body: formEncode({ cancellation_reason: 'requested_by_customer' }),
    idempotencyKey,
  });
  const cls = classifyStripeError(res);
  if (cls.alreadyCompensated) {
    return { res, outcome: { success: true, alreadyCompensated: true } };
  }
  if (cls.recoverable) {
    return { res, outcome: { success: false, error: cls.msg } };
  }
  if (res.status >= 400) {
    return { res, outcome: { success: false, permanent: true, error: cls.msg } };
  }
  return { res, outcome: { success: true } };
}

async function cancelSubscription(
  config: StripeConfig,
  subscriptionId: string,
  idempotencyKey: string,
): Promise<{ outcome: CompensationOutcome; res: HttpResponse }> {
  const http = new ResilientHttp(config.send ?? nodeFetchHttp, { maxAttempts: 4 });
  const res = await http.send({
    method: 'DELETE',
    url: `${config.baseUrl ?? STRIPE_API}/subscriptions/${encodeURIComponent(subscriptionId)}`,
    headers: stripeAuthHeader(config),
    idempotencyKey,
  });
  const cls = classifyStripeError(res);
  if (cls.alreadyCompensated) {
    return { res, outcome: { success: true, alreadyCompensated: true } };
  }
  if (cls.recoverable) {
    return { res, outcome: { success: false, error: cls.msg } };
  }
  if (res.status >= 400) {
    return { res, outcome: { success: false, permanent: true, error: cls.msg } };
  }
  return { res, outcome: { success: true } };
}

async function deleteCustomer(
  config: StripeConfig,
  customerId: string,
  idempotencyKey: string,
): Promise<{ outcome: CompensationOutcome; res: HttpResponse }> {
  const http = new ResilientHttp(config.send ?? nodeFetchHttp, { maxAttempts: 4 });
  const res = await http.send({
    method: 'DELETE',
    url: `${config.baseUrl ?? STRIPE_API}/customers/${encodeURIComponent(customerId)}`,
    headers: stripeAuthHeader(config),
    idempotencyKey,
  });
  const cls = classifyStripeError(res);
  if (cls.alreadyCompensated) {
    return { res, outcome: { success: true, alreadyCompensated: true } };
  }
  if (cls.recoverable) {
    return { res, outcome: { success: false, error: cls.msg } };
  }
  if (res.status >= 400) {
    return { res, outcome: { success: false, permanent: true, error: cls.msg } };
  }
  return { res, outcome: { success: true } };
}

async function reverseTransfer(
  config: StripeConfig,
  transferId: string,
  idempotencyKey: string,
  amount?: number,
): Promise<{ outcome: CompensationOutcome; res: HttpResponse }> {
  const http = new ResilientHttp(config.send ?? nodeFetchHttp, { maxAttempts: 4 });
  const body = formEncode({
    transfer: transferId,
    ...(amount !== undefined ? { amount } : {}),
    metadata: { reversal_source: 'commander_compensation' },
  });
  const res = await http.send({
    method: 'POST',
    url: `${config.baseUrl ?? STRIPE_API}/transfers/${encodeURIComponent(transferId)}/reversals`,
    headers: stripeAuthHeader(config),
    body,
    idempotencyKey,
  });
  const cls = classifyStripeError(res);
  if (cls.alreadyCompensated) {
    return { res, outcome: { success: true, alreadyCompensated: true } };
  }
  if (cls.recoverable) {
    return { res, outcome: { success: false, error: cls.msg } };
  }
  if (res.status >= 400) {
    return { res, outcome: { success: false, permanent: true, error: cls.msg } };
  }
  return { res, outcome: { success: true } };
}

let _config: StripeConfig | null = null;
export function configureStripe(config: StripeConfig): void {
  _config = config;
}

function ensureConfig(): StripeConfig {
  if (_config) return _config;
  const apiKey = process.env.STRIPE_API_KEY;
  if (!apiKey) {
    throw new Error(
      'Stripe compensation: no config — call configureStripe() or set STRIPE_API_KEY',
    );
  }
  return { apiKey };
}

const stripeChargeHandler: CompensationHandler = async (action) => {
  const cfg = ensureConfig();
  const { chargeId } = (action.args ?? {}) as StripeArgs;
  if (!chargeId) return { success: false, permanent: true, error: 'chargeId missing' };
  const idemKey = buildCompensationIdempotencyKey({
    runId: action.runId ?? 'unknown',
    actionId: action.actionId,
    system: 'stripe',
    inverse: 'refund',
  });
  return (await refundCharge(cfg, chargeId, idemKey)).outcome;
};

const stripePaymentIntentHandler: CompensationHandler = async (action) => {
  const cfg = ensureConfig();
  const { paymentIntentId } = (action.args ?? {}) as StripeArgs;
  if (!paymentIntentId) {
    return { success: false, permanent: true, error: 'paymentIntentId missing' };
  }
  const idemKey = buildCompensationIdempotencyKey({
    runId: action.runId ?? 'unknown',
    actionId: action.actionId,
    system: 'stripe',
    inverse: 'payment_intent.cancel',
  });
  return (await cancelPaymentIntent(cfg, paymentIntentId, idemKey)).outcome;
};

const stripeSubscriptionHandler: CompensationHandler = async (action) => {
  const cfg = ensureConfig();
  const { subscriptionId } = (action.args ?? {}) as StripeArgs;
  if (!subscriptionId) {
    return { success: false, permanent: true, error: 'subscriptionId missing' };
  }
  const idemKey = buildCompensationIdempotencyKey({
    runId: action.runId ?? 'unknown',
    actionId: action.actionId,
    system: 'stripe',
    inverse: 'subscription.cancel',
  });
  return (await cancelSubscription(cfg, subscriptionId, idemKey)).outcome;
};

const stripeCustomerHandler: CompensationHandler = async (action) => {
  const cfg = ensureConfig();
  const { customerId } = (action.args ?? {}) as StripeArgs;
  if (!customerId) return { success: false, permanent: true, error: 'customerId missing' };
  const idemKey = buildCompensationIdempotencyKey({
    runId: action.runId ?? 'unknown',
    actionId: action.actionId,
    system: 'stripe',
    inverse: 'customer.delete',
  });
  return (await deleteCustomer(cfg, customerId, idemKey)).outcome;
};

const stripeTransferHandler: CompensationHandler = async (action) => {
  const cfg = ensureConfig();
  const { transferId, amount } = (action.args ?? {}) as StripeArgs;
  if (!transferId) return { success: false, permanent: true, error: 'transferId missing' };
  const idemKey = buildCompensationIdempotencyKey({
    runId: action.runId ?? 'unknown',
    actionId: action.actionId,
    system: 'stripe',
    inverse: 'transfer.reversal',
  });
  return (await reverseTransfer(cfg, transferId, idemKey, amount)).outcome;
};

const stripeInvoicePayHandler: CompensationHandler = async (action) => {
  const cfg = ensureConfig();
  const args = (action.args ?? {}) as StripeArgs & { chargeId?: string };
  if (!args.chargeId) {
    return {
      success: false,
      permanent: true,
      error: 'invoice.pay compensation requires chargeId in args',
    };
  }
  const idemKey = buildCompensationIdempotencyKey({
    runId: action.runId ?? 'unknown',
    actionId: action.actionId,
    system: 'stripe',
    inverse: 'refund',
  });
  return (await refundCharge(cfg, args.chargeId, idemKey)).outcome;
};

const stripePayoutHandler: CompensationHandler = async (action) => {
  return {
    success: false,
    permanent: true,
    error:
      'Stripe payout is not reversible via API; manual intervention required. Action ID: ' +
      action.actionId,
  };
};

export const STRIPE_COMPENSATION_HANDLERS: Record<string, CompensationHandler> = {
  stripe_charge_create: stripeChargeHandler,
  stripe_payment_intent_create: stripePaymentIntentHandler,
  stripe_subscription_create: stripeSubscriptionHandler,
  stripe_customer_create: stripeCustomerHandler,
  stripe_transfer_create: stripeTransferHandler,
  stripe_invoice_pay: stripeInvoicePayHandler,
  stripe_payout_create: stripePayoutHandler,
  stripe_charge: stripeChargeHandler,
  stripe_payment_intent: stripePaymentIntentHandler,
  stripe_subscription: stripeSubscriptionHandler,
  stripe_customer: stripeCustomerHandler,
  stripe_transfer: stripeTransferHandler,
  stripe_invoice: stripeInvoicePayHandler,
  stripe_payout: stripePayoutHandler,
};

export const STRIPE_TOOL_TAGS: Record<string, string[]> = {
  stripe_charge_create: ['stripe', 'stripe:charge', 'destructive', 'requires_approval'],
  stripe_payment_intent_create: [
    'stripe',
    'stripe:payment_intent',
    'destructive',
    'requires_approval',
  ],
  stripe_subscription_create: ['stripe', 'stripe:subscription', 'destructive'],
  stripe_customer_create: ['stripe', 'stripe:customer', 'destructive'],
  stripe_transfer_create: ['stripe', 'stripe:transfer', 'destructive', 'requires_approval'],
  stripe_invoice_pay: ['stripe', 'stripe:invoice', 'destructive', 'requires_approval'],
  stripe_payout_create: ['stripe', 'stripe:payout', 'destructive', 'non_reversible'],
};

export const STRIPE_TOOL_COST_USD: Record<string, number> = {
  stripe_charge_create: 0.3,
  stripe_payment_intent_create: 0.3,
  stripe_subscription_create: 0,
  stripe_customer_create: 0,
  stripe_transfer_create: 0.25,
  stripe_invoice_pay: 0.3,
  stripe_payout_create: 0,
};

export function registerStripeCompensation(): void {
  const { getExecutionScheduler } =
    require('../../atr/scheduler') as typeof import('../../atr/scheduler');
  const scheduler = getExecutionScheduler();
  for (const [toolName, handler] of Object.entries(STRIPE_COMPENSATION_HANDLERS)) {
    scheduler.registerCompensation(toolName, handler);
  }
}

export function stripeIdempotencyKey(action: CompensableAction): string {
  const h = createHash('sha256');
  h.update(`${action.runId ?? 'unknown'}|${action.actionId}|${action.toolName}`);
  return `idem_${h.digest('hex').slice(0, 32)}`;
}
