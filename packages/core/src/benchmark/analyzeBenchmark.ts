import * as fs from 'fs';
import * as path from 'path';
import type { BenchmarkSummary } from './multiAgentBenchmark';

const RESULTS_DIR = path.join(process.cwd(), 'benchmarks', 'multi-agent-ab');

function findLatestResult(): string | null {
  if (!fs.existsSync(RESULTS_DIR)) return null;
  const files = fs.readdirSync(RESULTS_DIR)
    .filter(f => f.startsWith('results-') && f.endsWith('.json'))
    .sort()
    .reverse();
  return files.length > 0 ? path.join(RESULTS_DIR, files[0]) : null;
}

function formatReport(summary: BenchmarkSummary): string {
  const lines: string[] = [];

  lines.push('# Multi-Agent vs Single-Agent Benchmark Report');
  lines.push(`> Generated: ${summary.timestamp}`);
  lines.push('');

  lines.push('## Executive Summary');
  lines.push('');
  const winner = summary.overall.multiWins > summary.overall.singleWins ? 'Multi-agent'
    : summary.overall.singleWins > summary.overall.multiWins ? 'Single-agent'
    : 'Tie';
  lines.push(`**Winner: ${winner}** (${summary.overall.multiWins}W / ${summary.overall.singleWins}L / ${summary.overall.ties}T)`);
  lines.push('');
  lines.push(`- Quality improvement: ${(summary.overall.avgQualityImprovement * 100).toFixed(1)}pp`);
  lines.push(`- Cost overhead: ${(summary.overall.avgCostOverhead * 100).toFixed(1)}%`);
  lines.push(`- Latency improvement: ${(summary.overall.avgLatencyImprovement * 100).toFixed(1)}%`);
  lines.push(`- Statistical significance: p=${summary.overall.statisticalSignificance.toFixed(4)} ${summary.overall.statisticalSignificance < 0.05 ? '✅' : '❌'}`);
  lines.push('');

  lines.push('## Per-Tier Breakdown');
  lines.push('');
  lines.push('| Tier | Tasks | Multi Wins | Single Wins | Ties | Quality Δ | Latency Δ | Cost Δ |');
  lines.push('|------|-------|------------|-------------|------|-----------|-----------|--------|');
  for (const tier of ['simple', 'moderate', 'complex'] as const) {
    const t = summary.byTier[tier];
    if (!t || t.total === 0) continue;
    lines.push(`| ${tier} | ${t.total} | ${t.multiWins} | ${t.singleWins} | ${t.ties} | ${(t.avgQualityDelta * 100).toFixed(1)}pp | ${t.avgLatencyDelta.toFixed(0)}ms | ${(t.avgCostDelta * 100).toFixed(1)}% |`);
  }
  lines.push('');

  lines.push('## Key Findings');
  lines.push('');
  for (const r of summary.recommendations) {
    lines.push(`- ${r}`);
  }
  lines.push('');

  lines.push('## Methodology');
  lines.push('');
  lines.push('- **Single-agent**: Orchestrator forced to SINGLE topology');
  lines.push('- **Multi-agent**: Orchestrator auto-selects topology (PARALLEL, SEQUENTIAL, HIERARCHICAL, etc.)');
  lines.push('- **Winner criteria**: Quality >5% improvement wins; else latency >10% improvement wins');
  lines.push('- **Statistical test**: Paired t-test on quality deltas');
  lines.push(`- **Total comparisons**: ${summary.completedTasks}`);
  lines.push('');

  lines.push('## Raw Data');
  lines.push('');
  lines.push(`Results JSON: \`benchmarks/multi-agent-ab/results-${Date.now()}.json\``);
  lines.push('');

  return lines.join('\n');
}

export function analyzeLatestBenchmark(): string | null {
  const latest = findLatestResult();
  if (!latest) {
    return null;
  }

  const raw = fs.readFileSync(latest, 'utf-8');
  const summary: BenchmarkSummary = JSON.parse(raw);
  return formatReport(summary);
}

if (require.main === module) {
  const report = analyzeLatestBenchmark();
  if (report) {
    console.log(report);
    const outPath = path.join(RESULTS_DIR, 'latest-report.md');
    fs.writeFileSync(outPath, report);
    console.log(`\nReport saved to: ${outPath}`);
  } else {
    console.log('No benchmark results found. Run: commander multi-benchmark');
  }
}
