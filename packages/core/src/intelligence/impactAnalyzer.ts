/**
 * Impact Analyzer — Analyzes code change impact before execution.
 *
 * Used internally by the agent to warn about change side effects.
 * Users see: "改这个会影响 3 个文件" — they don't call this directly.
 *
 * Uses AST analysis and dependency tracking.
 */

import { reportSilentFailure } from '../silentFailureReporter';
import { getGlobalLogger } from '../logging';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ============================================================================
// Types
// ============================================================================

export interface ImpactAnalysis {
  targetFile: string;
  directDependencies: string[];
  indirectDependencies: string[];
  affectedTests: string[];
  affectedApis: string[];
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  summary: string;
}

export interface DependencyNode {
  file: string;
  imports: string[];
  importedBy: string[];
}

// ============================================================================
// Impact Analyzer
// ============================================================================

export class ImpactAnalyzer {
  private dependencyGraph: Map<string, DependencyNode> = new Map();
  private lastScanTime = 0;
  private scanIntervalMs = 60000; // Re-scan every 60s

  constructor(private projectRoot?: string) {}

  /**
   * Analyze impact of changing a file.
   */
  async analyze(filePath: string): Promise<ImpactAnalysis> {
    // Ensure dependency graph is fresh
    await this.refreshGraph();

    const node = this.dependencyGraph.get(filePath);
    if (!node) {
      return {
        targetFile: filePath,
        directDependencies: [],
        indirectDependencies: [],
        affectedTests: [],
        affectedApis: [],
        riskLevel: 'low',
        summary: 'File not found in dependency graph',
      };
    }

    // Direct dependencies (files that import this file)
    const direct = node.importedBy;

    // Indirect dependencies (files that import the direct dependencies)
    const indirectSet = new Set<string>();
    for (const dep of direct) {
      const depNode = this.dependencyGraph.get(dep);
      if (depNode) {
        for (const indirectDep of depNode.importedBy) {
          if (indirectDep !== filePath && !direct.includes(indirectDep)) {
            indirectSet.add(indirectDep);
          }
        }
      }
    }
    const indirect = [...indirectSet];

    // Find affected tests
    const affectedTests = [...direct, ...indirect].filter(
      (f) => f.includes('.test.') || f.includes('.spec.') || f.includes('__tests__'),
    );

    // Find affected API endpoints
    const affectedApis = [...direct, ...indirect].filter(
      (f) => f.includes('routes') || f.includes('endpoint') || f.includes('controller'),
    );

    // Determine risk level
    const totalImpact = direct.length + indirect.length;
    let riskLevel: ImpactAnalysis['riskLevel'];
    if (totalImpact === 0) riskLevel = 'low';
    else if (totalImpact <= 3) riskLevel = 'medium';
    else if (totalImpact <= 10) riskLevel = 'high';
    else riskLevel = 'critical';

    // Generate summary
    const summary = this.generateSummary(
      filePath,
      direct,
      indirect,
      affectedTests,
      affectedApis,
      riskLevel,
    );

    return {
      targetFile: filePath,
      directDependencies: direct,
      indirectDependencies: [...indirect],
      affectedTests,
      affectedApis,
      riskLevel,
      summary,
    };
  }

  /**
   * Get dependency graph for a file.
   */
  getDependencies(filePath: string): DependencyNode | undefined {
    return this.dependencyGraph.get(filePath);
  }

  /**
   * Refresh dependency graph from source files.
   */
  private async refreshGraph(): Promise<void> {
    if (Date.now() - this.lastScanTime < this.scanIntervalMs) return;

    try {
      const root = this.projectRoot ?? process.cwd();

      // Scan source files
      const srcDir = path.join(root, 'packages', 'core', 'src');
      if (fs.existsSync(srcDir)) {
        this.scanDirectory(srcDir);
      }

      const apiDir = path.join(root, 'apps', 'api', 'src');
      if (fs.existsSync(apiDir)) {
        this.scanDirectory(apiDir);
      }

      this.lastScanTime = Date.now();
    } catch (err) {
      getGlobalLogger().warn('ImpactAnalyzer', `Failed to refresh graph: ${err}`);
    }
  }

  private scanDirectory(dir: string): void {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
          this.scanDirectory(fullPath);
        } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.js'))) {
          this.scanFile(fullPath);
        }
      }
    } catch (err) {
      reportSilentFailure(err, 'impactAnalyzer:169');
      /* ignore */
    }
  }

  private scanFile(filePath: string): void {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const imports = this.extractImports(content);

      let node = this.dependencyGraph.get(filePath);
      if (!node) {
        node = { file: filePath, imports: [], importedBy: [] };
        this.dependencyGraph.set(filePath, node);
      }
      node.imports = imports;

      // Update importedBy references
      for (const imp of imports) {
        let depNode = this.dependencyGraph.get(imp);
        if (!depNode) {
          depNode = { file: imp, imports: [], importedBy: [] };
          this.dependencyGraph.set(imp, depNode);
        }
        if (!depNode.importedBy.includes(filePath)) {
          depNode.importedBy.push(filePath);
        }
      }
    } catch (err) {
      reportSilentFailure(err, 'impactAnalyzer:200');
      /* ignore */
    }
  }

  private extractImports(content: string): string[] {
    const imports: string[] = [];
    const importRegex = /import\s+(?:.*\s+from\s+)?['"]([^'"]+)['"]/g;
    const requireRegex = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

    let match;
    while ((match = importRegex.exec(content)) !== null) {
      imports.push(match[1]);
    }
    while ((match = requireRegex.exec(content)) !== null) {
      imports.push(match[1]);
    }

    return imports;
  }

  private generateSummary(
    file: string,
    direct: string[],
    indirect: string[],
    tests: string[],
    apis: string[],
    risk: ImpactAnalysis['riskLevel'],
  ): string {
    const lines: string[] = [];
    lines.push(`变更影响分析: ${file}`);
    lines.push(`直接依赖: ${direct.length} 个文件`);
    lines.push(`间接依赖: ${indirect.length} 个文件`);

    if (tests.length > 0) {
      lines.push(`受影响测试: ${tests.length} 个`);
    }
    if (apis.length > 0) {
      lines.push(`受影响 API: ${apis.length} 个`);
    }

    lines.push(`风险等级: ${risk}`);

    if (risk === 'high' || risk === 'critical') {
      lines.push(`建议: 先运行受影响的测试再提交`);
    }

    return lines.join('\n');
  }
}

// ============================================================================
// Singleton
// ============================================================================

let defaultAnalyzer: ImpactAnalyzer | null = null;

export function getImpactAnalyzer(): ImpactAnalyzer {
  if (!defaultAnalyzer) {
    defaultAnalyzer = new ImpactAnalyzer();
  }
  return defaultAnalyzer;
}
