"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.captureProvenance = captureProvenance;
exports.createRunProvenance = createRunProvenance;
const child_process_1 = require("child_process");
const logging_1 = require("../logging");
function captureProvenance() {
    let commitHash = 'unknown';
    let branch = 'unknown';
    let dirty = false;
    try {
        commitHash = (0, child_process_1.execSync)('git rev-parse HEAD', { encoding: 'utf-8', timeout: 3000 }).trim();
        branch = (0, child_process_1.execSync)('git rev-parse --abbrev-ref HEAD', {
            encoding: 'utf-8',
            timeout: 3000,
        }).trim();
        const status = (0, child_process_1.execSync)('git status --porcelain', { encoding: 'utf-8', timeout: 3000 }).trim();
        dirty = status.length > 0;
    }
    catch {
        (0, logging_1.getGlobalLogger)().debug('Provenance', 'Not in a git repo or git not available');
    }
    return {
        git: { commitHash, branch, dirty },
        system: {
            nodeVersion: process.version,
            platform: process.platform,
            arch: process.arch,
        },
    };
}
function createRunProvenance(runId, model, tags) {
    const base = captureProvenance();
    return {
        runId,
        timestamp: new Date().toISOString(),
        ...base,
        model,
        tags: tags !== null && tags !== void 0 ? tags : {},
    };
}
