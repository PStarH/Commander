/**
 * Extracted from UltimateOrchestrator to shrink the god object.
 *
 * Responsible for collecting agent-written file content after execution and
 * enriching the final output. Runs five detection methods (node result paths,
 * goal path, workspace scan, /tmp scan, per-agent output dirs) and an optional
 * output-generator agent fallback when the synthesis is too thin.
 */
import type { TaskTreeNode } from './types';
import type { ArtifactReference } from '../shared/types';
import type { AgentRuntimeInterface } from '../runtime';
import { collectCompletedNodes, flattenTree } from './taskTreeUtils';
import { reportSilentFailure } from '../silentFailureReporter';

// ── Constants ────────────────────────────────────────────────────────────────

/** Minimum ratio of agent-written content to synthesis to prefer agent output */
const AGENT_CONTENT_PREF_RATIO = 1.2;

/** Minimum agent-written file size to consider */
const MIN_AGENT_FILE_SIZE = 200;

/** Buffer time in ms before execution start for file modification detection */
const FILE_DETECTION_BUFFER_MS = 1000;

// ── Types ────────────────────────────────────────────────────────────────────

export interface AgentFileCollectorDeps {
  runtime: AgentRuntimeInterface;
}

export interface CollectAgentFilesParams {
  execId: string;
  goal: string;
  projectId: string;
  contextData?: Record<string, unknown>;
  startTime: number;
  taskTree: TaskTreeNode;
  allArtifacts: ArtifactReference[];
  finalSynthesis: string;
}

// ── Pure helpers (exported for reuse) ────────────────────────────────────────

/**
 * Extract the output file path from a goal string, if the goal asks to
 * write/create a file. Returns the file path or null.
 */
export function extractOutputFilePath(goal: string): string | null {
  const extRe = `(?:md|txt|json|ts|js|py|html|css|yaml|yml|csv|xml|sh|sql|go|rs|java|c|cpp|h)`;

  // Pattern 1: verb + any words + "to" + path
  const toPattern = new RegExp(
    `(?:write|create|generate|output|produce|save)\\b[^.]*?\\bto\\b\\s+([\\/\\.][\\S]+\\.${extRe})`,
    'i',
  );
  const toMatch = goal.match(toPattern);
  if (toMatch) return toMatch[1];

  // Pattern 2: verb + path directly (e.g., "write /tmp/file.md")
  const directPattern = new RegExp(
    `(?:write|create|generate|output|produce|save)\\s+([\\/\\.][\\S]+\\.${extRe})`,
    'i',
  );
  const directMatch = goal.match(directPattern);
  if (directMatch) return directMatch[1];

  // Pattern 3: any absolute path with known extension at end of sentence/line
  const pathPattern = new RegExp(`([\\/][\\S]+\\.${extRe})(?:\\s|$|[.])`, 'i');
  const pathMatch = goal.match(pathPattern);
  if (pathMatch) return pathMatch[1];

  return null;
}

// ── AgentFileCollector ───────────────────────────────────────────────────────

export class AgentFileCollector {
  constructor(private readonly deps: AgentFileCollectorDeps) {}

