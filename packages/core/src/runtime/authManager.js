"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.AuthManager = exports.ROLE_HIERARCHY = void 0;
exports.getAuthManager = getAuthManager;
exports.resetAuthManager = resetAuthManager;
/**
 * Authentication & Authorization Manager
 *
 * User management, RBAC roles, and API key lifecycle management.
 * File-based persistence using .commander/auth.json.
 * Uses built-in crypto only — no external dependencies.
 */
const crypto = __importStar(require("crypto"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const logging_1 = require("../logging");
const securityAuditLogger_1 = require("../security/securityAuditLogger");
exports.ROLE_HIERARCHY = {
    viewer: 1,
    operator: 2,
    admin: 3,
};
// ── Constants ──────────────────────────────────────────────────────
const AUTH_FILE = path.join(process.cwd(), '.commander', 'auth.json');
const KEY_BYTES = 32; // 256-bit API keys
// ── Manager ────────────────────────────────────────────────────────
class AuthManager {
    constructor() {
        this.users = new Map();
        this.idIndex = new Map();
        /** Rate limiting: track failed auth attempts per IP/session */
        this.failedAttempts = new Map();
        this.load();
    }
    // ── User CRUD ────────────────────────────────────────────────────
    createUser(username, role = 'viewer') {
        if (this.users.has(username)) {
            throw new Error(`User already exists: ${username}`);
        }
        const now = new Date().toISOString();
        const user = {
            id: `user_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            username,
            role,
            apiKeys: [],
            createdAt: now,
            updatedAt: now,
            enabled: true,
        };
        this.users.set(username, user);
        this.idIndex.set(user.id, user);
        this.save();
        (0, logging_1.getGlobalLogger)().info('AuthManager', 'User created', { username, role });
        return user;
    }
    getUser(username) {
        return this.users.get(username);
    }
    getUserById(id) {
        return this.idIndex.get(id);
    }
    updateUser(username, updates) {
        const user = this.users.get(username);
        if (!user)
            return null;
        if (updates.role)
            user.role = updates.role;
        if (updates.enabled !== undefined)
            user.enabled = updates.enabled;
        user.updatedAt = new Date().toISOString();
        this.save();
        (0, logging_1.getGlobalLogger)().info('AuthManager', 'User updated', {
            username,
            updates: Object.keys(updates),
        });
        return user;
    }
    deleteUser(username) {
        const user = this.users.get(username);
        if (!user)
            return false;
        this.users.delete(username);
        this.idIndex.delete(user.id);
        this.save();
        (0, logging_1.getGlobalLogger)().info('AuthManager', 'User deleted', { username });
        return true;
    }
    listUsers() {
        return Array.from(this.users.values());
    }
    // ── API Key Management ───────────────────────────────────────────
    generateApiKey(username, keyName = 'default', expiresInDays) {
        const user = this.users.get(username);
        if (!user)
            throw new Error(`User not found: ${username}`);
        if (!user.enabled)
            throw new Error(`User disabled: ${username}`);
        const rawKey = `cmdr_${crypto.randomBytes(KEY_BYTES).toString('base64url')}`;
        const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
        const now = new Date().toISOString();
        const entry = {
            keyHash,
            name: keyName,
            createdAt: now,
            keyPrefix: rawKey.slice(-4),
            expiresAt: expiresInDays
                ? new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000).toISOString()
                : undefined,
        };
        user.apiKeys.push(entry);
        user.updatedAt = now;
        this.save();
        (0, logging_1.getGlobalLogger)().info('AuthManager', 'API key generated', { username, keyName });
        return { rawKey, entry };
    }
    rotateApiKey(username, keyHash, keyName, expiresInDays) {
        const user = this.users.get(username);
        if (!user)
            return null;
        const idx = user.apiKeys.findIndex((k) => k.keyHash === keyHash);
        if (idx === -1)
            return null;
        user.apiKeys.splice(idx, 1);
        this.save();
        return this.generateApiKey(username, keyName !== null && keyName !== void 0 ? keyName : 'rotated', expiresInDays);
    }
    revokeApiKey(username, keyHash) {
        const user = this.users.get(username);
        if (!user)
            return false;
        const idx = user.apiKeys.findIndex((k) => k.keyHash === keyHash);
        if (idx === -1)
            return false;
        user.apiKeys.splice(idx, 1);
        user.updatedAt = new Date().toISOString();
        this.save();
        (0, logging_1.getGlobalLogger)().info('AuthManager', 'API key revoked', { username });
        return true;
    }
    listApiKeys(username) {
        var _a, _b;
        return (_b = (_a = this.users.get(username)) === null || _a === void 0 ? void 0 : _a.apiKeys) !== null && _b !== void 0 ? _b : [];
    }
    // ── Authentication ───────────────────────────────────────────────
    /**
     * Authenticate a raw API key. Returns the user and role if valid.
     * The raw key is hashed and compared against stored hashes using
     * timing-safe comparison to prevent timing attacks.
     */
    authenticate(rawKey) {
        var _a;
        const audit = (0, securityAuditLogger_1.getSecurityAuditLogger)();
        // Rate limiting: check failed attempts
        const rateLimitKey = 'global'; // In a networked context, use IP address
        const attempts = this.failedAttempts.get(rateLimitKey);
        if (attempts && attempts.count >= AuthManager.MAX_FAILED_ATTEMPTS) {
            const elapsed = Date.now() - attempts.lastAttempt;
            if (elapsed < AuthManager.RATE_LIMIT_WINDOW_MS) {
                (0, logging_1.getGlobalLogger)().warn('AuthManager', 'Rate limit exceeded for authentication', {
                    attempts: attempts.count,
                });
                audit.logAuthRateLimit('AuthManager', `Rate limit exceeded (${attempts.count} attempts)`, {
                    attempts: attempts.count,
                });
                return null;
            }
            // Reset after window expires
            this.failedAttempts.delete(rateLimitKey);
        }
        const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
        const keyHashBuf = Buffer.from(keyHash, 'hex');
        for (const user of this.users.values()) {
            if (!user.enabled)
                continue;
            const match = user.apiKeys.find((k) => {
                // Timing-safe comparison: constant-time regardless of where mismatch occurs
                if (k.keyHash.length !== keyHash.length)
                    return false;
                try {
                    if (!crypto.timingSafeEqual(Buffer.from(k.keyHash, 'hex'), keyHashBuf))
                        return false;
                }
                catch {
                    return false;
                }
                if (k.expiresAt && new Date(k.expiresAt) < new Date())
                    return false;
                return true;
            });
            if (match) {
                // Clear failed attempts on success
                this.failedAttempts.delete(rateLimitKey);
                match.lastUsedAt = new Date().toISOString();
                this.save();
                audit.logAuthSuccess('AuthManager', `User authenticated: ${user.username}`, {
                    username: user.username,
                    role: user.role,
                    keyName: match.name,
                });
                return { user, role: user.role };
            }
        }
        // Track failed attempt
        const current = this.failedAttempts.get(rateLimitKey);
        const newCount = ((_a = current === null || current === void 0 ? void 0 : current.count) !== null && _a !== void 0 ? _a : 0) + 1;
        this.failedAttempts.set(rateLimitKey, {
            count: newCount,
            lastAttempt: Date.now(),
        });
        audit.logAuthFailure('AuthManager', 'Invalid API key presented', {
            keyPrefix: rawKey.slice(0, 4) + '...',
            failedAttempts: newCount,
        });
        return null;
    }
    /**
     * Check if a role has sufficient permission for a required role.
     */
    hasPermission(userRole, requiredRole) {
        var _a, _b;
        return ((_a = exports.ROLE_HIERARCHY[userRole]) !== null && _a !== void 0 ? _a : 0) >= ((_b = exports.ROLE_HIERARCHY[requiredRole]) !== null && _b !== void 0 ? _b : 0);
    }
    /**
     * Require a minimum role. Throws if insufficient.
     */
    requireRole(userRole, requiredRole) {
        if (!this.hasPermission(userRole, requiredRole)) {
            throw new Error(`Insufficient permissions. Required: ${requiredRole}, has: ${userRole}`);
        }
    }
    // ── Persistence ──────────────────────────────────────────────────
    save() {
        try {
            const dir = path.dirname(AUTH_FILE);
            if (!fs.existsSync(dir))
                fs.mkdirSync(dir, { recursive: true });
            const data = { users: Array.from(this.users.values()) };
            fs.writeFileSync(AUTH_FILE, JSON.stringify(data, null, 2));
        }
        catch (err) {
            (0, logging_1.getGlobalLogger)().error('AuthManager', 'Failed to save auth data', err);
        }
    }
    load() {
        try {
            if (!fs.existsSync(AUTH_FILE))
                return;
            const data = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf-8'));
            if (data.users && Array.isArray(data.users)) {
                for (const user of data.users) {
                    this.users.set(user.username, user);
                    this.idIndex.set(user.id, user);
                }
            }
        }
        catch (err) {
            (0, logging_1.getGlobalLogger)().error('AuthManager', 'Failed to load auth data', err);
        }
    }
    /** Total user count */
    getStats() {
        const roles = { admin: 0, operator: 0, viewer: 0 };
        let totalKeys = 0;
        for (const user of this.users.values()) {
            roles[user.role]++;
            totalKeys += user.apiKeys.length;
        }
        return { totalUsers: this.users.size, totalKeys, roles };
    }
}
exports.AuthManager = AuthManager;
AuthManager.MAX_FAILED_ATTEMPTS = 10;
AuthManager.RATE_LIMIT_WINDOW_MS = 60000; // 1 minute
// ── Singleton ──────────────────────────────────────────────────────
const tenantAwareSingleton_1 = require("./tenantAwareSingleton");
const authManagerSingleton = (0, tenantAwareSingleton_1.createTenantAwareSingleton)(() => new AuthManager());
function getAuthManager() {
    return authManagerSingleton.get();
}
function resetAuthManager() {
    authManagerSingleton.reset();
}
