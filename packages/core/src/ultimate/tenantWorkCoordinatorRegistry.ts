import { getGlobalLogger } from '../logging';
import { WorkCoordinator } from './workCoordinator';
import { SqliteWorkQueueStore } from './sqliteWorkQueueStore';

const DEFAULT_BASE_PATH = '.commander/queues';

interface TenantEntry {
  coord: WorkCoordinator;
  store: SqliteWorkQueueStore;
}

export class TenantWorkCoordinatorRegistry {
  private entries = new Map<string, TenantEntry>();
  private basePath: string;

  constructor(basePath?: string) {
    this.basePath = basePath ?? DEFAULT_BASE_PATH;
  }

  getWorkCoordinator(tenantId: string): WorkCoordinator {
    const entry = this.entries.get(tenantId);
    if (entry) return entry.coord;
    const store = new SqliteWorkQueueStore({ filePath: this.storePathFor(tenantId) });
    const coord = new WorkCoordinator({ store });
    this.entries.set(tenantId, { coord, store });
    getGlobalLogger().info('TenantWorkCoordinatorRegistry', 'Created per-tenant WorkCoordinator', {
      tenantId,
      storePath: this.storePathFor(tenantId),
    });
    return coord;
  }

  hasTenant(tenantId: string): boolean {
    return this.entries.has(tenantId);
  }

  listTenants(): string[] {
    return Array.from(this.entries.keys());
  }

  size(): number {
    return this.entries.size;
  }

  closeAll(): void {
    for (const [tenantId, entry] of this.entries) {
      try {
        entry.coord.clear();
        entry.store.close();
      } catch (err) {
        getGlobalLogger().debug('TenantWorkCoordinatorRegistry', 'closeAll error', {
          tenantId,
          error: (err as Error).message,
        });
      }
    }
    this.entries.clear();
  }

  private storePathFor(tenantId: string): string {
    const safe = tenantId.replace(/[^a-zA-Z0-9_.-]/g, '_');
    return `${this.basePath}/tenant_${safe}/work_queue.db`;
  }
}

let singleton: TenantWorkCoordinatorRegistry | null = null;

export function getTenantWorkCoordinatorRegistry(basePath?: string): TenantWorkCoordinatorRegistry {
  if (basePath !== undefined) {
    if (singleton) singleton.closeAll();
    singleton = new TenantWorkCoordinatorRegistry(basePath);
    return singleton;
  }
  if (!singleton) singleton = new TenantWorkCoordinatorRegistry();
  return singleton;
}

export function resetTenantWorkCoordinatorRegistry(): void {
  if (singleton) singleton.closeAll();
  singleton = null;
}
