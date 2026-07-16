import type { MemoryDuration, MemoryKind } from '../episodicMemory';
import type { MemoryService } from './memoryService';

export interface LegacyMemoryRecord {
  sourceId: string;
  tenantId?: string;
  projectId: string;
  missionId?: string;
  agentId?: string;
  kind: MemoryKind;
  duration?: MemoryDuration;
  title: string;
  content: string;
  tags?: string[];
  priority?: number;
  confidence?: number;
  expiresAt?: string;
  evidenceRefs?: string[];
  meta?: Record<string, unknown>;
}

export interface MemoryMigrationSource {
  sourceName: string;
  listRecords(): AsyncIterable<LegacyMemoryRecord>;
}

export interface MemoryMigrationCheckpointStore {
  load(sourceName: string): Promise<string | undefined>;
  save(sourceName: string, sourceId: string): Promise<void>;
}

export interface MemoryMigrationResult {
  imported: number;
  skipped: number;
  failed: number;
  checkpoint?: string;
}

export type TenantMapping = (record: LegacyMemoryRecord) => string | undefined;

export class MemoryMigrationRunner {
  constructor(
    private readonly service: Pick<MemoryService, 'store'>,
    private readonly source: MemoryMigrationSource,
    private readonly checkpoints: MemoryMigrationCheckpointStore,
    private readonly mapTenant: TenantMapping,
  ) {}

  async run(): Promise<MemoryMigrationResult> {
    const checkpoint = await this.checkpoints.load(this.source.sourceName);
    let skippingCheckpoint = checkpoint !== undefined;
    let imported = 0;
    let skipped = 0;
    let failed = 0;
    let lastCheckpoint = checkpoint;

    for await (const record of this.source.listRecords()) {
      if (skippingCheckpoint) {
        skipped++;
        if (record.sourceId === checkpoint) skippingCheckpoint = false;
        continue;
      }

      const tenantId = this.mapTenant(record);
      if (!tenantId) {
        failed++;
        throw new Error(
          `memory migration tenant mapping is required for source ${this.source.sourceName}:${record.sourceId}`,
        );
      }

      try {
        await this.service.store({
          scope: { tenantId, projectId: record.projectId },
          id: record.sourceId,
          missionId: record.missionId,
          agentId: record.agentId,
          kind: record.kind,
          duration: record.duration,
          title: record.title,
          content: record.content,
          tags: record.tags,
          priority: record.priority,
          confidence: record.confidence,
          expiresAt: record.expiresAt,
          evidenceRefs: record.evidenceRefs,
          meta: {
            ...(record.meta ?? {}),
            source: this.source.sourceName,
            sourceId: record.sourceId,
          },
        });
      } catch (error) {
        failed++;
        throw error;
      }
      imported++;
      lastCheckpoint = record.sourceId;
      await this.checkpoints.save(this.source.sourceName, record.sourceId);
    }

    return { imported, skipped, failed, checkpoint: lastCheckpoint };
  }
}
