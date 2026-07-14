/**
 * Audit Aggregator Bridge — forwards MessageBus security events to UnifiedAuditLog (M6).
 */

import { getMessageBus } from '../runtime/messageBus';
import type { BusMessage } from '../runtime/types/messageBus';
import { getUnifiedAuditLog } from './unifiedAuditLog';
import type { UnifiedAuditSeverity } from './unifiedAuditLog';

let unsubscribe: (() => void) | null = null;

function mapSeverity(sev: unknown): UnifiedAuditSeverity {
  switch (String(sev ?? 'info').toLowerCase()) {
    case 'critical':
      return 'critical';
    case 'high':
    case 'error':
      return 'error';
    case 'medium':
    case 'warn':
    case 'warning':
      return 'warn';
    default:
      return 'info';
  }
}

function securityPayloadToEntry(payload: Record<string, unknown>, source: string) {
  const details = (payload.details as Record<string, unknown> | undefined) ?? {};
  return {
    category: 'security' as const,
    eventType: String(payload.type ?? payload.event ?? 'security.event'),
    severity: mapSeverity(payload.severity),
    tenantId: (payload.tenantId as string | undefined) ?? (details.tenantId as string | undefined),
    runId: (details.runId as string | undefined) ?? (payload.runId as string | undefined),
    agentId: (details.agentId as string | undefined) ?? (payload.agentId as string | undefined),
    toolName: details.toolName as string | undefined,
    message: String(payload.message ?? payload.type ?? 'security event'),
    details,
    source,
  };
}

/**
 * Subscribe to security.event and security.alert topics; append to UnifiedAuditLog.
 */
export function startAuditAggregatorBridge(): void {
  if (unsubscribe) return;
  const bus = getMessageBus();
  const audit = getUnifiedAuditLog();

  const handler = (msg: BusMessage) => {
    const payload = msg.payload as Record<string, unknown>;
    if (!payload || typeof payload !== 'object') return;
    void audit.log(securityPayloadToEntry(payload, msg.source ?? 'MessageBus')).catch(() => {
      /* log() is best-effort */
    });
  };

  const unsubEvent = bus.subscribe('security.event', handler);
  const unsubAlert = bus.subscribe('security.alert', handler);
  unsubscribe = () => {
    unsubEvent();
    unsubAlert();
    unsubscribe = null;
  };
}

export function stopAuditAggregatorBridge(): void {
  unsubscribe?.();
}
