"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getDeadLetterQueue = getDeadLetterQueue;
exports.resetDeadLetterQueue = resetDeadLetterQueue;
/**
 * DeadLetterQueue singleton accessor. Other modules (e.g. SubAgentExecutor)
 * that don't have a runtime-injected DLQ can use this to obtain a process-wide
 * one. Backed by createTenantAwareSingleton for parity with IntentLog, etc.
 */
const tenantAwareSingleton_1 = require("./tenantAwareSingleton");
const deadLetterQueue_1 = require("./deadLetterQueue");
const dlqSingleton = (0, tenantAwareSingleton_1.createTenantAwareSingleton)(() => new deadLetterQueue_1.DeadLetterQueue());
function getDeadLetterQueue(tenantId) {
    if (tenantId)
        return dlqSingleton.getForTenant(tenantId);
    return dlqSingleton.get();
}
function resetDeadLetterQueue() {
    dlqSingleton.reset();
}
