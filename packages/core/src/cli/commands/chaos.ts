// packages/core/src/cli/commands/chaos.ts
import { ChaosOrchestrator, parseLayers, type ChaosScenario } from '../../chaos';
import { RecoveryBootstrapper } from '../../atr/recoveryBootstrapper';

export async function runChaosCli(args: string[]): Promise<void> {
  const layersIdx = args.indexOf('--layers');
  const tenantIdx = args.indexOf('--tenant');
  const durationIdx = args.indexOf('--duration');

  if (layersIdx < 0) {
    console.error('Usage: commander chaos:run --layers=L1,L2 --tenant=X --duration=60');
    process.exit(1);
  }

  const scenario: ChaosScenario = {
    layers: parseLayers(args[layersIdx + 1]),
    tenantId: tenantIdx > 0 ? args[tenantIdx + 1] : undefined,
    durationSec: durationIdx > 0 ? parseInt(args[durationIdx + 1], 10) : 60,
  };

  const orch = new ChaosOrchestrator({
    bootstrap: async () => {
      await RecoveryBootstrapper.bootstrap({});
    },
    delayMs: 1000,
  });

  console.log(
    `Running chaos on layers ${scenario.layers.join(',')} for tenant ${scenario.tenantId ?? 'none'}`,
  );
  const results = await orch.run(scenario);

  console.log(`Completed ${results.length} chaos scenarios`);
  for (const r of results) {
    console.log(
      `  ${r.layer}: ${r.faultType} — recovery ${r.recovery.recoverySucceeded ? 'OK' : 'FAILED'}`,
    );
  }
}
