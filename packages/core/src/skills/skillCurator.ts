import { reportSilentFailure } from '../silentFailureReporter';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { CuratorReport, SkillCatalogEntry, Skill } from './types';
import type { SkillManager } from './skillManager';
import { getGlobalLogger } from '../logging';

// ============================================================================
// Similarity scoring configuration
// ============================================================================

export interface SimilarityWeights {
  nameWeight: number; // how much name similarity counts
  descWeight: number; // how much description similarity counts
  tagWeight: number; // how much tag overlap counts
  threshold: number; // minimum combined score to consider "similar" (0-1)
}

const DEFAULT_SIMILARITY_WEIGHTS: SimilarityWeights = {
  nameWeight: 0.35,
  descWeight: 0.25,
  tagWeight: 0.4,
  threshold: 0.3,
};

export type MergeStrategy = 'keep_highest_quality' | 'llm_merge';

export interface MergeResult {
  survivor: string;
  archived: string[];
}

// ============================================================================
// Similarity computation (pure functions, easy to test)
// ============================================================================

/**
 * Jaccard similarity of two string arrays.
 * Returns 0 if both are empty, otherwise |intersection| / |union|.
 */
export function jaccardSimilarity(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let intersection = 0;
  for (const item of setA) {
    if (setB.has(item)) intersection++;
  }
  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Tokenize a string into lowercase word tokens.
 */
function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1);
}

/**
 * Bigram set from a string.
 */
function bigrams(s: string): Set<string> {
  const tokens = tokenize(s);
  const result = new Set<string>();
  for (let i = 0; i < tokens.length - 1; i++) {
    result.add(`${tokens[i]} ${tokens[i + 1]}`);
  }
  // Also add individual tokens for short names
  for (const t of tokens) {
    result.add(t);
  }
  return result;
}

/**
 * Name similarity: Jaccard of bigrams.
 */
export function nameSimilarity(a: string, b: string): number {
  const bigramsA = bigrams(a);
  const bigramsB = bigrams(b);
  if (bigramsA.size === 0 && bigramsB.size === 0) return 0;

  let intersection = 0;
  for (const bg of bigramsA) {
    if (bigramsB.has(bg)) intersection++;
  }
  const union = new Set([...bigramsA, ...bigramsB]).size;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Description similarity: fraction of shared words (Jaccard on words).
 */
export function descriptionSimilarity(a: string, b: string): number {
  return jaccardSimilarity(tokenize(a), tokenize(b));
}

/**
 * Tag similarity: Jaccard on tag arrays.
 */
export function tagSimilarity(a: string[], b: string[]): number {
  return jaccardSimilarity(a, b);
}

/**
 * Combined weighted similarity score between two catalog entries.
 */
export function computeSimilarity(
  a: SkillCatalogEntry,
  b: SkillCatalogEntry,
  weights: SimilarityWeights = DEFAULT_SIMILARITY_WEIGHTS,
): number {
  const nameSim = nameSimilarity(a.name, b.name);
  const descSim = descriptionSimilarity(a.description, b.description);
  const tagSim = tagSimilarity(a.tags, b.tags);

  return nameSim * weights.nameWeight + descSim * weights.descWeight + tagSim * weights.tagWeight;
}

/**
 * Build similarity matrix for a list of entries (upper triangle).
 * Returns pairs with score >= threshold.
 */
export function findSimilarPairs(
  entries: SkillCatalogEntry[],
  weights: SimilarityWeights = DEFAULT_SIMILARITY_WEIGHTS,
): Array<[SkillCatalogEntry, SkillCatalogEntry, number]> {
  const pairs: Array<[SkillCatalogEntry, SkillCatalogEntry, number]> = [];

  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const score = computeSimilarity(entries[i], entries[j], weights);
      if (score >= weights.threshold) {
        pairs.push([entries[i], entries[j], score]);
      }
    }
  }

  return pairs.sort((a, b) => b[2] - a[2]); // highest similarity first
}

/**
 * Build an LLM merge prompt for combining two similar skills.
 */
export function buildMergePrompt(survivor: Skill, duplicate: Skill): string {
  return [
    'You are merging two similar skills into one comprehensive skill.',
    'Keep the best parts of both, remove redundancy, and produce a single cohesive skill.',
    'Return ONLY the merged skill content as markdown. Do NOT include YAML frontmatter.',
    '',
    '--- Primary skill (keep its identity) ---',
    `Name: ${survivor.name}`,
    `Description: ${survivor.description}`,
    '',
    survivor.content,
    '',
    '--- Duplicate skill (merge useful parts from this) ---',
    `Name: ${duplicate.name}`,
    `Description: ${duplicate.description}`,
    '',
    duplicate.content,
  ].join('\n');
}

export class SkillCurator {
  private manager: SkillManager;
  private readonly QUALITY_THRESHOLD = 0.3;
  private readonly MIN_USAGE_THRESHOLD = 2;
  private readonly MAX_SKILLS = 200;
  private readonly STALE_AFTER_DAYS = 30;
  private readonly ARCHIVE_AFTER_DAYS = 90;
  private readonly archiveDir: string;
  private readonly backupDir: string;
  private mergeStrategy: MergeStrategy = 'keep_highest_quality';
  private llmMerger?: (prompt: string) => Promise<string | null>;

