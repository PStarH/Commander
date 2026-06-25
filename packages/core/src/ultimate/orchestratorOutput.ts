import { reportSilentFailure } from '../silentFailureReporter';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AgentRuntimeInterface } from '../runtime';
import type { ArtifactReference, TaskTreeNode } from './types';
import { collectCompletedNodes, flattenTree } from './taskTreeUtils';

/** Minimum ratio of agent-written content to synthesis to prefer agent output */
const AGENT_CONTENT_PREF_RATIO = 1.2;

/** Minimum agent-written file size to consider */
const MIN_AGENT_FILE_SIZE = 200;

/** Buffer time in ms before execution start for file modification detection */
const FILE_DETECTION_BUFFER_MS = 1000;

export interface OrchestratorOutputParams {
  execId: string;
  taskTree: TaskTreeNode;
  projectId: string;
  goal: string;
  contextData?: Record<string, unknown>;
  artifacts: ArtifactReference[];
  finalSynthesis: string;
  startTime: number;
  reasoning: string[];
}

export class OrchestratorOutputCollector {
  constructor(private readonly runtime: AgentRuntimeInterface) {}

  async resolveFinalOutput(options: OrchestratorOutputParams): Promise<string> {
    let finalOutput = options.finalSynthesis;

    try {
      const workspace = process.env.COMMANDER_WORKSPACE || process.cwd();
      const startTimeMs = options.startTime - FILE_DETECTION_BUFFER_MS;

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
          reportSilentFailure(err, 'orchestratorOutput:55');
        }
      };

      // Method 1: Extract absolute file paths from node results.
      const completedNodes = collectCompletedNodes(options.taskTree);
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

      // Method 2: Extract target file path from the goal itself.
      const goalFilePath = extractOutputFilePath(options.goal);
      if (goalFilePath) {
        const resolvedGoal = resolveOutputPath(goalFilePath, workspace);
        if (isPathSandboxed(resolvedGoal, workspace)) {
          tryAddFile(resolvedGoal);
        }
      }

      // Method 3: Scan workspace root for files created during execution.
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
        reportSilentFailure(err, 'orchestratorOutput:98');
      }

      // Method 4: Scan /tmp/ for files matching goal patterns.
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
        reportSilentFailure(err, 'orchestratorOutput:112');
      }

      // Method 5: Scan per-agent output directories.
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
              reportSilentFailure(err, 'orchestratorOutput:130');
              /* ignore per-agent scan errors */
            }
          }
        }
      } catch (err) {
        reportSilentFailure(err, 'orchestratorOutput:136');
      }

      const totalAgentContent = agentWrittenFiles.reduce((s, f) => s + f.size, 0);
      if (
        totalAgentContent > options.finalSynthesis.length * AGENT_CONTENT_PREF_RATIO &&
        agentWrittenFiles.length > 0
      ) {
        const combined = agentWrittenFiles
          .sort((a, b) => b.size - a.size)
          .map((f) => f.content)
          .join('\n\n---\n\n');
        finalOutput = combined;
        options.reasoning.push(
          `Combined ${agentWrittenFiles.length} agent-written files (${totalAgentContent} bytes) instead of synthesis (${options.finalSynthesis.length} bytes)`,
        );
      }

      {
        const allResults: string[] = [];
        const allNodes = flattenTree(options.taskTree);
        for (const n of allNodes) {
          if (n.status !== 'COMPLETED') continue;
          const content = n.fullSubtaskResults || n.result;
          if (content && content.length > 10) {
            allResults.push(`### ${n.goal.slice(0, 150)}\n\n${content}`);
          }
        }
        for (const artifact of options.artifacts) {
          if (artifact.content && artifact.content.length > 50) {
            allResults.push(`### Artifact: ${artifact.title}\n\n${artifact.content}`);
          }
        }
        if (allResults.length > 0) {
          const combinedAll = allResults.join('\n\n---\n\n');
          if (combinedAll.length > finalOutput.length) {
            finalOutput = `# Complete Results\n\n${combinedAll}`;
            options.reasoning.push(
              `Combined ${allResults.length} data sources (${finalOutput.length} bytes)`,
            );
          }
        }
      }

      if (finalOutput.length < 5000) {
        finalOutput = await this.generateDetailedOutput(options, finalOutput);
      }
    } catch (e) {
      options.reasoning.push(
        `Agent file collection failed: ${e instanceof Error ? e.message : 'unknown'}`,
      );
    }

    return finalOutput;
  }

  async writeTargetFile(goal: string, finalOutput: string, reasoning: string[]): Promise<void> {
    try {
      const fileIntent = extractOutputFilePath(goal);
      if (!fileIntent) return;

      const resolvedPath = resolveOutputPath(fileIntent, process.cwd());
      if (!isPathSandboxed(resolvedPath)) {
        reasoning.push(
          `File write blocked: path "${resolvedPath}" is outside allowed sandbox directories`,
        );
        return;
      }

      const dir = path.dirname(resolvedPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(resolvedPath, finalOutput, 'utf-8');
      reasoning.push(`Wrote synthesis output (${finalOutput.length} bytes) to ${resolvedPath}`);
    } catch (e) {
      reasoning.push(`File write failed: ${e instanceof Error ? e.message : 'unknown'}`);
    }
  }

  private async generateDetailedOutput(
    options: OrchestratorOutputParams,
    currentOutput: string,
  ): Promise<string> {
    try {
      const outputGoal = [
        `You are an expert analyst. Your job is to produce a comprehensive, detailed output.`,
        ``,
        `TASK: ${options.goal}`,
        ``,
        `INSTRUCTIONS:`,
        `1. Use file_read to read ALL relevant source files mentioned in the task`,
        `2. Analyze each file in detail - include specific code snippets, line numbers, and examples`,
        `3. Produce a comprehensive analysis with clear headers and sections`,
        `4. Include actionable recommendations with code examples`,
        `5. Write at least 2000 words of substantive content`,
        `6. If the task asks to write to a file, use file_write to write the complete output`,
        `7. Do NOT just describe what you will do - actually read the files and produce the analysis`,
      ].join('\n');

      const outputResult = await this.runtime.execute({
        agentId: `output-generator-${options.execId}`,
        projectId: options.projectId,
        goal: outputGoal,
        contextData: options.contextData ?? {},
        availableTools: (options.contextData?.availableTools as string[]) || [],
        maxSteps: 15,
        tokenBudget: 80000,
      });

      if (outputResult.status === 'success' && outputResult.summary.length > currentOutput.length) {
        options.reasoning.push(`Output generator: produced ${outputResult.summary.length} bytes`);
        return outputResult.summary;
      }
    } catch (e) {
      options.reasoning.push(
        `Output generator failed: ${e instanceof Error ? e.message : 'unknown'}`,
      );
    }

    return currentOutput;
  }
}

