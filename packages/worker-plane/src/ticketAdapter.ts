/**
 * L3-08a demo reversible write adapter — in-memory ticket store.
 * Implements queryOutcome for UNKNOWN reconcile without re-executing writes.
 */
import type { EffectOutcomeQuerier, EffectRemoteOutcome } from '@commander/effect-broker';

export interface TicketRecord {
  ticketId: string;
  title: string;
  tenantId: string;
  idempotencyKey: string;
  status: 'open' | 'closed' | 'failed';
}

/**
 * Fake CRM/ticket system: create is idempotent by idempotencyKey;
 * queryOutcome never mutates.
 */
export class InMemoryTicketAdapter implements EffectOutcomeQuerier {
  private readonly byIdempotency = new Map<string, TicketRecord>();
  private seq = 0;
  /** Counts create() invocations — reconcile must not increment this. */
  createInvocations = 0;

  private key(tenantId: string, idempotencyKey: string): string {
    return `${tenantId}:${idempotencyKey}`;
  }

  /** External write — the side effect under reconcile. */
  async create(input: {
    tenantId: string;
    idempotencyKey: string;
    title: string;
  }): Promise<TicketRecord> {
    this.createInvocations += 1;
    const k = this.key(input.tenantId, input.idempotencyKey);
    const existing = this.byIdempotency.get(k);
    if (existing) return { ...existing };
    this.seq += 1;
    const record: TicketRecord = {
      ticketId: `T-${this.seq}`,
      title: input.title,
      tenantId: input.tenantId,
      idempotencyKey: input.idempotencyKey,
      status: 'open',
    };
    this.byIdempotency.set(k, record);
    return { ...record };
  }

  async queryOutcome(input: {
    effectId: string;
    idempotencyKey: string;
    type: string;
    request: Record<string, unknown>;
    tenantId: string;
  }): Promise<EffectRemoteOutcome> {
    const hit = this.byIdempotency.get(this.key(input.tenantId, input.idempotencyKey));
    if (!hit) return { status: 'UNKNOWN' };
    if (hit.status === 'failed') {
      return { status: 'FAILED', response: { ticketId: hit.ticketId, title: hit.title, status: hit.status } };
    }
    return { status: 'COMPLETED', response: { ticketId: hit.ticketId, title: hit.title, status: hit.status } };
  }
}
