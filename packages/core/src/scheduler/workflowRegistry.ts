import * as fs from 'fs';
import * as path from 'path';
import { getGlobalLogger } from '../logging';
import type { WorkflowDefinition, WorkflowStep, WorkflowTrigger } from './types';

/**
 * Parse a workflow markdown file into a WorkflowDefinition.
 * Expected format:
 *
 *   ---
 *   name: my-workflow
 *   description: Does X, Y, Z
 *   trigger:
 *     cron: "0 6 * * 1"
 *   topology: SEQUENTIAL
 *   effort: high
 *   ---
 *
 *   ## Steps
 *
 *   ### 1. First step
 *   goal: Do something
 *   tools: [Bash, Read]
 *   model-tier: standard
 *   parallelizable: true
 *
 *   ### 2. Second step
 *   goal: Do something else
 *   tools: [Write]
 *   model-tier: best
 *   depends-on: [step-1]
 */
export function parseWorkflowMarkdown(filePath: string, content: string): WorkflowDefinition | null {
  const baseName = path.basename(filePath, '.md');
  const id = baseName.toLowerCase().replace(/[^a-z0-9-]/g, '-');

  // Extract YAML frontmatter
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!frontmatterMatch) {
    getGlobalLogger().warn('WorkflowRegistry', `No frontmatter in ${filePath}, skipping`);
    return null;
  }

  const frontmatter = frontmatterMatch[1];
  const body = content.slice(frontmatterMatch[0].length);

  const fm = parseSimpleYAML(frontmatter);

  const name = (fm.name as string) ?? id;
  const description = (fm.description as string) ?? '';

  // Parse trigger from frontmatter
  const triggers: WorkflowTrigger[] = [];
  if (fm.trigger && typeof fm.trigger === 'object') {
    const t = fm.trigger as Record<string, unknown>;
    if (t.cron) triggers.push({ type: 'cron', cron: t.cron as string, label: `cron:${t.cron}` });
    if (t.interval) triggers.push({ type: 'interval', interval: t.interval as string, label: `every ${t.interval}` });
    if (t.at) triggers.push({ type: 'once', at: t.at as string, label: `at ${t.at}` });
  }

  // Parse goal — either from frontmatter or first non-step line
  const goal = (fm.goal as string) ?? description;

  // Parse steps from body
  const steps = parseSteps(body);

  return {
    id,
    name,
    description,
    goal,
    steps,
    triggers,
    topology: (fm.topology as WorkflowDefinition['topology']) ?? undefined,
    effort: (fm.effort as WorkflowDefinition['effort']) ?? undefined,
    agentCount: (fm.agentCount as number) ?? undefined,
    sourcePath: filePath,
    scope: filePath.includes('.commander/workflows') ? 'project' : 'user',
  };
}

function parseSteps(body: string): WorkflowStep[] {
  const steps: WorkflowStep[] = [];
  // Match "### N. Title" blocks
  const stepBlocks = body.split(/(?=^###\s+\d+\.)/m);
  for (const block of stepBlocks) {
    const headerMatch = block.match(/^###\s+\d+\.\s+(.+)$/m);
    if (!headerMatch) continue;

    const goalMatch = block.match(/goal:\s*(.+)$/m);
    const toolsMatch = block.match(/tools:\s*\[([^\]]*)\]/);
    const modelMatch = block.match(/model-tier:\s*(.+)$/m);
    const parallelMatch = block.match(/parallelizable:\s*(true|false)/);
    const dependsMatch = block.match(/depends-on:\s*\[([^\]]*)\]/);
    const timeoutMatch = block.match(/timeout:\s*(\d+)/);

    const stepId = headerMatch[1].toLowerCase().replace(/[^a-z0-9-]/g, '-');

    steps.push({
      id: stepId,
      goal: goalMatch?.[1]?.trim() ?? headerMatch[1].trim(),
      tools: toolsMatch ? toolsMatch[1].split(',').map(s => s.trim()).filter(Boolean) : [],
      modelTier: (modelMatch?.[1]?.trim() as WorkflowStep['modelTier']) ?? 'standard',
      parallelizable: parallelMatch?.[1] === 'true',
      dependsOn: dependsMatch ? dependsMatch[1].split(',').map(s => s.trim()).filter(Boolean) : [],
      timeoutMs: timeoutMatch ? parseInt(timeoutMatch[1], 10) : 60_000,
    });
  }
  return steps;
}

/**
 * Ultra-minimal YAML frontmatter parser.
 * Only supports flat keys + nested object for `trigger:`.
 * No arrays, no multi-line strings. Good enough for workflow metadata.
 */
function parseSimpleYAML(text: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  let currentKey: string | null = null;
  let currentObj: Record<string, unknown> | null = null;

  for (const line of text.split('\n')) {
    const indent = line.match(/^(\s*)/)?.[1]?.length ?? 0;

    if (indent === 0) {
      const flatMatch = line.match(/^(\w[\w-]*):\s*(.*)$/);
      if (flatMatch) {
        currentKey = flatMatch[1];
        currentObj = null;
        const val = flatMatch[2].trim();
        if (val === '') {
          // This key has a nested object — prepare for it
          currentObj = {};
          result[currentKey] = currentObj;
        } else {
          result[currentKey] = parseScalar(val);
        }
      }
    } else if (indent > 0 && currentObj !== null) {
      // Nested key inside trigger: or similar
      const nestedMatch = line.match(/^\s+(\w[\w-]*):\s*(.*)$/);
      if (nestedMatch) {
        currentObj[nestedMatch[1]] = parseScalar(nestedMatch[2].trim());
      }
    }
  }

  return result;
}

function parseScalar(val: string): string | number | boolean {
  if (val === 'true') return true;
  if (val === 'false') return false;
  const num = Number(val);
  if (!isNaN(num) && val.trim() !== '') return num;
  return val;
}

// ============================================================================
// Registry — discover workflows from filesystem
// ============================================================================

export class WorkflowRegistry {
  private workflows = new Map<string, WorkflowDefinition>();
  private watchDirs: string[];

  constructor(dirs: string[]) {
    this.watchDirs = dirs;
  }

  /**
   * Scan all configured directories for workflow markdown files.
   * Scans both `.commander/workflows/` in project and `~/.commander/workflows/` for user.
   */
  scan(): WorkflowDefinition[] {
    const found: WorkflowDefinition[] = [];

    for (const dir of this.watchDirs) {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        continue;
      }

      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.name.endsWith('.md')) continue;
          const filePath = path.join(dir, entry.name);
          const content = fs.readFileSync(filePath, 'utf-8');

          const wf = parseWorkflowMarkdown(filePath, content);
          if (wf) {
            this.workflows.set(wf.id, wf);
            found.push(wf);
          }
        }
      } catch (err) {
        getGlobalLogger().warn('WorkflowRegistry', `Failed to scan ${dir}`, { error: (err as Error).message });
      }
    }

    return found;
  }

  get(id: string): WorkflowDefinition | undefined {
    return this.workflows.get(id);
  }

  list(): WorkflowDefinition[] {
    return [...this.workflows.values()];
  }

  reload(id: string): WorkflowDefinition | undefined {
    const existing = this.workflows.get(id);
    if (!existing) return undefined;
    try {
      const content = fs.readFileSync(existing.sourcePath, 'utf-8');
      const wf = parseWorkflowMarkdown(existing.sourcePath, content);
      if (wf) {
        this.workflows.set(wf.id, wf);
        return wf;
      }
    } catch {
      // file may have been deleted
      this.workflows.delete(id);
    }
    return undefined;
  }
}
