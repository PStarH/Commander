import { reportSilentFailure } from '../silentFailureReporter';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Skill } from './types';
import { getGlobalLogger } from '../logging';

const SKILLS_DIR = path.join(process.cwd(), '.commander', 'skills');

/**
 * Minimal YAML frontmatter parser. Handles the subset of YAML used in
 * agentskills.io SKILL.md files: nested objects, arrays, strings, numbers, booleans.
 */
function parseYamlFrontmatter(yaml: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = yaml.split('\n');
  const stack: Array<{ obj: Record<string, unknown>; indent: number }> = [
    { obj: result, indent: -1 },
  ];
  const arrayStack: Array<{ arr: unknown[]; key: string; _indent: number }> = [];

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;

    const indent = line.search(/\S/);
    const trimmed = line.trim();

    if (trimmed.startsWith('- ')) {
      const value = parseYamlValue(trimmed.slice(2));
      if (arrayStack.length > 0) {
        arrayStack[arrayStack.length - 1].arr.push(value);
      }
      continue;
    }

    const colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) continue;

    const key = trimmed.slice(0, colonIdx).trim();
    const valueStr = trimmed.slice(colonIdx + 1).trim();

    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
      stack.pop();
    }

    // Pop stale array context when indentation decreases
    while (
      arrayStack.length > 0 &&
      indent <= (arrayStack[arrayStack.length - 1] as unknown as { _indent: number })._indent
    ) {
      arrayStack.pop();
    }

    const currentObj = stack[stack.length - 1].obj;

    if (valueStr === '') {
      // Peek at next non-empty line to decide if this is an array or object
      let nextLine = '';
      for (let li = lines.indexOf(rawLine) + 1; li < lines.length; li++) {
        const nl = lines[li].replace(/\s+$/, '');
        if (nl.trim() && !nl.trim().startsWith('#')) {
          nextLine = nl;
          break;
        }
      }
      const nextIndent = nextLine.search(/\S/);
      const nextTrimmed = nextLine.trim();
      if (nextTrimmed.startsWith('- ') && nextIndent > indent) {
        // This key starts an array
        const arr: unknown[] = [];
        currentObj[key] = arr;
        arrayStack.push({ arr, key, _indent: indent });
      } else {
        const nested: Record<string, unknown> = {};
        currentObj[key] = nested;
        stack.push({ obj: nested, indent });
      }
    } else if (valueStr.startsWith('[') && valueStr.endsWith(']')) {
      currentObj[key] = valueStr
        .slice(1, -1)
        .split(',')
        .map((s) => parseYamlValue(s.trim()))
        .filter((s) => s !== '');
    } else {
      currentObj[key] = parseYamlValue(valueStr);
    }
  }

  return result;
}

