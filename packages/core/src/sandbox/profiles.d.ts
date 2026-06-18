import type { SandboxProfile } from './types';
export declare const READ_ONLY: SandboxProfile;
export declare const WORKSPACE_WRITE: SandboxProfile;
export declare const FULL_ACCESS: SandboxProfile;
/**
 * HARDENED — Default-deny network, only LLM API domains allowed via proxy.
 * Recommended for production use. Agent runs in Docker with:
 *   - Read-only root filesystem
 *   - Network: only configured LLM API domains via HTTP CONNECT proxy
 *   - All other network access blocked
 *   - Memory limit: 512MB
 */
export declare const HARDENED: SandboxProfile;
export declare const PROFILES: Record<string, SandboxProfile>;
//# sourceMappingURL=profiles.d.ts.map