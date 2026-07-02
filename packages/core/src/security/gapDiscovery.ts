// packages/core/src/security/gapDiscovery.ts
import { IssueAutoCreate, loadGapConfig } from '../plugins/builtin/gap';
import type { RedTeamTestResult } from './redTeamFramework';

export async function reportNovelMissedAttacks(
  novelMissed: RedTeamTestResult[],
  baselineMissed: Set<string>,
): Promise<void> {
  const filtered = novelMissed.filter((r) => !baselineMissed.has(r.scenario.id));
  if (filtered.length === 0) return;

  const config = loadGapConfig();
  const creator = new IssueAutoCreate(config);
  await creator.create({
    title: `${filtered.length} novel missed red team attacks`,
    body: renderNovelFindings(filtered),
    labels: ['red-team', 'gap-discovery', 'security-regression'],
  });
}

function renderNovelFindings(results: RedTeamTestResult[]): string {
  return [
    '## Novel Missed Red Team Attacks',
    '',
    'These attacks were blocked previously but are now getting through:',
    '',
    ...results.map(
      (r) =>
        `- **${r.scenario.id}** (${r.scenario.severity}, CVSS ${r.scenario.cvssScore}): ${r.scenario.name}`,
    ),
    '',
    'See `docs/security/external-redteam-scope.md` for similar attack patterns.',
  ].join('\n');
}
