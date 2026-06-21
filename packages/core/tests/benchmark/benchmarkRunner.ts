import * as fs from 'fs';
import * as path from 'path';

export interface BenchmarkResult {
  name: string;
  category: 'performance' | 'load' | 'cost' | 'reliability' | 'comparison';
  metrics: Record<string, number | string | boolean>;
  timestamp: string;
  durationMs: number;
  passed: boolean;
  threshold?: number;
  actual?: number;
}

export interface BenchmarkReport {
  version: string;
  timestamp: string;
  totalDurationMs: number;
  results: BenchmarkResult[];
  summary: {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
  };
  categories: Record<string, {
    total: number;
    passed: number;
    failed: number;
  }>;
}

export class BenchmarkRunner {
  private results: BenchmarkResult[] = [];
  private startTime: number = 0;

  start(): void {
    this.startTime = performance.now();
    console.log('\n🚀 Commander Benchmark Suite');
    console.log('='.repeat(60));
    console.log(`Started at: ${new Date().toISOString()}`);
    console.log('');
  }

  addResult(result: BenchmarkResult): void {
    this.results.push(result);
    const status = result.passed ? '✅' : '❌';
    console.log(`${status} ${result.category}/${result.name}`);
    for (const [key, value] of Object.entries(result.metrics)) {
      console.log(`   ${key}: ${value}`);
    }
    console.log('');
  }

  finish(): BenchmarkReport {
    const totalDurationMs = performance.now() - this.startTime;
    const passed = this.results.filter(r => r.passed).length;
    const failed = this.results.filter(r => !r.passed).length;
    const skipped = this.results.filter(r => r.metrics['skipped'] === true).length;

    const categories: Record<string, { total: number; passed: number; failed: number }> = {};
    for (const result of this.results) {
      if (!categories[result.category]) {
        categories[result.category] = { total: 0, passed: 0, failed: 0 };
      }
      categories[result.category].total++;
      if (result.passed) categories[result.category].passed++;
      else categories[result.category].failed++;
    }

    const report: BenchmarkReport = {
      version: '1.0.0',
      timestamp: new Date().toISOString(),
      totalDurationMs,
      results: this.results,
      summary: {
        total: this.results.length,
        passed,
        failed,
        skipped,
      },
      categories,
    };

    console.log('\n' + '='.repeat(60));
    console.log('📊 BENCHMARK SUMMARY');
    console.log('='.repeat(60));
    console.log(`Total: ${report.summary.total}`);
    console.log(`Passed: ${report.summary.passed} ✅`);
    console.log(`Failed: ${report.summary.failed} ❌`);
    console.log(`Skipped: ${report.summary.skipped} ⏭️`);
    console.log(`Duration: ${(totalDurationMs / 1000).toFixed(2)}s`);
    console.log('');

    console.log('📁 Category Breakdown:');
    for (const [category, stats] of Object.entries(categories)) {
      console.log(`   ${category}: ${stats.passed}/${stats.total} passed`);
    }
    console.log('');

    this.saveReports(report);

    return report;
  }

  private saveReports(report: BenchmarkReport): void {
    const outputDir = path.join(process.cwd(), '.commander_benchmarks');
    fs.mkdirSync(outputDir, { recursive: true });

    const jsonPath = path.join(outputDir, `benchmark-${Date.now()}.json`);
    fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
    console.log(`📄 JSON report saved to: ${jsonPath}`);

    const mdPath = path.join(outputDir, `benchmark-${Date.now()}.md`);
    fs.writeFileSync(mdPath, this.generateMarkdown(report));
    console.log(`📝 Markdown report saved to: ${mdPath}`);
  }

  private generateMarkdown(report: BenchmarkReport): string {
    const lines: string[] = [
      '# Commander Benchmark Report',
      '',
      `**Date**: ${report.timestamp}`,
      `**Duration**: ${(report.totalDurationMs / 1000).toFixed(2)}s`,
      `**Version**: ${report.version}`,
      '',
      '## Summary',
      '',
      '| Metric | Value |',
      '|--------|-------|',
      `| Total Tests | ${report.summary.total} |`,
      `| Passed | ${report.summary.passed} ✅ |`,
      `| Failed | ${report.summary.failed} ❌ |`,
      `| Skipped | ${report.summary.skipped} ⏭️ |`,
      '',
      '## Category Breakdown',
      '',
      '| Category | Passed | Total | Rate |',
      '|----------|--------|-------|------|',
    ];

    for (const [category, stats] of Object.entries(report.categories)) {
      const rate = stats.total > 0 ? (stats.passed / stats.total * 100).toFixed(1) : '0.0';
      lines.push(`| ${category} | ${stats.passed} | ${stats.total} | ${rate}% |`);
    }

    lines.push('');
    lines.push('## Detailed Results');
    lines.push('');

    for (const result of report.results) {
      const status = result.passed ? '✅' : '❌';
      lines.push(`### ${status} ${result.category}/${result.name}`);
      lines.push('');
      lines.push(`- **Duration**: ${result.durationMs.toFixed(2)}ms`);
      lines.push('');
      lines.push('| Metric | Value |');
      lines.push('|--------|-------|');
      for (const [key, value] of Object.entries(result.metrics)) {
        lines.push(`| ${key} | ${value} |`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }
}

let runner: BenchmarkRunner | null = null;

export function getBenchmarkRunner(): BenchmarkRunner {
  if (!runner) {
    runner = new BenchmarkRunner();
  }
  return runner;
}

export function resetBenchmarkRunner(): void {
  runner = null;
}
