// packages/core/src/cli/commands/shadow.ts
import { startShadowRunner, loadShadowConfig } from '../../shadow';
import { DriftReporter } from '../../shadow/driftReporter';
import * as path from 'node:path';

export async function runShadowCli(args: string[]): Promise<void> {
  const subcommand = args[0];

  if (subcommand === 'runner') {
    const port = parseInt(getArg(args, '--port') ?? '9999', 10);
    startShadowRunner({ port, shadowMode: true });
    return;
  }

  if (subcommand === 'drift') {
    const cfg = loadShadowConfig();
    void cfg;
    const reporter = new DriftReporter(
      path.join(process.cwd(), '.commander/shadow-drift/drift.ndjson'),
    );
    const anomalies = reporter.detectAnomalies();
    console.log(`Drift report: ${anomalies.length} endpoints with consecutive drift`);
    for (const samples of anomalies) {
      console.log(`  - ${samples[0].endpoint}: ${samples.length} samples`);
    }
    return;
  }

  console.error('Usage: commander shadow:runner | shadow:drift');
  process.exit(1);
}

function getArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx > 0 ? args[idx + 1] : undefined;
}
