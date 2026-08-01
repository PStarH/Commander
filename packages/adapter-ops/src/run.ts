import {
  assertEgressAllowlistBeforeDaemonStart,
  cellTier,
  parseEgressAllowlist,
} from './egress.js';
import { createAdapterOpsWiring } from './wiring.js';
import { startAdapterOpsHealthServer } from './healthServer.js';
import { startAdapterOpsRuntime } from './lifecycle.js';

let fatalSafeStop: ((reason: string) => Promise<void>) | undefined;

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
  fatalSafeStop = wiring.safeStop;

  const cellTenantId = process.env.COMMANDER_CELL_TENANT_ID?.trim() || '';
  const durableClaimsReady =
    !wiring.requiresDurableClaim ||
    (Boolean(wiring.workers.reconcile.claimSecret) &&
      Boolean(wiring.workers.compensation.claimSecret) &&
      wiring.workers.reconcile.generation > 0 &&
      wiring.workers.compensation.generation > 0);

  const healthPort = positiveInteger('COMMANDER_ADAPTER_OPS_HEALTH_PORT', 8082);
  const runtime = await startAdapterOpsRuntime({
    wiring,
    startHealth: () => startAdapterOpsHealthServer({
      port: healthPort,
      isReady: async () => {
        if (!durableClaimsReady) return false;
        if (tier === 'enterprise' && !cellTenantId) return false;
        if (tier !== 'demo' && egressAllowlist.length === 0) return false;
        if (!wiring.reconciliation.isHealthy() || !wiring.compensation.isHealthy()) {
          return false;
        }
        if (!(await wiring.ping())) return false;
        return (await wiring.operationsReadiness()).ready;
      },
      getLoopHealth: () => ({
        reconciliation: wiring.reconciliation.getHealth(),
        compensation: wiring.compensation.getHealth(),
      }),
    }),
  });

  process.once('SIGINT', () => {
    void runtime.shutdown().catch((error) => {
      console.error(JSON.stringify({ channel: 'adapter-ops-lifecycle', event: 'shutdown_failed', error: error instanceof Error ? error.message : String(error) }));
      process.exitCode = 1;
    });
  });
  process.once('SIGTERM', () => {
    void runtime.shutdown().catch((error) => {
      console.error(JSON.stringify({ channel: 'adapter-ops-lifecycle', event: 'shutdown_failed', error: error instanceof Error ? error.message : String(error) }));
      process.exitCode = 1;
    });
  });
}

void main().catch(async (error: unknown) => {
  console.error('[adapter-ops] fatal:', error);
  try {
    await fatalSafeStop?.('fatal_invariant');
  } catch (safeStopError) {
    console.error(JSON.stringify({
      channel: 'adapter-ops-lifecycle',
      event: 'fatal_safe_stop_failed',
      error: safeStopError instanceof Error ? safeStopError.message : String(safeStopError),
    }));
  }
  process.exitCode = 1;
});
