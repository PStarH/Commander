/**
 * Skill System — inspired by OpenClaw and Hermes Agent.
 *
 * Skills are markdown files that teach agents how to use tools effectively.
 * After complex tasks (>5 tool calls), Commander can persist successful
 * patterns as skills. Future sessions load relevant skills automatically.
 *
 * Three loading levels (Hermes-inspired progressive disclosure):
 *   Level 0: Skill names only (~3K tokens for full library)
 *   Level 1: Full SKILL.md for relevant skill
 *   Level 2: Reference files on demand
 */
import * as fs from 'fs';
import * as path from 'path';

const SKILLS_DIR = path.join(process.cwd(), '.commander', 'skills');

export interface SkillDef {
  name: string;
  description: string;
  tools: string[];
  prompt: string;
  usageCount: number;
  createdAt: string;
  updatedAt: string;
}

function ensureDir(): void {
  if (!fs.existsSync(SKILLS_DIR)) fs.mkdirSync(SKILLS_DIR, { recursive: true });
}

/**
 * Create or update a skill from an execution pattern.
 * After a task with >5 tool calls, Commander calls this to persist the approach.
 */
export function createSkill(name: string, description: string, tools: string[], prompt: string): SkillDef {
  ensureDir();
  const now = new Date().toISOString();
  const skill: SkillDef = { name, description, tools, prompt, usageCount: 0, createdAt: now, updatedAt: now };
  fs.writeFileSync(path.join(SKILLS_DIR, `${name}.json`), JSON.stringify(skill, null, 2));
  return skill;
}

export function loadSkill(name: string): SkillDef | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(SKILLS_DIR, `${name}.json`), 'utf-8'));
  } catch { return null; }
}

/**
 * List all skills (Level 0: names + descriptions only, no full prompts).
 * This keeps context cost low even with hundreds of skills.
 */
export function listSkills(): SkillDef[] {
  ensureDir();
  return fs.readdirSync(SKILLS_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      try {
        const s: SkillDef = JSON.parse(fs.readFileSync(path.join(SKILLS_DIR, f), 'utf-8'));
        return s;
      } catch { return null; }
    })
    .filter((s): s is SkillDef => s !== null)
    .sort((a, b) => b.usageCount - a.usageCount);
}

/**
 * Get the system prompt additions from relevant skills.
 * Level 1: loads full prompt for most-used skills.
 * Returns only skill names + descriptions by default (Level 0).
 */
export function buildSkillsPrompt(maxLevel: 0 | 1 | 2 = 0): string {
  const skills = listSkills();
  if (skills.length === 0) return '';

  if (maxLevel === 0) {
    return '### Available Skills\n\n' + skills.map(s => `- ${s.name}: ${s.description}`).join('\n');
  }

  return skills.map(s => {
    let block = `### ${s.name}\n${s.description}\n\n${s.prompt}`;
    if (s.tools.length > 0) block += `\n\nTools: ${s.tools.join(', ')}`;
    return block;
  }).join('\n\n');
}

export function recordSkillUsage(name: string): void {
  const skill = loadSkill(name);
  if (skill) {
    skill.usageCount++;
    skill.updatedAt = new Date().toISOString();
    fs.writeFileSync(path.join(SKILLS_DIR, `${name}.json`), JSON.stringify(skill, null, 2));
  }
}

export function deleteSkill(name: string): boolean {
  try {
    fs.unlinkSync(path.join(SKILLS_DIR, `${name}.json`));
    return true;
  } catch { return false; }
}
