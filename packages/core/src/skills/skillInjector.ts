import type { DisclosureLevel } from './types';
import type { SkillManager } from './skillManager';

export class SkillInjector {
  private manager: SkillManager;

  constructor(manager: SkillManager) {
    this.manager = manager;
  }

  async buildSkillsBlock(goal: string, maxLevel: DisclosureLevel = 0): Promise<string> {
    const catalog = await this.manager.list();
    if (catalog.length === 0) return '';

    const level0 = [
      '## Available Skills',
      ...catalog.map(
        (s) => `- ${s.name}: ${s.description} (quality: ${(s.qualityScore * 100).toFixed(0)}%)`,
      ),
    ].join('\n');

    if (maxLevel === 0) return level0;

    const relevant = await this.manager.suggestForTask(goal, 3);
    let level1 = '';
    if (relevant.length > 0) {
      const blocks: string[] = ['\n\n### Recommended Skills'];
      for (const entry of relevant) {
        const skill = await this.manager.get(entry.name);
        if (skill) {
          blocks.push(`\`\`\`skill\n${skill.content}\n\`\`\``);
        }
      }
      level1 = blocks.join('\n\n');
    }

    if (maxLevel === 1) return level0 + level1;

    const level2 =
      '\n\n### Skill References\n' +
      catalog.map((s) => `- \`.commander/skills/${s.name}/SKILL.md\``).join('\n');

    return level0 + level1 + level2;
  }

  buildSkillUsageInstructions(): string {
    return [
      '## Skill Usage',
      '- Below is a catalog of available skills. Each skill contains step-by-step instructions for specific tasks.',
      '- If a skill description matches your current task, check the skill name.',
      '- To load full skill instructions, use the `skill_view` tool with the skill name.',
      '- Always follow the skill instructions exactly when you activate a skill.',
      '- Do NOT implement directly if a skill applies — use it.',
    ].join('\n');
  }
}
