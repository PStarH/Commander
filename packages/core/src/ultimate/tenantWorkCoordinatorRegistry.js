"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TenantWorkCoordinatorRegistry = void 0;
exports.getTenantWorkCoordinatorRegistry = getTenantWorkCoordinatorRegistry;
exports.resetTenantWorkCoordinatorRegistry = resetTenantWorkCoordinatorRegistry;
const logging_1 = require("../logging");
const workCoordinator_1 = require("./workCoordinator");
const sqliteWorkQueueStore_1 = require("./sqliteWorkQueueStore");
const DEFAULT_BASE_PATH = '.commander/queues';
class TenantWorkCoordinatorRegistry {
    constructor(basePath) {
        this.entries = new Map();
        this.basePath = basePath !== null && basePath !== void 0 ? basePath : DEFAULT_BASE_PATH;
    }
    getWorkCoordinator(tenantId) {
        const entry = this.entries.get(tenantId);
        if (entry)
            return entry.coord;
        const store = new sqliteWorkQueueStore_1.SqliteWorkQueueStore({ filePath: this.storePathFor(tenantId) });
        const coord = new workCoordinator_1.WorkCoordinator({ store });
        this.entries.set(tenantId, { coord, store });
        (0, logging_1.getGlobalLogger)().info('TenantWorkCoordinatorRegistry', 'Created per-tenant WorkCoordinator', {
            tenantId,
            storePath: this.storePathFor(tenantId),
        });
        return coord;
    }
    hasTenant(tenantId) {
        return this.entries.has(tenantId);
    }
    listTenants() {
        return Array.from(this.entries.keys());
    }
    size() {
        return this.entries.size;
    }
    closeAll() {
        for (const [tenantId, entry] of this.entries) {
            try {
                entry.coord.clear();
                entry.store.close();
            }
            catch (err) {
                (0, logging_1.getGlobalLogger)().debug('TenantWorkCoordinatorRegistry', 'closeAll error', {
                    tenantId,
                    error: err.message,
                });
            }
        }
        this.entries.clear();
    }
    storePathFor(tenantId) {
        const safe = tenantId.replace(/[^a-zA-Z0-9_.-]/g, '_');
        return `${this.basePath}/tenant_${safe}/work_queue.db`;
    }
}
exports.TenantWorkCoordinatorRegistry = TenantWorkCoordinatorRegistry;
let singleton = null;
function getTenantWorkCoordinatorRegistry(basePath) {
    if (basePath !== undefined) {
        if (singleton)
            singleton.closeAll();
        singleton = new TenantWorkCoordinatorRegistry(basePath);
        return singleton;
    }
    if (!singleton)
        singleton = new TenantWorkCoordinatorRegistry();
    return singleton;
}
function resetTenantWorkCoordinatorRegistry() {
    if (singleton)
        singleton.closeAll();
    singleton = null;
}
