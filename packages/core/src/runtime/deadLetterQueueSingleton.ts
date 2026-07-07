/**
 * DeadLetterQueue singleton accessor. Other modules (e.g. SubAgentExecutor)
 * that don't have a runtime-injected DLQ can use this to obtain a process-wide
 * one. Backed by createTenantAwareSingleton for parity with IntentLog, etc.
 */
import { createTenantAwareSingleton } from './tenantAwareSingleton';
import { DeadLetterQueue } from './deadLetterQueue';

const dlqSingleton = createTenantAwareSingleton(() => new DeadLetterQueue(), {
  allowGlobalFallback: true,
});

export function getDeadLetterQueue(tenantId?: string): DeadLetterQueue {
  if (tenantId) return dlqSingleton.getForTenant(tenantId);
  return dlqSingleton.get();
}

export function resetDeadLetterQueue(): void {
  dlqSingleton.reset();
}
