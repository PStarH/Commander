/**
 * Skill Installer — Install skills from external sources.
 *
 * Supports three installation methods:
 *   1. Git: commander skill install github:user/repo
 *   2. npm: commander skill install @scope/skill-name
 *   3. Local: commander skill install ./path/to/skill
 *
 * Skills are installed to ~/.commander/skills/<name>/SKILL.md
 * (OpenClaw-compatible directory structure).
 *
 * Also supports scanning for skills in:
 *   - ~/.commander/skills/ (user-global)
 *   - .commander/skills/ (project-local)
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getGlobalLogger } from '../logging';

// ============================================================================
// Constants
// ============================================================================

const GLOBAL_SKILLS_DIR = path.join(os.homedir(), '.commander', 'skills');
const PROJECT_SKILLS_DIR = path.join(process.cwd(), '.commander', 'skills');

// ============================================================================
// Skill Metadata (from SKILL.md frontmatter)
// ============================================================================

/** OpenClaw-compatible SKILL.md frontmatter */
export interface SkillInstallMetadata {
  name: string;
  description: string;
  version?: string;
  author?: string;
  license?: string;
  /** Tools this skill is allowed to use (e.g., "web_search web_fetch file_write") */
  'allowed-tools'?: string;
  /** Hint for command arguments (e.g., "<topic>", "[file...]") */
  'argument-hint'?: string;
  metadata?: {
    category?: string;
    tags?: string[];
    source?: string;
    quality_score?: number;
  };
}

/** A discovered/installed skill */
export interface InstalledSkill {
  name: string;
  directory: string;
  metadata: SkillInstallMetadata;
  content: string;
  source: 'builtin' | 'git' | 'npm' | 'local' | 'global';
  installedAt?: string;
}

// ============================================================================
// Frontmatter Parser (enhanced for OpenClaw compatibility)
// ============================================================================

/**
 * Minimal YAML frontmatter parser.
 * Handles the subset used in SKILL.md files.
 */
function parseFrontmatter(
  content: string,
): { metadata: Record<string, unknown>; body: string } | null {
  const trimmed = content.trimStart();
  if (!trimmed.startsWith('---')) return null;

  const endIdx = trimmed.indexOf('---', 3);
  if (endIdx === -1) return null;

  const yamlBlock = trimmed.slice(3, endIdx).trim();
  const body = trimmed.slice(endIdx + 3).trim();

  return { metadata: parseSimpleYaml(yamlBlock), body };
}

function parseSimpleYaml(yaml: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = yaml.split('\n');
  const stack: Array<{ obj: Record<string, unknown>; indent: number }> = [
    { obj: result, indent: -1 },
  ];

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;

    const indent = line.search(/\S/);
    const trimmed = line.trim();

    // Handle array items
    if (trimmed.startsWith('- ')) {
      // Find parent key context
      if (stack.length > 1) {
        const parent = stack[stack.length - 1].obj;
        const keys = Object.keys(parent);
        const lastKey = keys[keys.length - 1];
        if (lastKey && Array.isArray(parent[lastKey])) {
          (parent[lastKey] as unknown[]).push(parseValue(trimmed.slice(2)));
          continue;
        }
      }
      continue;
    }

    const colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) continue;

    const key = trimmed.slice(0, colonIdx).trim();
    const valueStr = trimmed.slice(colonIdx + 1).trim();

    // Pop stack for lower indentation
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
      stack.pop();
    }

    const currentObj = stack[stack.length - 1].obj;

    if (valueStr === '') {
      // Check if next line is array or object
      const lineIdx = lines.indexOf(rawLine);
      let nextLine = '';
      for (let li = lineIdx + 1; li < lines.length; li++) {
        const nl = lines[li].replace(/\s+$/, '');
        if (nl.trim() && !nl.trim().startsWith('#')) {
          nextLine = nl;
          break;
        }
      }
      const nextTrimmed = nextLine.trim();
      if (nextTrimmed.startsWith('- ')) {
        currentObj[key] = [];
      } else {
        const nested: Record<string, unknown> = {};
        currentObj[key] = nested;
        stack.push({ obj: nested, indent });
      }
    } else if (valueStr.startsWith('[') && valueStr.endsWith(']')) {
      currentObj[key] = valueStr
        .slice(1, -1)
        .split(',')
        .map((s) => parseValue(s.trim()))
        .filter((s) => s !== '');
    } else {
      currentObj[key] = parseValue(valueStr);
    }
  }

  return result;
}

