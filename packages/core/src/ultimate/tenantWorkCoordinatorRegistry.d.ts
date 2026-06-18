import { WorkCoordinator } from './workCoordinator';
export declare class TenantWorkCoordinatorRegistry {
    private entries;
    private basePath;
    constructor(basePath?: string);
    getWorkCoordinator(tenantId: string): WorkCoordinator;
    hasTenant(tenantId: string): boolean;
    listTenants(): string[];
    size(): number;
    closeAll(): void;
    private storePathFor;
}
export declare function getTenantWorkCoordinatorRegistry(basePath?: string): TenantWorkCoordinatorRegistry;
export declare function resetTenantWorkCoordinatorRegistry(): void;
//# sourceMappingURL=tenantWorkCoordinatorRegistry.d.ts.map