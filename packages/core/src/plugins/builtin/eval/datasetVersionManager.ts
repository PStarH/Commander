// ─────────────────────────────────────────────────────────────────────────────
// DatasetVersionManager
//
// Versioned dataset management with SQLite persistence.
// Each modification creates a new immutable version — old versions are
// preserved for rollback and audit. Supports JSON Lines import/export
// compatible with Langfuse dataset format.
// ─────────────────────────────────────────────────────────────────────────────

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { mkdirSync, existsSync } from 'node:fs';
import {
  assertSameTenant,
  getCurrentTenantId,
  validateTenantId,
} from '../../../runtime/tenantContext';

// ============================================================================
// Types
// ============================================================================

export interface DatasetCase {
  id: string;
  input: string;
  expectedOutput?: string;
  metadata?: Record<string, unknown>;
}

export interface DatasetVersion {
  versionId: string;
  versionNumber: number;
  createdAt: string;
  createdBy?: string;
  changeDescription?: string;
  caseCount: number;
  /** Snapshot of cases at this version (lazy-loaded) */
  cases?: DatasetCase[];
}

export interface VersionedDataset {
  id: string;
  name: string;
  description?: string;
  currentVersion: number;
  versions: DatasetVersion[];
  createdAt: string;
  updatedAt: string;
  tags?: string[];
}

export interface CreateDatasetInput {
  name: string;
  description?: string;
  tags?: string[];
  cases: DatasetCase[];
}

export interface AddCasesInput {
  datasetId: string;
  cases: DatasetCase[];
  changeDescription?: string;
}

export interface ExportResult {
  format: 'jsonl';
  datasetId: string;
  datasetName: string;
  version: number;
  exportedAt: string;
  caseCount: number;
  cases: DatasetCase[];
}

// ============================================================================
// DatasetVersionManager
// ============================================================================

export class DatasetVersionManager {
  private datasets: Map<string, VersionedDataset> = new Map();
  private versionCases: Map<string, DatasetCase[]> = new Map(); // versionId → cases
  private datasetTenants: Map<string, string> = new Map();
  private dbPath: string | null;

