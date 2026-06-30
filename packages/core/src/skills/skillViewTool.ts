import type { Tool, ToolDefinition } from '../runtime/types';
import { getGlobalLogger } from '../logging';

const DEFINITION: ToolDefinition = {
  name: 'skill_view',
  description:
    'Load full skill instructions by name. Use this when a skill from the Available Skills catalog matches your current task. Returns the complete skill content with step-by-step instructions.',
  inputSchema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'The skill name to load (from the Available Skills catalog).',
      },
    },
    required: ['name'],
  },
  category: 'knowledge',
  costTier: 'free', // load skill instructions — < 200 output tokens of overhead, no LLM cost
};

export class SkillViewTool implements Tool {
  readonly definition = DEFINITION;
  isConcurrencySafe = true;
  isReadOnly = true;
  timeout = 5000;
  maxOutputSize = 20000;

  async execute(args: Record<string, unknown>): Promise<string> {
    const name = String(args.name ?? '');
    if (!name) return 'Error: skill name is required.';

    try {
      const { getSkillSystem } = await import('./index');
      const skill = await getSkillSystem().manager.get(name);
      if (!skill) return `Skill "${name}" not found.`;

      const header = `## ${skill.name}\n${skill.description}\n\n`;
      const meta = [
        `Quality: ${(skill.metadata.qualityScore * 100).toFixed(0)}%`,
        `Usage: ${skill.metadata.usageCount} times`,
        `Category: ${skill.metadata.category}`,
        skill.metadata.tags.length > 0 ? `Tags: ${skill.metadata.tags.join(', ')}` : '',
      ]
        .filter(Boolean)
        .join(' · ');

      return `${header}${meta}\n\n---\n\n${skill.content}`;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      getGlobalLogger().warn('SkillViewTool', `Failed to load skill "${name}"`, { error: msg });
      return `Error loading skill "${name}": ${msg}`;
    }
  }
}
