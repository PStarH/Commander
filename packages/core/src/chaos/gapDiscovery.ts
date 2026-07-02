// packages/core/src/chaos/gapDiscovery.ts
import { IssueAutoCreate, loadGapConfig } from '../plugins/builtin/gap';

export interface UncoveredFault {
  layer: string;
  faultType: string;
  description: string;
}

export async function reportChaosGap(uncoveredFaults: UncoveredFault[]): Promise<void> {
  if (uncoveredFaults.length === 0) return;
  const config = loadGapConfig();
  const creator = new IssueAutoCreate(config);
  await creator.create({
    title: `${uncoveredFaults.length} fault types uncovered`,
    body: renderGapReport(uncoveredFaults),
    labels: ['chaos', 'gap-discovery'],
  });
}

function renderGapReport(faults: UncoveredFault[]): string {
  return [
    '## Chaos Gap Discovery',
    '',
    'The following fault types were detected as uncovered during chaos run:',
    '',
    ...faults.map((f) => `- **${f.layer}**: ${f.faultType} — ${f.description}`),
    '',
    'See `docs/runbooks/chaos.md` for how to add scenarios.',
  ].join('\n');
}