  constructor(options?: { dbPath?: string; persistenceDir?: string }) {
    this.dbPath =
      options?.dbPath ??
      (options?.persistenceDir ? path.join(options.persistenceDir, 'datasets.json') : null);

    if (this.dbPath) {
      const dir = path.dirname(this.dbPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      this.loadFromDisk();
    }
  }

  /**
   * Create a new versioned dataset with initial cases.
   */
  create(input: CreateDatasetInput, tenantId?: string): VersionedDataset {
    const ownerTenant = this.resolveTenant(tenantId);
    const datasetId = randomUUID();
    const now = new Date().toISOString();
    const versionId = randomUUID();

    const version: DatasetVersion = {
      versionId,
      versionNumber: 1,
      createdAt: now,
      changeDescription: 'Initial creation',
      caseCount: input.cases.length,
    };

    const dataset: VersionedDataset = {
      id: datasetId,
      name: input.name,
      description: input.description,
      currentVersion: 1,
      versions: [version],
      createdAt: now,
      updatedAt: now,
      tags: input.tags,
    };

    this.datasets.set(datasetId, dataset);
    this.datasetTenants.set(datasetId, ownerTenant);
    this.versionCases.set(versionId, [...input.cases]);
    this.saveToDisk();

    return dataset;
  }

  /**
   * Add cases to a dataset, creating a new version.
   * Old version is preserved for rollback.
   */
  addCases(input: AddCasesInput, tenantId?: string): VersionedDataset {
    const ownerTenant = this.resolveTenant(tenantId);
    const dataset = this.datasets.get(input.datasetId);
    if (!dataset || this.datasetTenants.get(input.datasetId) !== ownerTenant) {
      throw new Error(`Dataset not found: ${input.datasetId}`);
    }

    // Get current version's cases
    const currentVersion = dataset.versions[dataset.versions.length - 1];
    const currentCases = this.versionCases.get(currentVersion.versionId) ?? [];

    // Create new version with merged cases
    const newVersionNumber = dataset.currentVersion + 1;
    const newVersionId = randomUUID();
    const now = new Date().toISOString();

    const mergedCases = [...currentCases, ...input.cases];

    const newVersion: DatasetVersion = {
      versionId: newVersionId,
      versionNumber: newVersionNumber,
      createdAt: now,
      changeDescription: input.changeDescription ?? `Added ${input.cases.length} case(s)`,
      caseCount: mergedCases.length,
    };

    dataset.versions.push(newVersion);
    dataset.currentVersion = newVersionNumber;
    dataset.updatedAt = now;
    this.versionCases.set(newVersionId, mergedCases);
    this.saveToDisk();

    return dataset;
  }

  /**
   * Rollback to a specific version. Creates a new version that
   * copies the cases from the target version (forward-only rollback).
   */
  rollback(datasetId: string, targetVersion: number, tenantId?: string): VersionedDataset {
    const ownerTenant = this.resolveTenant(tenantId);
    const dataset = this.datasets.get(datasetId);
    if (!dataset || this.datasetTenants.get(datasetId) !== ownerTenant) {
      throw new Error(`Dataset not found: ${datasetId}`);
    }

    const targetVersionData = dataset.versions.find((v) => v.versionNumber === targetVersion);
    if (!targetVersionData) {
      throw new Error(`Version ${targetVersion} not found`);
    }

    const targetCases = this.versionCases.get(targetVersionData.versionId) ?? [];

    // Create new version with the rolled-back cases
    const newVersionNumber = dataset.currentVersion + 1;
    const newVersionId = randomUUID();
    const now = new Date().toISOString();

    const newVersion: DatasetVersion = {
      versionId: newVersionId,
      versionNumber: newVersionNumber,
      createdAt: now,
      changeDescription: `Rollback to version ${targetVersion}`,
      caseCount: targetCases.length,
    };

    dataset.versions.push(newVersion);
    dataset.currentVersion = newVersionNumber;
    dataset.updatedAt = now;
    this.versionCases.set(newVersionId, [...targetCases]);
    this.saveToDisk();

    return dataset;
  }

  /**
   * Get a dataset by ID, with the current version's cases loaded.
   */
  get(datasetId: string, tenantId?: string): VersionedDataset | undefined {
    const ownerTenant = this.resolveTenant(tenantId);
    const dataset = this.datasets.get(datasetId);
    if (!dataset || this.datasetTenants.get(datasetId) !== ownerTenant) return undefined;

    // Load current version cases
    const currentVersion = dataset.versions[dataset.versions.length - 1];
    const cases = this.versionCases.get(currentVersion.versionId);
    if (cases && dataset.versions.length > 0) {
      dataset.versions[dataset.versions.length - 1].cases = cases;
    }

    return dataset;
  }

  /**
   * Get cases for a specific version of a dataset.
   */
  getCases(datasetId: string, versionNumber?: number, tenantId?: string): DatasetCase[] {
    const ownerTenant = this.resolveTenant(tenantId);
    const dataset = this.datasets.get(datasetId);
    if (!dataset || this.datasetTenants.get(datasetId) !== ownerTenant) return [];

    const version = versionNumber
      ? dataset.versions.find((v) => v.versionNumber === versionNumber)
      : dataset.versions[dataset.versions.length - 1];

    if (!version) return [];
    return this.versionCases.get(version.versionId) ?? [];
  }

  /**
   * List all datasets (without loading cases).
   */
  list(tenantId?: string): VersionedDataset[] {
    const ownerTenant = this.resolveTenant(tenantId);
    return [...this.datasets.entries()]
      .filter(([datasetId]) => this.datasetTenants.get(datasetId) === ownerTenant)
      .map(([, dataset]) => dataset);
  }

  /**
   * Delete a dataset and all its versions.
   */
  delete(datasetId: string, tenantId?: string): boolean {
    const ownerTenant = this.resolveTenant(tenantId);
    const dataset = this.datasets.get(datasetId);
    if (!dataset || this.datasetTenants.get(datasetId) !== ownerTenant) return false;

    // Clean up version cases
    for (const version of dataset.versions) {
      this.versionCases.delete(version.versionId);
    }
    this.datasets.delete(datasetId);
    this.datasetTenants.delete(datasetId);
    this.saveToDisk();
    return true;
  }

  /**
   * Export a dataset version to JSON Lines format
   * (compatible with Langfuse dataset import).
   */
  export(datasetId: string, versionNumber?: number, tenantId?: string): ExportResult {
    const ownerTenant = this.resolveTenant(tenantId);
    const dataset = this.datasets.get(datasetId);
    if (!dataset || this.datasetTenants.get(datasetId) !== ownerTenant) {
      throw new Error(`Dataset not found: ${datasetId}`);
    }

    const version = versionNumber
      ? dataset.versions.find((v) => v.versionNumber === versionNumber)
      : dataset.versions[dataset.versions.length - 1];

    if (!version) {
      throw new Error(`Version not found`);
    }

    const cases = this.versionCases.get(version.versionId) ?? [];

    return {
      format: 'jsonl',
      datasetId: dataset.id,
      datasetName: dataset.name,
      version: version.versionNumber,
      exportedAt: new Date().toISOString(),
      caseCount: cases.length,
      cases,
    };
  }

  /**
   * Import cases from JSON Lines format (Langfuse-compatible).
   * Creates a new dataset or adds to an existing one.
   */
  import(
    name: string,
    cases: DatasetCase[],
    options?: { description?: string; datasetId?: string },
    tenantId?: string,
  ): VersionedDataset {
    if (options?.datasetId) {
      // Add to existing dataset
      return this.addCases(
        {
          datasetId: options.datasetId,
          cases,
          changeDescription: `Imported ${cases.length} case(s)`,
        },
        tenantId,
      );
    }

    // Create new dataset
    return this.create(
      {
        name,
        description: options?.description,
        cases,
      },
      tenantId,
    );
  }

  // ── Persistence ──────────────────────────────────────────────────────

  private saveToDisk(): void {
    if (!this.dbPath) return;

    try {
      const data = {
        datasets: [...this.datasets.values()],
        versionCases: Object.fromEntries(this.versionCases),
        datasetTenants: Object.fromEntries(this.datasetTenants),
      };
      const fs = require('node:fs');
      const tmp = this.dbPath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(data), { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmp, this.dbPath);
    } catch {
      // Persistence is best-effort — don't crash the runtime
    }
  }

  private loadFromDisk(): void {
    if (!this.dbPath || !existsSync(this.dbPath)) return;

    try {
      const fs = require('node:fs');
      const raw = fs.readFileSync(this.dbPath, 'utf8');
      const data = JSON.parse(raw);

      for (const dataset of data.datasets ?? []) {
        this.datasets.set(dataset.id, dataset);
        const ownerTenant = data.datasetTenants?.[dataset.id] ?? '__default__';
        this.datasetTenants.set(dataset.id, ownerTenant);
      }
      for (const [versionId, cases] of Object.entries(data.versionCases ?? {})) {
        this.versionCases.set(versionId, cases as DatasetCase[]);
      }
    } catch {
      // Corrupt or missing — start fresh
    }
  }

  private resolveTenant(explicitTenantId?: string): string {
    if (explicitTenantId) {
      validateTenantId(explicitTenantId);
      assertSameTenant(explicitTenantId);
      return explicitTenantId;
    }
    return getCurrentTenantId() ?? '__default__';
  }
}

// ============================================================================
// Singleton
// ============================================================================

let globalDatasetManager: DatasetVersionManager | null = null;

export function getGlobalDatasetManager(options?: { dbPath?: string }): DatasetVersionManager {
  if (!globalDatasetManager) {
    const dbPath =
      options?.dbPath ??
      (typeof process !== 'undefined'
        ? path.join(process.cwd(), '.commander_state', 'eval-datasets.json')
        : undefined);
    globalDatasetManager = new DatasetVersionManager({ dbPath });
  }
  return globalDatasetManager;
}
