import type { ComparisonResult, MetricKey } from './types';

const metricLabels: Record<MetricKey, string> = {
  successRate: 'Success Rate',
  cost: 'Avg Cost',
  latency: 'Avg Latency',
  llmScore: 'LLM Score',
};

function formatValue(metric: MetricKey, value: number): string {
  if (metric === 'successRate') return `${(value * 100).toFixed(1)}%`;
  if (metric === 'cost') return `$${value.toFixed(4)}`;
  if (metric === 'latency') return `${Math.round(value)}ms`;
  return value.toFixed(2);
}

export function generateMarkdownReport(results: ComparisonResult[]): string {
  const lines: string[] = ['# Algorithmic Effectiveness Report\n'];

  for (const r of results) {
    const title = r.moduleId.charAt(0).toUpperCase() + r.moduleId.slice(1);
    lines.push(`## ${title}`);
    lines.push(`Mode: ${r.mode} | N=${r.n} | Conclusion: **${r.conclusion}**\n`);

    lines.push('| Metric | Baseline | Treatment | Δ | p-value | Effect Size | Conclusion |');
    lines.push('|---|---|---|---|---|---|---|');

    const metrics: MetricKey[] = ['successRate', 'cost', 'latency', 'llmScore'];
    for (const m of metrics) {
      const baseline = r.baseline.mean;
      const treatment = r.treatment.mean;
      const delta = treatment - baseline;
      const p = r.pValues[m];
      const es = r.effectSizes[m];
      let rowConclusion = 'NO_SIGNIFICANT_DIFFERENCE';
      if (p < 0.05) {
        const better = m === 'cost' || m === 'latency' ? delta < 0 : delta > 0;
        rowConclusion = better ? 'SIGNIFICANTLY_BETTER' : 'WORSE_THAN_BASELINE';
      }
      lines.push(
        `| ${metricLabels[m]} | ${formatValue(m, baseline)} | ${formatValue(m, treatment)} | ${delta > 0 ? '+' : ''}${formatValue(m, delta)} | ${p.toFixed(4)} | ${es.toFixed(2)} | ${rowConclusion} |`,
      );
    }

    lines.push(
      `\nErrors: baseline=${r.errors.filter((e) => e.side === 'baseline').length}, treatment=${r.errors.filter((e) => e.side === 'treatment').length}\n`,
    );
  }

  return lines.join('\n');
}

export function generateJsonReport(results: ComparisonResult[]): {
  suite: string;
  mode: string;
  timestamp: string;
  modules: Array<{
    moduleId: string;
    conclusion: string;
    significantMetrics: string[];
    degradedMetrics: string[];
  }>;
} {
  return {
    suite: 'algorithmic-effectiveness',
    mode: results[0]?.mode ?? 'scripted',
    timestamp: new Date().toISOString(),
    modules: results.map((r) => {
      const significantMetrics: string[] = [];
      const degradedMetrics: string[] = [];
      const metrics: MetricKey[] = ['successRate', 'cost', 'latency', 'llmScore'];
      for (const m of metrics) {
        if (r.pValues[m] < 0.05) {
          const baseline = r.baseline.mean;
          const treatment = r.treatment.mean;
          const better =
            m === 'cost' || m === 'latency' ? treatment < baseline : treatment > baseline;
          if (better) significantMetrics.push(m);
          else degradedMetrics.push(m);
        }
      }
      return {
        moduleId: r.moduleId,
        conclusion: r.conclusion,
        significantMetrics,
        degradedMetrics,
      };
    }),
  };
}