function parseYamlValue(value: string): unknown {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null' || value === '~') return null;
  const num = Number(value);
  if (!isNaN(num) && value !== '') return num;
  if (
    (value.startsWith("'") && value.endsWith("'")) ||
    (value.startsWith('"') && value.endsWith('"'))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function serializeYamlValue(value: unknown): string {
  if (typeof value === 'string') {
    if (value.includes('\n') || value.includes(':') || value.includes('#')) {
      return `'${value.replace(/'/g, "''")}'`;
    }
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === null || value === undefined) return '~';
  return String(value);
}

function serializeToYaml(obj: Record<string, unknown>, indent = 0): string {
  const pad = '  '.repeat(indent);
  const lines: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    if (value === null || value === undefined) continue;
    if (Array.isArray(value)) {
      if (value.length === 0) {
        lines.push(`${pad}${key}: []`);
      } else if (value.every((v) => typeof v !== 'object' || v === null)) {
        const items = value.map((v) => serializeYamlValue(v)).join(', ');
        lines.push(`${pad}${key}: [${items}]`);
      } else {
        lines.push(`${pad}${key}:`);
        for (const item of value) {
          if (typeof item === 'object' && item !== null) {
            lines.push(`${pad}-`);
            for (const [ik, iv] of Object.entries(item as Record<string, unknown>)) {
              lines.push(`${pad}  ${ik}: ${serializeYamlValue(iv)}`);
            }
          } else {
            lines.push(`${pad}- ${serializeYamlValue(item)}`);
          }
        }
      }
    } else if (typeof value === 'object' && value !== null) {
      lines.push(`${pad}${key}:`);
      lines.push(serializeToYaml(value as Record<string, unknown>, indent + 1));
    } else {
      lines.push(`${pad}${key}: ${serializeYamlValue(value)}`);
    }
  }
  return lines.join('\n');
}

/**
 * Parse a SKILL.md file (YAML frontmatter + markdown body).
 * Returns the frontmatter as a structured object and the body as a string.
 */
function parseSkillMd(
  content: string,
): { frontmatter: Record<string, unknown>; body: string } | null {
  const trimmed = content.trimStart();
  if (!trimmed.startsWith('---')) return null;

  const endIdx = trimmed.indexOf('---', 3);
  if (endIdx === -1) return null;

  const yamlBlock = trimmed.slice(3, endIdx).trim();
  const body = trimmed.slice(endIdx + 3).trim();

  return {
    frontmatter: parseYamlFrontmatter(yamlBlock),
    body,
  };
}

/**
 * Convert agentskills.io frontmatter (snake_case) to internal Skill type.
 */
function frontmatterToSkill(name: string, fm: Record<string, unknown>, body: string): Skill {
  const meta = (fm.metadata as Record<string, unknown>) ?? {};
  const now = new Date().toISOString();
  const allowedTools = fm['allowed-tools'];
  return {
    id: (fm.name as string) ?? name,
    name: (fm.name as string) ?? name,
    description: (fm.description as string) ?? '',
    content: body,
    tools: typeof allowedTools === 'string' ? allowedTools.split(/\s+/).filter(Boolean) : [],
    metadata: {
      category: (meta.category as Skill['metadata']['category']) ?? 'general',
      tags: (meta.tags as string[]) ?? [],
      source: (meta.source as Skill['metadata']['source']) ?? 'learned',
      qualityScore: (meta.quality_score as number) ?? 0.5,
      usageCount: (meta.usage_count as number) ?? 0,
      avgSuccessRate: (meta.avg_success_rate as number) ?? 0.5,
      autoGenerated: (meta.auto_generated as boolean) ?? false,
      pinned: (meta.pinned as boolean) ?? false,
      generatedFrom: meta.generated_from as string | undefined,
      createdAt: now,
      updatedAt: now,
    },
  };
}

/**
 * Convert internal Skill to SKILL.md format with YAML frontmatter.
 */
function skillToMarkdown(skill: Skill): string {
  const fm: Record<string, unknown> = {
    name: skill.name,
    description: skill.description,
    license: 'MIT',
    compatibility: 'commander',
    version: '1.0',
    metadata: {
      category: skill.metadata.category,
      tags: skill.metadata.tags,
      source: skill.metadata.source,
      quality_score: skill.metadata.qualityScore,
      usage_count: skill.metadata.usageCount,
      avg_success_rate: skill.metadata.avgSuccessRate,
      auto_generated: skill.metadata.autoGenerated,
      pinned: skill.metadata.pinned,
      generated_from: skill.metadata.generatedFrom,
    },
    'allowed-tools': skill.tools.length > 0 ? skill.tools.join(' ') : undefined,
  };

  const yaml = serializeToYaml(fm);
  return `---\n${yaml}\n---\n\n${skill.content}`;
}

export class SkillStore {
  private readonly skillsDir: string;

  constructor(skillsDir?: string) {
    this.skillsDir = skillsDir ?? SKILLS_DIR;
    this.ensureDir();
  }

  private ensureDir(): void {
    if (!fs.existsSync(this.skillsDir)) {
      fs.mkdirSync(this.skillsDir, { recursive: true });
    }
  }

  private skillDir(name: string): string {
    return path.join(this.skillsDir, sanitizeName(name));
  }

  /** Public accessor for SkillCurator to get the skill directory path. */
  getSkillPath(name: string): string {
    return this.skillDir(name);
  }

  private skillMdPath(name: string): string {
    return path.join(this.skillDir(name), 'SKILL.md');
  }

  async save(skill: Skill): Promise<void> {
    if (!validateSkillName(skill.name)) {
      throw new Error(
        `Invalid skill name "${skill.name}": must be 1-64 chars, lowercase alphanumeric with hyphens`,
      );
    }
    checkBodyLength(skill.content);
    this.ensureDir();
    const dir = this.skillDir(skill.name);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const content = skillToMarkdown(skill);
    fs.writeFileSync(this.skillMdPath(skill.name), content, 'utf-8');
  }

  async load(name: string): Promise<Skill | null> {
    try {
      const fp = this.skillMdPath(name);
      if (!fs.existsSync(fp)) return null;
      const raw = fs.readFileSync(fp, 'utf-8');
      const parsed = parseSkillMd(raw);
      if (!parsed) return null;
      return frontmatterToSkill(name, parsed.frontmatter, parsed.body);
    } catch (e) {
      getGlobalLogger().warn('SkillStore', `Failed to load skill "${name}"`, {
        error: (e as Error)?.message,
      });
      return null;
    }
  }

  async delete(name: string): Promise<boolean> {
    try {
      const dir = this.skillDir(name);
      if (!fs.existsSync(dir)) return false;
      fs.rmSync(dir, { recursive: true, force: true });
      return true;
    } catch (err) {
      reportSilentFailure(err, 'skillStore:299');
      return false;
    }
  }

  async list(): Promise<string[]> {
    this.ensureDir();
    try {
      return fs.readdirSync(this.skillsDir).filter((f) => {
        try {
          return fs.statSync(path.join(this.skillsDir, f)).isDirectory();
        } catch (err) {
          reportSilentFailure(err, 'skillStore:311');
          return false;
        }
      });
    } catch (err) {
      reportSilentFailure(err, 'skillStore:316');
      return [];
    }
  }

  async exists(name: string): Promise<boolean> {
    return fs.existsSync(this.skillMdPath(name));
  }

  async loadAll(): Promise<Skill[]> {
    const names = await this.list();
    const results: Skill[] = [];
    for (const name of names) {
      const skill = await this.load(name);
      if (skill) results.push(skill);
    }
    return results;
  }

  /**
   * Migrate from old JSON skill format to new SKILL.md format.
   * Old format: .commander_skills/<name>.json or .commander/skills/<name>.json
   * Returns count of migrated skills.
   */
  async migrateFromJson(): Promise<number> {
    let migrated = 0;
    const jsonDirs = [
      path.join(process.cwd(), '.commander_skills'),
      path.join(process.cwd(), '.commander', 'skills'),
    ];

    for (const dir of jsonDirs) {
      if (!fs.existsSync(dir)) continue;
      const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
      for (const file of files) {
        const name = file.replace(/\.json$/, '');
        // Skip if already migrated
        if (await this.exists(name)) continue;
        try {
          const data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8'));
          const skill: Skill = {
            id: name,
            name: data.name ?? name,
            description: data.description ?? '',
            content: data.prompt ?? '',
            tools: data.tools ?? [],
            metadata: {
              category: 'general',
              tags: [],
              source: 'learned',
              qualityScore: 0.5,
              usageCount: data.usageCount ?? 0,
              avgSuccessRate: 0.5,
              autoGenerated: false,
              pinned: false,
              createdAt: data.createdAt ?? new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
          };
          await this.save(skill);
          migrated++;
        } catch (e) {
          getGlobalLogger().warn('SkillStore', `Migration failed for "${name}"`, {
            error: (e as Error)?.message,
          });
        }
      }
    }
    return migrated;
  }
}

function sanitizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/** Validate skill name per agentskills.io spec: 1-64 chars, lowercase alphanumeric + hyphens. */
function validateSkillName(name: string): boolean {
  return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(name) && name.length >= 1 && name.length <= 64;
}

/** Warn if SKILL.md body exceeds spec recommendation (500 lines / 5000 tokens). */
function checkBodyLength(body: string): void {
  const lines = body.split('\n').length;
  const tokens = body.split(/\s+/).length;
  if (lines > 500 || tokens > 5000) {
    getGlobalLogger().warn(
      'SkillStore',
      `Skill body exceeds recommended limits: ${lines} lines, ${tokens} tokens (max 500 lines / 5000 tokens)`,
    );
  }
}
