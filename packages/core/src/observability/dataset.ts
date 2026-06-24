/**
 * P-obs-3: Dataset + DatasetStore (Braintrust-style).
 *
 * A Dataset is a named collection of test cases. Each case has an
 * `input` (the agent's goal), an optional `expected` (what the
 * agent should produce), and a rubric reference. The store is
 * in-memory with optional JSON-file persistence — production
 * deployments can mount a writable volume and call `saveAll()` on
 * shutdown to keep the dataset across restarts.
 *
 * Braintrust parity:
 *  - dataset has id, name, description, rubricId, cases
 *  - case has id, input, expected, metadata, rubricId
 *  - store exposes list/get/create/update/delete + bulk load/save
 */

import * as fs from 'fs';
import * as path from 'path';

export interface DatasetCase {
  /** Unique within the dataset. */
  id: string;
  /** The agent's input (goal + optional context). */
  input: {
    goal: string;
    contextData?: Record<string, unknown>;
    availableTools?: string[];
    maxSteps?: number;
    tokenBudget?: number;
  };
  /** What the agent should produce. */
  expected?: {
    /** Output must contain all of these substrings. */
    outputContains?: string[];
    /** Output must match all of these regular expressions. */
    outputMatches?: string[];
    /** Tool names that must have been called. */
    toolsExpected?: string[];
  };
  /** Free-form metadata for filtering / display. */
  metadata?: Record<string, unknown>;
  /** Per-case rubric override. Falls back to the dataset's rubric. */
  rubricId?: string;
}

export interface Dataset {
  id: string;
  name: string;
  description?: string;
  /** Default rubric for cases that don't override. */
  rubricId: string;
  cases: DatasetCase[];
  createdAt: string;
  updatedAt: string;
}

export interface DatasetStoreConfig {
  /** Optional directory for JSON persistence. When set, `saveAll()` writes here. */
  persistenceDir?: string;
}

/**
 * In-memory dataset store with optional JSON file persistence.
 * Thread-safety: not thread-safe; intended for single-process use.
 */
export class DatasetStore {
  private datasets: Map<string, Dataset> = new Map();
  private readonly persistenceDir: string | undefined;

  constructor(config: DatasetStoreConfig = {}) {
    this.persistenceDir = config.persistenceDir;
    if (this.persistenceDir) {
      try {
        fs.mkdirSync(this.persistenceDir, { recursive: true });
      } catch (err) {
        console.warn('[Catch]', err);
        /* best-effort */
      }
    }
  }

  // ────────── CRUD ──────────

  list(): Dataset[] {
    return Array.from(this.datasets.values()).sort((a, b) =>
      a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0,
    );
  }

  get(id: string): Dataset | undefined {
    return this.datasets.get(id);
  }

  create(input: Omit<Dataset, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }): Dataset {
    const now = new Date().toISOString();
    const dataset: Dataset = {
      id: input.id ?? generateId('ds'),
      name: input.name,
      description: input.description,
      rubricId: input.rubricId,
      cases: input.cases,
      createdAt: now,
      updatedAt: now,
    };
    this.datasets.set(dataset.id, dataset);
    return dataset;
  }

  update(id: string, patch: Partial<Omit<Dataset, 'id' | 'createdAt'>>): Dataset | undefined {
    const existing = this.datasets.get(id);
    if (!existing) return undefined;
    const updated: Dataset = {
      ...existing,
      ...patch,
      id: existing.id, // id is immutable
      createdAt: existing.createdAt, // createdAt is immutable
      updatedAt: new Date().toISOString(),
    };
    this.datasets.set(id, updated);
    return updated;
  }

  delete(id: string): boolean {
    return this.datasets.delete(id);
  }

  // ────────── Persistence ──────────

  /** Write a single dataset to disk. No-op when persistence is disabled. */
  save(id: string): boolean {
    if (!this.persistenceDir) return false;
    const dataset = this.datasets.get(id);
    if (!dataset) return false;
    try {
      const filePath = path.join(this.persistenceDir, `${id}.json`);
      fs.writeFileSync(filePath, JSON.stringify(dataset, null, 2), 'utf-8');
      return true;
    } catch (err) {
      console.warn('[Catch]', err);
      return false;
    }
  }

  /** Write all datasets to disk. */
  saveAll(): number {
    if (!this.persistenceDir) return 0;
    let n = 0;
    for (const id of this.datasets.keys()) {
      if (this.save(id)) n++;
    }
    return n;
  }

  /** Load a dataset from a JSON file and add it to the store. */
  loadFromFile(filePath: string): Dataset | undefined {
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(raw) as Dataset;
      if (!parsed.id || !parsed.rubricId || !Array.isArray(parsed.cases)) return undefined;
      this.datasets.set(parsed.id, parsed);
      return parsed;
    } catch (err) {
      console.warn('[Catch]', err);
      return undefined;
    }
  }

  /** Load every `*.json` file in the persistence directory. */
  loadAllFromDir(): number {
    if (!this.persistenceDir) return 0;
    let n = 0;
    try {
      const files = fs.readdirSync(this.persistenceDir).filter((f) => f.endsWith('.json'));
      for (const f of files) {
        if (this.loadFromFile(path.join(this.persistenceDir, f))) n++;
      }
    } catch (err) {
      console.warn('[Catch]', err);
      /* best-effort */
    }
    return n;
  }

  /** Count of datasets in memory. */
  size(): number {
    return this.datasets.size;
  }
}

/** Simple ID generator: `ds_<timestamp>_<rand>`. */
function generateId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}
