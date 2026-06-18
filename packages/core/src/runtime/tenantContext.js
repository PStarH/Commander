"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runWithTenant = runWithTenant;
exports.getCurrentTenantId = getCurrentTenantId;
exports.hasTenantContext = hasTenantContext;
const async_hooks_1 = require("async_hooks");
const storage = new async_hooks_1.AsyncLocalStorage();
/**
 * Run a function within a tenant context.
 * All getX() singleton calls inside fn() will return tenant-scoped instances.
 */
function runWithTenant(tenantId, fn) {
    return storage.run({ tenantId }, fn);
}
/**
 * Get the current tenant ID from the async context.
 * Returns undefined in single-tenant mode.
 */
function getCurrentTenantId() {
    var _a;
    return (_a = storage.getStore()) === null || _a === void 0 ? void 0 : _a.tenantId;
}
/**
 * Check if we're currently executing in a tenant context.
 */
function hasTenantContext() {
    return storage.getStore() !== undefined;
}
