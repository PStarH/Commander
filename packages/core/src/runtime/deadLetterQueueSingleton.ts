/**
 * DeadLetterQueue singleton accessor. Other modules (e.g. SubAgentExecutor)
 * that don't have a runtime-injected DLQ can use this to obtain a process-wide
 * one. Backed by createTenantAwareSingleton for parity with IntentLog, etc.
 *
 * Tenant isolation: `createTenantAwareSingleton` caches instances per tenant,
 * but a zero-argument factory cannot tell which tenant is being constructed.
 * The accessor therefore resolves the tenant first and hands it to the factory
 * through `constructingTenantId`, so every real tenant gets its own on-disk
 * directory (`.commander_dlq/tenant_<id>`) instead of sharing `.commander_dlq`.
 * The implicit `__default__` bucket keeps the legacy single-tenant directory.
 */
import * as path from 'node:path';
import { createTenantAwareSingleton } from './tenantAwareSingleton';
import { DeadLetterQueue } from './deadLetterQueue';
import { tenantBucketOrThrow, tenantPathSegment } from './tenantContext';

let constructingTenantId: string | undefined;

function resolveBaseDir(tenantId: string | undefined): string | undefined {
  if (!tenantId || tenantId === '__default__') return undefined;
  return path.join(process.cwd(), '.commander_dlq', tenantPathSegment(tenantId));
}

const dlqSingleton = createTenantAwareSingleton(
  () => new DeadLetterQueue(resolveBaseDir(constructingTenantId)),
  {},
);

export function getDeadLetterQueue(tenantId?: string): DeadLetterQueue {
  const resolvedTenantId = tenantId || tenantBucketOrThrow();
  constructingTenantId = resolvedTenantId;
  try {
    return dlqSingleton.getForTenant(resolvedTenantId);
  } finally {
    constructingTenantId = undefined;
  }
}

export function resetDeadLetterQueue(): void {
  dlqSingleton.reset();
}