function parseValue(value: string): unknown {
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

// ============================================================================
// Skill Discovery
// ============================================================================

/**
 * Scan a directory for skills (SKILL.md files).
 */
function scanSkillDir(dir: string, source: InstalledSkill['source']): InstalledSkill[] {
  if (!fs.existsSync(dir)) return [];

  const skills: InstalledSkill[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const skillDir = path.join(dir, entry.name);
    const skillMdPath = path.join(skillDir, 'SKILL.md');

    if (!fs.existsSync(skillMdPath)) continue;

    try {
      const content = fs.readFileSync(skillMdPath, 'utf-8');
      const parsed = parseFrontmatter(content);

      if (parsed) {
        const meta = parsed.metadata;
        skills.push({
          name: (meta.name as string) ?? entry.name,
          directory: skillDir,
          metadata: {
            name: (meta.name as string) ?? entry.name,
            description: (meta.description as string) ?? '',
            version: meta.version as string | undefined,
            author: meta.author as string | undefined,
            license: meta.license as string | undefined,
            'allowed-tools': meta['allowed-tools'] as string | undefined,
            'argument-hint': meta['argument-hint'] as string | undefined,
            metadata: meta.metadata as SkillInstallMetadata['metadata'],
          },
          content: parsed.body,
          source,
        });
      }
    } catch (e) {
      getGlobalLogger().warn(
        'SkillInstaller',
        `Failed to parse ${skillMdPath}: ${(e as Error).message}`,
      );
    }
  }

  return skills;
}

/**
 * Discover all installed skills from all scan directories.
 */
export function discoverAllSkills(): InstalledSkill[] {
  const skills: InstalledSkill[] = [];

  // Project-local skills (highest priority)
  skills.push(...scanSkillDir(PROJECT_SKILLS_DIR, 'builtin'));

  // User-global skills
  const projectNames = new Set(skills.map((s) => s.name));
  for (const skill of scanSkillDir(GLOBAL_SKILLS_DIR, 'global')) {
    if (!projectNames.has(skill.name)) {
      skills.push(skill);
    }
  }

  return skills;
}

/**
 * Find a skill by name across all directories.
 */
export function findSkill(name: string): InstalledSkill | null {
  // Check project-local first
  const projectPath = path.join(PROJECT_SKILLS_DIR, name, 'SKILL.md');
  if (fs.existsSync(projectPath)) {
    const skills = scanSkillDir(PROJECT_SKILLS_DIR, 'builtin');
    const found = skills.find((s) => s.name === name);
    if (found) return found;
  }

  // Then check global
  const globalPath = path.join(GLOBAL_SKILLS_DIR, name, 'SKILL.md');
  if (fs.existsSync(globalPath)) {
    const skills = scanSkillDir(GLOBAL_SKILLS_DIR, 'global');
    const found = skills.find((s) => s.name === name);
    if (found) return found;
  }

  return null;
}

// ============================================================================
// Skill Installation
// ============================================================================

/**
 * Install a skill from a local directory.
 */
export async function installFromLocal(
  sourceDir: string,
  targetName?: string,
): Promise<InstalledSkill> {
  const skillMdPath = path.join(sourceDir, 'SKILL.md');
  if (!fs.existsSync(skillMdPath)) {
    throw new Error(`No SKILL.md found in ${sourceDir}`);
  }

  const content = fs.readFileSync(skillMdPath, 'utf-8');
  const parsed = parseFrontmatter(content);
  const name = targetName ?? (parsed?.metadata?.name as string) ?? path.basename(sourceDir);

  const targetDir = path.join(GLOBAL_SKILLS_DIR, name);
  if (!fs.existsSync(GLOBAL_SKILLS_DIR)) {
    fs.mkdirSync(GLOBAL_SKILLS_DIR, { recursive: true });
  }

  // Copy the entire skill directory
  if (fs.existsSync(targetDir)) {
    fs.rmSync(targetDir, { recursive: true, force: true });
  }
  fs.cpSync(sourceDir, targetDir, { recursive: true });

  getGlobalLogger().info('SkillInstaller', `Installed skill "${name}" from ${sourceDir}`);

  return {
    name,
    directory: targetDir,
    metadata: parsed
      ? {
          name: (parsed.metadata.name as string) ?? name,
          description: (parsed.metadata.description as string) ?? '',
          version: parsed.metadata.version as string | undefined,
          author: parsed.metadata.author as string | undefined,
        }
      : { name, description: '' },
    content: parsed?.body ?? '',
    source: 'local',
    installedAt: new Date().toISOString(),
  };
}

/**
 * Install a skill from a git repository.
 */
export async function installFromGit(gitUrl: string, targetName?: string): Promise<InstalledSkill> {
  const { execFile } = await import('child_process');

  // Extract repo name from URL
  const repoName = gitUrl.split('/').pop()?.replace('.git', '') ?? 'unknown-skill';
  const tempDir = path.join(os.tmpdir(), `commander-skill-${Date.now()}`);

  try {
    // Clone to temp directory
    await new Promise<void>((resolve, reject) => {
      execFile(
        'git',
        ['clone', '--depth', '1', gitUrl, tempDir],
        {
          timeout: 60000,
        },
        (err) => {
          if (err) reject(new Error(`git clone failed: ${err.message}`));
          else resolve();
        },
      );
    });

    // Install from the cloned directory
    return await installFromLocal(tempDir, targetName ?? repoName);
  } finally {
    // Cleanup temp directory
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

/**
 * Install a skill from npm.
 */
export async function installFromNpm(
  packageName: string,
  targetName?: string,
): Promise<InstalledSkill> {
  // Validate package name
  const SAFE_NAME = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*(@[a-z0-9-~.+^]+)?$/;
  if (!SAFE_NAME.test(packageName)) {
    throw new Error(`Invalid package name: "${packageName}"`);
  }

  const { execFile } = await import('child_process');
  const tempDir = path.join(os.tmpdir(), `commander-skill-npm-${Date.now()}`);

  try {
    // Install to temp directory
    await new Promise<void>((resolve, reject) => {
      execFile(
        'npm',
        ['install', '--no-save', '--ignore-scripts', '--prefix', tempDir, packageName],
        {
          timeout: 120000,
          maxBuffer: 10 * 1024 * 1024,
        },
        (err) => {
          if (err) reject(new Error(`npm install failed: ${err.message}`));
          else resolve();
        },
      );
    });

    // Find the installed package
    const nodeModulesDir = path.join(tempDir, 'node_modules', packageName);
    if (fs.existsSync(nodeModulesDir)) {
      return await installFromLocal(nodeModulesDir, targetName ?? packageName.replace(/.*\//, ''));
    }

    throw new Error(`Package "${packageName}" not found after npm install`);
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

/**
 * Uninstall a skill by name.
 */
export function uninstallSkill(name: string): boolean {
  const globalDir = path.join(GLOBAL_SKILLS_DIR, name);
  if (fs.existsSync(globalDir)) {
    fs.rmSync(globalDir, { recursive: true, force: true });
    getGlobalLogger().info('SkillInstaller', `Uninstalled skill "${name}"`);
    return true;
  }
  return false;
}

/**
 * List all installed skills with their metadata.
 */
export function listInstalledSkills(): InstalledSkill[] {
  return discoverAllSkills();
}