  constructor(manager: SkillManager, archiveDir?: string, backupDir?: string) {
    this.manager = manager;
    this.archiveDir = archiveDir ?? path.join(process.cwd(), '.commander', 'skills', '.archive');
    this.backupDir = backupDir ?? path.join(process.cwd(), '.commander', 'skills', '.backups');
  }

  /** Enable LLM-based merge for skill consolidation. */
  setLLMMerger(
    merger: (prompt: string) => Promise<string | null>,
    strategy: MergeStrategy = 'llm_merge',
  ): void {
    this.llmMerger = merger;
    this.mergeStrategy = strategy;
  }

  async curate(): Promise<CuratorReport> {
    const now = new Date().toISOString();
    const report: CuratorReport = {
      archived: [],
      pruned: [],
      consolidated: [],
      qualityDropped: [],
      totalBefore: 0,
      totalAfter: 0,
      snapshotPath: undefined,
      runTimestamp: now,
      totalArchived: 0,
    };

    // Create pre-run snapshot
    try {
      report.snapshotPath = await this.createSnapshot();
    } catch (err) {
      reportSilentFailure(err, 'skillCurator:216');
      getGlobalLogger().warn('SkillCurator', 'Snapshot creation failed (best-effort)');
    }

    const catalog = await this.manager.list();
    report.totalBefore = catalog.length;

    // Phase 1: Archive low-quality + low-usage skills instead of deleting
    for (const entry of catalog) {
      if (entry.pinned) continue;
      if (
        entry.qualityScore < this.QUALITY_THRESHOLD &&
        entry.usageCount < this.MIN_USAGE_THRESHOLD
      ) {
        await this.archive(entry.name);
        report.archived.push(entry.name);
      }
    }

    // Phase 2: Consolidate similar skills using weighted similarity scoring
    const grouped = this.groupSimilar(catalog.filter((e) => !e.pinned));
    for (const group of grouped) {
      const result = await this.mergeSimilar(group, this.mergeStrategy, this.llmMerger);
      report.consolidated.push(...result.archived);
    }

    // Phase 3: Enforce max skills limit — archive lowest-usage
    const finalCatalog = await this.manager.list();
    report.totalAfter = finalCatalog.length;
    const unpinned = finalCatalog.filter((e) => !e.pinned);
    if (unpinned.length > this.MAX_SKILLS) {
      const toArchive = unpinned
        .sort((a, b) => a.usageCount - b.usageCount)
        .slice(0, unpinned.length - this.MAX_SKILLS);
      for (const entry of toArchive) {
        await this.archive(entry.name);
        report.archived.push(entry.name);
      }
      report.totalAfter = finalCatalog.length - toArchive.length;
    }

    report.totalArchived = report.archived.length;
    return report;
  }

  async archive(name: string): Promise<boolean> {
    try {
      const sourceDir = this.manager.getSkillPath(name);
      if (!fs.existsSync(sourceDir)) return false;

      const destDir = path.join(this.archiveDir, name);
      if (!fs.existsSync(this.archiveDir)) {
        fs.mkdirSync(this.archiveDir, { recursive: true });
      }
      if (fs.existsSync(destDir)) {
        const ts = Date.now();
        fs.renameSync(sourceDir, `${destDir}.${ts}`);
      } else {
        fs.renameSync(sourceDir, destDir);
      }
      return true;
    } catch (e) {
      getGlobalLogger().warn('SkillCurator', `Failed to archive skill "${name}"`, {
        error: (e as Error)?.message,
      });
      return false;
    }
  }

  async restore(name: string): Promise<boolean> {
    try {
      const archivedPath = path.join(this.archiveDir, name);
      if (!fs.existsSync(archivedPath)) return false;

      const destDir = this.manager.getSkillPath(name);
      if (fs.existsSync(destDir)) return false;

      if (!fs.existsSync(path.dirname(destDir))) {
        fs.mkdirSync(path.dirname(destDir), { recursive: true });
      }
      fs.renameSync(archivedPath, destDir);
      return true;
    } catch (e) {
      getGlobalLogger().warn('SkillCurator', `Failed to restore skill "${name}"`, {
        error: (e as Error)?.message,
      });
      return false;
    }
  }

  async listArchived(): Promise<string[]> {
    try {
      if (!fs.existsSync(this.archiveDir)) return [];
      return fs.readdirSync(this.archiveDir).filter((f) => {
        const stat = fs.statSync(path.join(this.archiveDir, f));
        return stat.isDirectory();
      });
    } catch (e) {
      getGlobalLogger().warn('SkillCurator', 'listArchived failed', {
        error: (e as Error)?.message,
      });
      return [];
    }
  }

