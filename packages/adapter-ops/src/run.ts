import {
  assertEgressAllowlistBeforeDaemonStart,
  cellTier,
  parseEgressAllowlist,
} from './egress.js';
import { createAdapterOpsWiring } from './wiring.js';
import { startAdapterOpsHealthServer } from './healthServer.js';

function positiveInteger(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(name + ' must be a positive integer');
  }
  return value;
}

export async function main(): Promise<void> {
  const tier = cellTier();
  const egressAllowlist = parseEgressAllowlist();
  // Fail-closed：非 demo 未配置 allowlist 时禁止启动 outbound daemon（不能只挡 readiness）
  assertEgressAllowlistBeforeDaemonStart(tier, egressAllowlist);

  const wiring = await createAdapterOpsWiring();
  wiring.reconciliation.start();
  wiring.compensation.start();

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
