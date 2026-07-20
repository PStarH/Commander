import { createOperationsWiring } from './wiring.js';
import { startAdapterOpsHealthServer } from './healthServer.js';

function positiveInteger(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function parseEgressAllowlist(): string[] {
  const raw = process.env.COMMANDER_ADAPTER_EGRESS_ALLOWLIST?.trim() ?? '';
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export async function main(): Promise<void> {
  const wiring = await createOperationsWiring();
  wiring.reconciliation.start();
  wiring.compensation.start();

  const tier = process.env.COMMANDER_CELL_TIER?.trim() || 'demo';
  const egressAllowlist = parseEgressAllowlist();
  const cellTenantId = process.env.COMMANDER_CELL_TENANT_ID?.trim() || '';

  const healthPort = positiveInteger('COMMANDER_ADAPTER_OPS_HEALTH_PORT', 8082);
  const health = await startAdapterOpsHealthServer({
    port: healthPort,
    isReady: async () => {
      if (tier === 'enterprise' && !cellTenantId) return false;
      if (tier !== 'demo' && egressAllowlist.length === 0) return false;
      return true;
    },
  });

  let stopping = false;
  const shutdown = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    await wiring.reconciliation.stop();
    await wiring.compensation.stop();
    await health.close();
    await wiring.close();
  };

  process.once('SIGINT', () => {
    void shutdown();
  });
  process.once('SIGTERM', () => {
    void shutdown();
  });
}

void main().catch((error: unknown) => {
  console.error('[adapter-ops] fatal:', error);
  process.exitCode = 1;
});