  private async createSnapshot(): Promise<string> {
    const skillsDir = path.resolve(path.join(process.cwd(), '.commander', 'skills'));
    if (!fs.existsSync(skillsDir)) return '';

    if (!fs.existsSync(this.backupDir)) {
      fs.mkdirSync(this.backupDir, { recursive: true });
    }

    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const snapshotPath = path.join(this.backupDir, `skills-${ts}.tar.gz`);

    const execFileAsync = promisify(execFile);
    const parentDir = path.dirname(skillsDir);
    const baseName = path.basename(skillsDir);

    try {
      await execFileAsync('tar', ['-czf', snapshotPath, '-C', parentDir, baseName], {
        timeout: 30000,
      });
    } catch (err) {
      reportSilentFailure(err, 'skillCurator:341');
      try {
        await execFileAsync('zip', ['-rq', snapshotPath, baseName], {
          cwd: parentDir,
          timeout: 30000,
        });
      } catch (err) {
        reportSilentFailure(err, 'skillCurator:348');
        getGlobalLogger().warn('SkillCurator', 'Snapshot creation failed with both tar and zip');
        return '';
      }
    }

    this.rotateBackups();
    return snapshotPath;
  }

  private rotateBackups(): void {
    try {
      if (!fs.existsSync(this.backupDir)) return;
      const backups = fs
        .readdirSync(this.backupDir)
        .filter((f) => f.startsWith('skills-'))
        .sort()
        .reverse();
      if (backups.length > 5) {
        for (const old of backups.slice(5)) {
          fs.rmSync(path.join(this.backupDir, old), { force: true });
        }
      }
    } catch (e) {
      getGlobalLogger().warn('SkillCurator', 'rotateBackups failed', {
        error: (e as Error)?.message,
      });
    }
  }

  /**
   * Group similar entries using weighted similarity scoring.
   * Uses a greedy clustering approach: highest-similarity pairs are grouped first,
   * then the cluster expands to include any entry similar to any member.
   */
  private groupSimilar(
    entries: SkillCatalogEntry[],
    weights: SimilarityWeights = DEFAULT_SIMILARITY_WEIGHTS,
  ): SkillCatalogEntry[][] {
    const pairs = findSimilarPairs(entries, weights);
    if (pairs.length === 0) return [];

    // Build adjacency from pairs
    const adjacency = new Map<string, SkillCatalogEntry[]>();
    const entryMap = new Map<string, SkillCatalogEntry>();
    for (const e of entries) {
      entryMap.set(e.name, e);
      adjacency.set(e.name, []);
    }
    for (const [a, b] of pairs) {
      adjacency.get(a.name)!.push(b);
      adjacency.get(b.name)!.push(a);
    }

    // Greedy clustering via BFS
    const visited = new Set<string>();
    const groups: SkillCatalogEntry[][] = [];

    for (const entry of entries) {
      if (visited.has(entry.name)) continue;

      const cluster: SkillCatalogEntry[] = [];
      const queue = [entry];
      visited.add(entry.name);

      while (queue.length > 0) {
        const current = queue.shift()!;
        cluster.push(current);

        for (const neighbor of adjacency.get(current.name) ?? []) {
          if (!visited.has(neighbor.name)) {
            visited.add(neighbor.name);
            queue.push(neighbor);
          }
        }
      }

      if (cluster.length > 1) {
        groups.push(cluster);
      }
    }

    return groups;
  }

  /**
   * Merge a group of similar skills using the configured strategy.
   * Default strategy: keep the highest-quality skill, archive the rest.
   * LLM merge strategy: use an LLM to merge content, keeping the best name.
   */
  async mergeSimilar(
    group: SkillCatalogEntry[],
    strategy: MergeStrategy = 'keep_highest_quality',
    llmMerger?: (prompt: string) => Promise<string | null>,
  ): Promise<MergeResult> {
    if (group.length <= 1) {
      return { survivor: group[0]?.name ?? '', archived: [] };
    }

    const sorted = [...group].sort((a, b) => b.qualityScore - a.qualityScore);
    const survivor = sorted[0];

    if (strategy === 'keep_highest_quality' || !llmMerger) {
      const toArchive = sorted.slice(1);
      for (const dup of toArchive) {
        await this.archive(dup.name);
      }
      return {
        survivor: survivor.name,
        archived: toArchive.map((e) => e.name),
      };
    }

    // LLM merge: try to merge content of the top-2 quality skills
    const primary = await this.manager.get(sorted[0].name);
    const secondary = await this.manager.get(sorted[1].name);
    if (!primary || !secondary) {
      // Fallback to keep-highest-quality
      const toArchive = sorted.slice(1);
      for (const dup of toArchive) {
        await this.archive(dup.name);
      }
      return {
        survivor: survivor.name,
        archived: toArchive.map((e) => e.name),
      };
    }

    const prompt = buildMergePrompt(primary, secondary);
    try {
      const mergedContent = await llmMerger(prompt);
      if (mergedContent) {
        await this.manager.update(survivor.name, { content: mergedContent } as Partial<Skill>);
      }
    } catch (err) {
      reportSilentFailure(err, 'skillCurator:483');
      // LLM merge failed — archive the secondary, keep primary
    }

    const toArchive = sorted.slice(1);
    for (const dup of toArchive) {
      await this.archive(dup.name);
    }
    return {
      survivor: survivor.name,
      archived: toArchive.map((e) => e.name),
    };
  }
}
