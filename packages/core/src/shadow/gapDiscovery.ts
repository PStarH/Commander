// packages/core/src/shadow/gapDiscovery.ts
import { IssueAutoCreate, loadGapConfig } from '../plugins/builtin/gap';
import type { DriftEntry } from './types';

export async function reportShadowDrift(anomalies: DriftEntry[][]): Promise<void> {
  if (anomalies.length === 0) return;
  const config = loadGapConfig();
  const creator = new IssueAutoCreate(config);
  for (const samples of anomalies) {
    if (samples.length === 0) continue;
    const endpoint = samples[0].endpoint;
    await creator.create({
      title: `${endpoint} exceeded drift threshold`,
      body: renderDriftReport(endpoint, samples),
      labels: ['shadow', 'gap-discovery'],
    });
  }
}

function renderDriftReport(endpoint: string, samples: DriftEntry[]): string {
  return [
    '## Shadow Traffic Drift Detected',
    '',
    `Endpoint \`${endpoint}\` showed drift for ${samples.length} consecutive samples.`,
    '',
    '| Sample | Status (P/S) | Latency (P/S) |',
    '|--------|--------------|---------------|',
    ...samples
      .slice(-5)
      .map(
        (s) =>
          `| ${s.timestamp} | ${s.prodStatus}/${s.shadowStatus} | ${s.prodLatencyMs}ms/${s.shadowLatencyMs}ms |`,
      ),
  ].join('\n');
}
