export type AuthRole = 'admin' | 'operator' | 'viewer';
export declare const ROLE_HIERARCHY: Record<AuthRole, number>;
export interface ApiKeyEntry {
    /** SHA-256 hash of the actual key (we never store raw keys) */
    keyHash: string;
    /** Human-readable name for this key (e.g. "CI/CD pipeline") */
    name: string;
    createdAt: string;
    expiresAt?: string;
    /** Last 4 chars of the raw key for identification */
    keyPrefix: string;
    lastUsedAt?: string;
}
export interface AuthUser {
    id: string;
    username: string;
    role: AuthRole;
    apiKeys: ApiKeyEntry[];
    createdAt: string;
    updatedAt: string;
    enabled: boolean;
}
export interface AuthData {
    users: AuthUser[];
}
export declare class AuthManager {
    private users;
    private idIndex;
    /** Rate limiting: track failed auth attempts per IP/session */
    private failedAttempts;
    private static readonly MAX_FAILED_ATTEMPTS;
    private static readonly RATE_LIMIT_WINDOW_MS;
    constructor();
    createUser(username: string, role?: AuthRole): AuthUser;
    getUser(username: string): AuthUser | undefined;
    getUserById(id: string): AuthUser | undefined;
    updateUser(username: string, updates: {
        role?: AuthRole;
        enabled?: boolean;
        username?: string;
    }): AuthUser | null;
    deleteUser(username: string): boolean;
    listUsers(): AuthUser[];
    generateApiKey(username: string, keyName?: string, expiresInDays?: number): {
        rawKey: string;
        entry: ApiKeyEntry;
    };
    rotateApiKey(username: string, keyHash: string, keyName?: string, expiresInDays?: number): {
        rawKey: string;
        entry: ApiKeyEntry;
    } | null;
    revokeApiKey(username: string, keyHash: string): boolean;
    listApiKeys(username: string): ApiKeyEntry[];
    /**
     * Authenticate a raw API key. Returns the user and role if valid.
     * The raw key is hashed and compared against stored hashes using
     * timing-safe comparison to prevent timing attacks.
     */
    authenticate(rawKey: string): {
        user: AuthUser;
        role: AuthRole;
    } | null;
    /**
     * Check if a role has sufficient permission for a required role.
     */
    hasPermission(userRole: AuthRole, requiredRole: AuthRole): boolean;
    /**
     * Require a minimum role. Throws if insufficient.
     */
    requireRole(userRole: AuthRole, requiredRole: AuthRole): void;
    private save;
    private load;
    /** Total user count */
    getStats(): {
        totalUsers: number;
        totalKeys: number;
        roles: Record<AuthRole, number>;
    };
}
export declare function getAuthManager(): AuthManager;
export declare function resetAuthManager(): void;
//# sourceMappingURL=authManager.d.ts.map