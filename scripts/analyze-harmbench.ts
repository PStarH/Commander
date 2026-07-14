import { createCommanderDefender } from '../packages/core/src/security/commanderDefender';
import { loadHarmBenchCases } from '../packages/core/src/security/benchmarkDatasets/harmBenchLoader';
import { DefaultContentScanner } from '../packages/core/src/contentScanner';
import { harmfulContentRules } from '../packages/core/src/plugins/harmful-content-rules/rules';
import * as fs from 'fs';

async function main() {
  DefaultContentScanner.registerRulePack('harmful-content-rules', harmfulContentRules);
  const defender = createCommanderDefender({ enableHarmfulContentCheck: true });
  const csvPath = 'packages/core/.cache/harmbench/harmbench_behaviors_text_all.csv';
  const cases = await loadHarmBenchCases({ csvPath });

  const byCategory: Record<
    string,
    { total: number; blocked: number; missed: number; examples: string[] }
  > = {};
  const bySemantic: Record<
    string,
    { total: number; blocked: number; missed: number; examples: string[] }
  > = {};

  let blocked = 0;
  let missed = 0;

  for (const tc of cases) {
    const result = await defender(tc);
    const cat = tc.category ?? 'unknown';
    const sem = tc.semanticCategory ?? 'unknown';

    if (!byCategory[cat]) byCategory[cat] = { total: 0, blocked: 0, missed: 0, examples: [] };
    if (!bySemantic[sem]) bySemantic[sem] = { total: 0, blocked: 0, missed: 0, examples: [] };

    byCategory[cat].total++;
    bySemantic[sem].total++;

    if (result.blocked) {
      blocked++;
      byCategory[cat].blocked++;
      bySemantic[sem].blocked++;
    } else {
      missed++;
      byCategory[cat].missed++;
      bySemantic[sem].missed++;
      if (byCategory[cat].examples.length < 3) byCategory[cat].examples.push(tc.prompt);
      if (bySemantic[sem].examples.length < 3) bySemantic[sem].examples.push(tc.prompt);
    }
  }

  console.log(
    `Total: ${cases.length}, Blocked: ${blocked}, Missed: ${missed}, Score: ${Math.round((blocked / cases.length) * 100)}/100\n`,
  );

  console.log('=== By Category ===');
  for (const [cat, stats] of Object.entries(byCategory).sort((a, b) => b[1].missed - a[1].missed)) {
    console.log(`${cat}: total=${stats.total}, blocked=${stats.blocked}, missed=${stats.missed}`);
    for (const ex of stats.examples) console.log(`  - ${ex.slice(0, 120)}...`);
  }

  console.log('\n=== By Semantic Category ===');
  for (const [sem, stats] of Object.entries(bySemantic).sort((a, b) => b[1].missed - a[1].missed)) {
    console.log(`${sem}: total=${stats.total}, blocked=${stats.blocked}, missed=${stats.missed}`);
    for (const ex of stats.examples) console.log(`  - ${ex.slice(0, 120)}...`);
  }

  fs.writeFileSync(
    'scripts/harmbench-analysis.json',
    JSON.stringify({ byCategory, bySemantic, total: cases.length, blocked, missed }, null, 2),
  );
  console.log('\nSaved scripts/harmbench-analysis.json');
}

main().catch(console.error);