  /**
   * Collect agent-written file content and enrich the final output.
   *
   * Five detection methods:
   *  1. Extract absolute file paths from completed node results
   *  2. Extract target file path from the goal string
   *  3. Scan workspace root for files created during execution
   *  4. Scan /tmp/ for files matching goal patterns
   *  5. Scan per-agent output directories
   *
   * If the collected content is substantially larger than the synthesis,
   * it replaces the output. If output is still thin (<5000 bytes), a
   * dedicated output-generator agent is spawned as a fallback.
   *
   * @returns The enriched final output string
   */
  async collectAndEnrich(
    params: CollectAgentFilesParams,
    reasoning: string[],
  ): Promise<string> {
    let finalOutput = params.finalSynthesis;

    try {
      const fs = await import('fs');
      const path = await import('path');
      const workspace = process.env.COMMANDER_WORKSPACE || process.cwd();
      const startTimeMs = params.startTime - FILE_DETECTION_BUFFER_MS;

      const agentWrittenFiles: Array<{ path: string; content: string; size: number }> = [];
      const seenPaths = new Set<string>();

      const tryAddFile = (fullPath: string): void => {
        if (seenPaths.has(fullPath)) return;
        try {
          if (!fs.existsSync(fullPath)) return;
          const stat = fs.statSync(fullPath);
          if (stat.mtimeMs >= startTimeMs && stat.size > MIN_AGENT_FILE_SIZE) {
            seenPaths.add(fullPath);
            agentWrittenFiles.push({
              path: fullPath,
              content: fs.readFileSync(fullPath, 'utf-8'),
              size: stat.size,
            });
          }
        } catch (err) {
          reportSilentFailure(err, 'orchestrator:802');
          /* ignore */
        }
      };

      // Method 1: Extract absolute file paths from node results
      const completedNodes = collectCompletedNodes(params.taskTree);
      for (const node of completedNodes) {
        const resultText = node.fullSubtaskResults || node.result || '';
        const absPathMatches = resultText.matchAll(
          /(?:^|\s)(\/[\w./-]+\.(?:md|txt|json|ts|js|py|html|css|yaml|yml|csv|xml|sh|sql))(?:\s|$|[.,:])/gm,
        );
        for (const match of absPathMatches) {
          tryAddFile(match[1]);
        }
        const relPathMatches = resultText.matchAll(
          /(?:[\w.-]+\.(?:md|txt|json|ts|js|py|html|css|yaml|yml))/g,
        );
        for (const match of relPathMatches) {
          tryAddFile(path.join(workspace, match[0]));
        }
      }

      // Method 2: Extract target file path from the goal itself
      const goalFilePath = extractOutputFilePath(params.goal);
      if (goalFilePath) {
        const resolvedGoal =
          goalFilePath.startsWith('/') || goalFilePath.startsWith('~')
            ? goalFilePath.replace(/^~/, process.env.HOME || '')
            : path.join(workspace, goalFilePath);
        tryAddFile(resolvedGoal);
      }

      // Method 3: Scan workspace root for files created during execution
      try {
        const entries = fs.readdirSync(workspace, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isFile()) continue;
          const ext = path.extname(entry.name).toLowerCase();
          if (!['.md', '.txt', '.json', '.ts', '.js', '.py'].includes(ext)) continue;
          if (entry.name.startsWith('.') || entry.name === 'package.json') continue;
          tryAddFile(path.join(workspace, entry.name));
        }
      } catch (err) {
        reportSilentFailure(err, 'orchestrator:849');
        /* ignore */
      }

      // Method 4: Scan /tmp/ for files matching goal patterns
      try {
        const tmpFiles = fs.readdirSync('/tmp', { withFileTypes: true });
        for (const entry of tmpFiles) {
          if (!entry.isFile()) continue;
          const ext = path.extname(entry.name).toLowerCase();
          if (!['.md', '.txt', '.json'].includes(ext)) continue;
          if (entry.name.startsWith('.') || entry.name.length < 5) continue;
          tryAddFile(path.join('/tmp', entry.name));
        }
      } catch (err) {
        reportSilentFailure(err, 'orchestrator:864');
        /* ignore */
      }

      // Method 5: Scan per-agent output directories
      try {
        const commanderOutputDir = path.join(workspace, '.commander_output');
        if (fs.existsSync(commanderOutputDir)) {
          const agentDirs = fs.readdirSync(commanderOutputDir, { withFileTypes: true });
          for (const agentDir of agentDirs) {
            if (!agentDir.isDirectory()) continue;
            const agentPath = path.join(commanderOutputDir, agentDir.name);
            try {
              const files = fs.readdirSync(agentPath, { withFileTypes: true });
              for (const file of files) {
                if (!file.isFile()) continue;
                tryAddFile(path.join(agentPath, file.name));
              }
            } catch (err) {
              reportSilentFailure(err, 'orchestrator:883');
              /* ignore */
            }
          }
        }
      } catch (err) {
        reportSilentFailure(err, 'orchestrator:889');
        /* ignore */
      }

      // If agents wrote substantial content, use that instead of truncated synthesis
      const totalAgentContent = agentWrittenFiles.reduce((s, f) => s + f.size, 0);
      if (
        totalAgentContent > params.finalSynthesis.length * AGENT_CONTENT_PREF_RATIO &&
        agentWrittenFiles.length > 0
      ) {
        const combined = agentWrittenFiles
          .sort((a, b) => b.size - a.size)
          .map((f) => f.content)
          .join('\n\n---\n\n');
        finalOutput = combined;
        reasoning.push(
          `Combined ${agentWrittenFiles.length} agent-written files (${totalAgentContent} bytes) instead of synthesis (${params.finalSynthesis.length} bytes)`,
        );
      }

      // Aggressive fallback: collect ALL available data, but only use if larger
      {
        const allResults: string[] = [];
        const allNodes = flattenTree(params.taskTree);
        for (const n of allNodes) {
          if (n.status !== 'COMPLETED') continue;
          const content = n.fullSubtaskResults || n.result;
          if (content && content.length > 10) {
            allResults.push(`### ${n.goal.slice(0, 150)}\n\n${content}`);
          }
        }
        for (const artifact of params.allArtifacts) {
          if (artifact.content && artifact.content.length > 50) {
            allResults.push(`### Artifact: ${artifact.title}\n\n${artifact.content}`);
          }
        }
        if (allResults.length > 0) {
          const combinedAll = allResults.join('\n\n---\n\n');
          if (combinedAll.length > finalOutput.length) {
            finalOutput = `# Complete Results\n\n${combinedAll}`;
            reasoning.push(
              `Combined ${allResults.length} data sources (${finalOutput.length} bytes)`,
            );
          }
        }
      }

      // Output generator: if output is STILL thin, run a dedicated agent
      if (finalOutput.length < 5000) {
        try {
          const outputGoal = [
            `You are an expert analyst. Your job is to produce a comprehensive, detailed output.`,
            ``,
            `TASK: ${params.goal}`,
            ``,
            `INSTRUCTIONS:`,
            `1. Use file_read to read ALL relevant source files mentioned in the task`,
            `2. Analyze each file in detail — include specific code snippets, line numbers, and examples`,
            `3. Produce a comprehensive analysis with clear headers and sections`,
            `4. Include actionable recommendations with code examples`,
            `5. Write at least 2000 words of substantive content`,
            `6. If the task asks to write to a file, use file_write to write the complete output`,
            `7. Do NOT just describe what you will do — actually read the files and produce the analysis`,
          ].join('\n');

          const outputResult = await this.deps.runtime.execute({
            agentId: `output-generator-${params.execId}`,
            projectId: params.projectId,
            goal: outputGoal,
            contextData: params.contextData ?? {},
            availableTools: (params.contextData?.availableTools as string[]) || [],
            maxSteps: 15,
            tokenBudget: 80000,
          });

          if (
            outputResult.status === 'success' &&
            outputResult.summary.length > finalOutput.length
          ) {
            finalOutput = outputResult.summary;
            reasoning.push(`Output generator: produced ${finalOutput.length} bytes`);
          }
        } catch (e) {
          reasoning.push(
            `Output generator failed: ${e instanceof Error ? e.message : 'unknown'}`,
          );
        }
      }
    } catch (e) {
      reasoning.push(
        `Agent file collection failed: ${e instanceof Error ? e.message : 'unknown'}`,
      );
    }

    return finalOutput;
  }
}
