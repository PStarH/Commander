"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SandboxManager = void 0;
exports.getSandboxManager = getSandboxManager;
exports.resetSandboxManager = resetSandboxManager;
const platforms_1 = require("./platforms");
const profiles_1 = require("./profiles");
const logging_1 = require("../logging");
class SandboxManager {
    constructor() {
        this.sandboxes = [];
        this.noop = new platforms_1.NoopSB();
        this.sandboxes = (0, platforms_1.discoverSandboxes)();
        if (this.sandboxes.length === 0) {
            (0, logging_1.getGlobalLogger)().debug('SandboxManager', 'No OS-level sandbox available, using noop fallback');
        }
    }
    getAvailableMechanisms() {
        return this.sandboxes.map((s) => s.name);
    }
    hasSandbox() {
        return this.sandboxes.length > 0;
    }
    getSandbox(mechanism) {
        var _a, _b, _c;
        if (mechanism) {
            const found = this.sandboxes.find((s) => s.name === mechanism);
            if (found)
                return found;
            // SECURITY FIX: warn on silent fallback instead of quietly using NoopSB
            (0, logging_1.getGlobalLogger)().warn('SandboxManager', `Requested sandbox "${mechanism}" not available, falling back to ${(_b = (_a = this.sandboxes[0]) === null || _a === void 0 ? void 0 : _a.name) !== null && _b !== void 0 ? _b : 'none (UNSANDBOXED)'}`);
        }
        const fallback = (_c = this.sandboxes[0]) !== null && _c !== void 0 ? _c : this.noop;
        if (fallback.name === 'none') {
            (0, logging_1.getGlobalLogger)().warn('SandboxManager', '⚠️  No OS-level sandbox available — commands will run UNSANDBOXED');
        }
        return fallback;
    }
    getProfile(name) {
        if (name && name in profiles_1.PROFILES)
            return profiles_1.PROFILES[name];
        // SECURITY FIX: env var can only select non-full-access profiles (prevents downgrade attack)
        // To use full-access, must be explicitly requested via the `name` parameter
        const envMode = process.env.COMMANDER_SANDBOX_MODE;
        if (envMode && envMode in profiles_1.PROFILES && envMode !== 'full-access') {
            return profiles_1.PROFILES[envMode];
        }
        return profiles_1.PROFILES['workspace-write'];
    }
    async execute(command, profile, workdir, mechanism) {
        const p = typeof profile === 'string' ? this.getProfile(profile) : (profile !== null && profile !== void 0 ? profile : this.getProfile());
        const sb = this.getSandbox(mechanism);
        return sb.execute(command, p, workdir);
    }
}
exports.SandboxManager = SandboxManager;
const tenantAwareSingleton_1 = require("../runtime/tenantAwareSingleton");
const sandboxManagerSingleton = (0, tenantAwareSingleton_1.createTenantAwareSingleton)(() => new SandboxManager());
function getSandboxManager() {
    return sandboxManagerSingleton.get();
}
function resetSandboxManager() {
    sandboxManagerSingleton.reset();
}