/**
 * Extract the output file path from a goal string, if the goal asks to
 * write/create a file. Returns the file path or null.
 */
export function extractOutputFilePath(goal: string): string | null {
  const extRe = `(?:md|txt|json|ts|js|py|html|css|yaml|yml|csv|xml|sh|sql|go|rs|java|c|cpp|h)`;

  const toPattern = new RegExp(
    `(?:write|create|generate|output|produce|save)\\b[^.]*?\\bto\\b\\s+([\\/\\.][\\S]+\\.${extRe})`,
    'i',
  );
  const toMatch = goal.match(toPattern);
  if (toMatch) return toMatch[1];

  const directPattern = new RegExp(
    `(?:write|create|generate|output|produce|save)\\s+([\\/\\.][\\S]+\\.${extRe})`,
    'i',
  );
  const directMatch = goal.match(directPattern);
  if (directMatch) return directMatch[1];

  const pathPattern = new RegExp(`([\\/][\\S]+\\.${extRe})(?:\\s|$|[.])`, 'i');
  const pathMatch = goal.match(pathPattern);
  if (pathMatch) return pathMatch[1];

  return null;
}

export function resolveOutputPath(filePath: string, workspace = process.cwd()): string {
  if (filePath === '~') {
    return path.resolve(process.env.HOME || workspace);
  }
  if (filePath.startsWith('~/')) {
    return path.resolve(process.env.HOME || workspace, filePath.slice(2));
  }
  return path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(workspace, filePath);
}

/**
 * Validates that a resolved file path is within an allowed sandbox directory.
 * Prevents writing to sensitive system paths.
 */
export function isPathSandboxed(resolvedPath: string, workspace?: string): boolean {
  const allowedRoots = [workspace, process.env.HOME, '/tmp/commander-output', process.cwd()].filter(
    Boolean,
  ) as string[];

  const normalizedPath = path.resolve(resolvedPath);
  return allowedRoots
    .map((root) => path.resolve(root))
    .some((root) => normalizedPath === root || normalizedPath.startsWith(root + path.sep));
}
