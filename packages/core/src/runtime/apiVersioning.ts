/**
 * API Versioning & Stability Framework
 *
 * Provides:
 *   - Version routing: /api/v1/*, /api/v2/* with backward compatibility
 *   - Deprecation signaling: Deprecation + Sunset headers (RFC 8594 draft)
 *   - Stability tiers: experimental → beta → stable → deprecated
 *   - Version negotiation: URL path (default) + Accept-Version header
 *   - Migration helpers: v1→v2 field mapping, alias resolution
 *
 * Design principles:
 *   - Backward compatible: v1 endpoints keep working after v2 ships
 *   - Deprecation window: minimum 6 months from deprecation to removal
 *   - Semantic versioning for API contract (not info.version)
 *   - All breaking changes require a new major version
 */

import { getGlobalLogger } from '../logging';

// ============================================================================
// Types
// ============================================================================

export type APIStability = 'experimental' | 'beta' | 'stable' | 'deprecated';

export interface APIVersionInfo {
  /** Major version number (1, 2, 3...) */
  major: number;
  /** Stability tier */
  stability: APIStability;
  /** When this version was released */
  releasedAt: string;
  /** When this version will be removed (if deprecated) */
  sunsetAt?: string;
  /** Successor version (if deprecated) */
  successorVersion?: number;
  /** Migration guide URL */
  migrationGuideUrl?: string;
}

export interface EndpointMetadata {
  /** Full path pattern (e.g. '/api/v1/execute') */
  path: string;
  /** HTTP method */
  method: string;
  /** Stability tier */
  stability: APIStability;
  /** API version */
  version: number;
  /** If deprecated, when it will be removed */
  deprecatedSince?: string;
  /** Sunset date (when the endpoint will stop responding) */
  sunsetAt?: string;
  /** Successor endpoint path (if migrated) */
  successorPath?: string;
  /** Brief description */
  description: string;
  /** Whether the endpoint is currently active */
  active: boolean;
}

export interface VersionConfig {
  /** Supported API versions, ordered newest-first */
  versions: APIVersionInfo[];
  /** Default version when none specified */
  defaultVersion: number;
  /** Whether to allow unspecified version (e.g. /api/execute → /api/v1/execute) */
  allowUnversioned: boolean;
}

// ============================================================================
// Default Configuration
// ============================================================================

export const DEFAULT_VERSION_CONFIG: VersionConfig = {
  versions: [
    {
      major: 1,
      stability: 'stable',
      releasedAt: '2025-01-01T00:00:00Z',
    },
  ],
  defaultVersion: 1,
  allowUnversioned: true,
};

// ============================================================================
// API Version Manager
// ============================================================================

export class APIVersionManager {
  private config: VersionConfig;
  private endpoints: Map<string, EndpointMetadata> = new Map();
  private requestCounts: Map<string, number> = new Map();

  constructor(config: VersionConfig = DEFAULT_VERSION_CONFIG) {
    this.config = config;
  }

  /**
   * Register an endpoint with its metadata.
   */
  registerEndpoint(meta: Omit<EndpointMetadata, 'active'> & { active?: boolean }): void {
    const key = `${meta.method.toUpperCase()} ${meta.path}`;
    this.endpoints.set(key, {
      ...meta,
      active: meta.active ?? true,
    });
  }

  /**
   * Get endpoint metadata.
   */
  getEndpoint(method: string, path: string): EndpointMetadata | undefined {
    const key = `${method.toUpperCase()} ${path}`;
    return this.endpoints.get(key);
  }

  /**
   * List all registered endpoints, optionally filtered.
   */
  listEndpoints(filter?: {
    version?: number;
    stability?: APIStability;
    deprecated?: boolean;
  }): EndpointMetadata[] {
    let result = Array.from(this.endpoints.values());
    if (filter?.version !== undefined) {
      result = result.filter((e) => e.version === filter.version);
    }
    if (filter?.stability) {
      result = result.filter((e) => e.stability === filter.stability);
    }
    if (filter?.deprecated !== undefined) {
      result = result.filter((e) =>
        filter.deprecated ? e.stability === 'deprecated' : e.stability !== 'deprecated',
      );
    }
    return result.sort((a, b) => a.path.localeCompare(b.path));
  }

  /**
   * Get version info for a major version.
   */
  getVersionInfo(major: number): APIVersionInfo | undefined {
    return this.config.versions.find((v) => v.major === major);
  }

  /**
   * Get all supported versions.
   */
  getSupportedVersions(): APIVersionInfo[] {
    return this.config.versions;
  }

  /**
   * Check if a version is currently supported.
   */
  isVersionSupported(major: number): boolean {
    const info = this.getVersionInfo(major);
    return info !== undefined && info.stability !== 'deprecated';
  }

  /**
   * Parse the API version from a request path.
   * Returns { version, remainingPath } or null if not an API path.
   *
   * Examples:
   *   /api/v1/execute → { version: 1, remainingPath: '/execute' }
   *   /api/execute    → { version: 1, remainingPath: '/execute' } (if allowUnversioned)
   *   /api/v2/plan    → { version: 2, remainingPath: '/plan' }
   */
  parseVersionFromPath(path: string): { version: number; remainingPath: string } | null {
    // Match /api/v{n}/...
    const versionedMatch = path.match(/^\/api\/v(\d+)(\/.*)?$/);
    if (versionedMatch) {
      return {
        version: parseInt(versionedMatch[1], 10),
        remainingPath: versionedMatch[2] ?? '/',
      };
    }

    // Match /api/... (unversioned → default version)
    if (this.config.allowUnversioned && path.startsWith('/api/')) {
      return {
        version: this.config.defaultVersion,
        remainingPath: path.slice(4), // remove '/api'
      };
    }

    return null;
  }

  /**
   * Build deprecation headers for a deprecated endpoint.
   * Returns headers to add to the response, or empty object if not deprecated.
   *
   * RFC 8594 Sunset header:
   *   Sunset: Sat, 25 Dec 2025 00:00:00 GMT
   *
   * Deprecation header (draft-ietf-httpapi-deprecation-header):
   *   Deprecation: true
   *   Link: </api/v2/execute>; rel="successor-version"
   */
  getDeprecationHeaders(method: string, path: string): Record<string, string> {
    const endpoint = this.getEndpoint(method, path);
    if (!endpoint || endpoint.stability !== 'deprecated') {
      return {};
    }

    const headers: Record<string, string> = {
      'Deprecation': 'true',
      'Warning': `299 - "This endpoint is deprecated and will be removed on ${endpoint.sunsetAt ?? 'a future date'}. Migrate to ${endpoint.successorPath ?? 'the new API version'}."`,
    };

    if (endpoint.sunsetAt) {
      headers['Sunset'] = new Date(endpoint.sunsetAt).toUTCString();
    }

    if (endpoint.successorPath) {
      headers['Link'] = `<${endpoint.successorPath}>; rel="successor-version"`;
    }

    return headers;
  }

  /**
   * Get stability headers for any endpoint.
   * These inform clients about the reliability contract.
   *
   * Custom headers:
   *   X-API-Version: 1
   *   X-API-Stability: stable
   */
  getStabilityHeaders(method: string, path: string): Record<string, string> {
    const endpoint = this.getEndpoint(method, path);
    if (!endpoint) {
      return {};
    }

    return {
      'X-API-Version': String(endpoint.version),
      'X-API-Stability': endpoint.stability,
    };
  }

  /**
   * Record a request for deprecation tracking.
   */
  recordRequest(method: string, path: string): void {
    const key = `${method.toUpperCase()} ${path}`;
    this.requestCounts.set(key, (this.requestCounts.get(key) ?? 0) + 1);
  }

  /**
   * Get usage statistics for deprecated endpoints.
   */
  getDeprecatedUsage(): Array<{ method: string; path: string; requests: number; sunsetAt?: string }> {
    const result: Array<{ method: string; path: string; requests: number; sunsetAt?: string }> = [];
    for (const [key, endpoint] of this.endpoints) {
      if (endpoint.stability === 'deprecated') {
        const [method, path] = key.split(' ');
        result.push({
          method,
          path,
          requests: this.requestCounts.get(key) ?? 0,
          sunsetAt: endpoint.sunsetAt,
        });
      }
    }
    return result.sort((a, b) => b.requests - a.requests);
  }

  /**
   * Mark an endpoint as deprecated.
   */
  deprecateEndpoint(
    method: string,
    path: string,
    options: { sunsetAt: string; successorPath?: string },
  ): boolean {
    const key = `${method.toUpperCase()} ${path}`;
    const endpoint = this.endpoints.get(key);
    if (!endpoint) return false;

    endpoint.stability = 'deprecated';
    endpoint.deprecatedSince = new Date().toISOString();
    endpoint.sunsetAt = options.sunsetAt;
    endpoint.successorPath = options.successorPath;

    getGlobalLogger().info('APIVersionManager', 'Endpoint deprecated', {
      method,
      path,
      sunsetAt: options.sunsetAt,
      successorPath: options.successorPath,
    });

    return true;
  }

  /**
   * Register a new API version.
   */
  registerVersion(info: APIVersionInfo): void {
    // Check if version already exists
    const existing = this.config.versions.find((v) => v.major === info.major);
    if (existing) {
      Object.assign(existing, info);
    } else {
      this.config.versions.push(info);
      this.config.versions.sort((a, b) => b.major - a.major);
    }
  }

  /**
   * Get the default version.
   */
  getDefaultVersion(): number {
    return this.config.defaultVersion;
  }

  /**
   * Reset all state (for testing).
   */
  reset(): void {
    this.endpoints.clear();
    this.requestCounts.clear();
    this.config = { ...DEFAULT_VERSION_CONFIG };
  }
}

// ============================================================================
// Singleton
// ============================================================================

let globalManager: APIVersionManager | null = null;

export function getAPIVersionManager(): APIVersionManager {
  if (!globalManager) {
    globalManager = new APIVersionManager();
    registerDefaultEndpoints(globalManager);
  }
  return globalManager;
}

export function resetAPIVersionManager(): void {
  globalManager?.reset();
  globalManager = null;
}

// ============================================================================
// Default Endpoint Registration
// ============================================================================

/**
 * Register all current v1 endpoints with their stability tiers.
 * This creates the canonical API surface registry.
 */
function registerDefaultEndpoints(mgr: APIVersionManager): void {
  const stable: Array<[string, string, string]> = [
    // [method, path, description]
    ['POST', '/api/v1/runtime', 'Create a new agent runtime session'],
    ['GET', '/api/v1/runtime/{id}', 'Get runtime session status'],
    ['DELETE', '/api/v1/runtime/{id}', 'Terminate a runtime session'],
    ['POST', '/api/v1/execute', 'Execute an agent task'],
    ['GET', '/api/v1/status', 'Get system status'],
    ['GET', '/api/v1/bus', 'Get message bus history'],
    ['GET', '/api/v1/compensation', 'Get compensation metrics'],
    ['GET', '/health', 'Health check probe'],
    ['GET', '/ready', 'Readiness check probe'],
    ['GET', '/metrics', 'Prometheus metrics endpoint'],
  ];

  const beta: Array<[string, string, string]> = [
    ['POST', '/api/v1/memory', 'Memory operations (write/query/stats)'],
    ['POST', '/api/v1/plan', 'Create an execution plan'],
    ['GET', '/api/v1/sops', 'List SOPs'],
    ['GET', '/api/v1/sops/{agent}', 'Get agent SOPs'],
    ['GET', '/api/v1/sops/{agent}/{run}', 'Get specific SOP run'],
    ['GET', '/api/v1/sops/{agent}/{run}/markdown', 'Get SOP as markdown'],
    ['GET', '/api/v1/observability/runs', 'List observability runs'],
    ['GET', '/api/v1/observability/runs/{id}', 'Get run details'],
    ['GET', '/api/v1/observability/slos', 'List SLOs'],
    ['GET', '/api/v1/atr/runs', 'List ATR runs'],
    ['POST', '/api/v1/atr/runs', 'Create ATR run'],
    ['GET', '/slo', 'SLO dashboard'],
    ['GET', '/slo/burn-rates', 'SLO burn rate evaluation'],
    ['GET', '/alerts', 'Active alerts'],
    ['GET', '/alerts/rules', 'Alert rules'],
    ['POST', '/alerts/rules', 'Create alert rule'],
    ['GET', '/incidents', 'Incident list'],
    ['POST', '/incidents', 'Create incident'],
    ['GET', '/incidents/summary', 'Incident summary'],
  ];

  const experimental: Array<[string, string, string]> = [
    ['GET', '/api/v1/security/owasp-agentic-ai-top10', 'OWASP agentic AI security check'],
    ['POST', '/api/v1/security/owasp-agentic-ai-top10', 'Run OWASP security assessment'],
    ['POST', '/api/v1/mcp', 'MCP JSON-RPC 2.0 endpoint'],
    ['GET', '/health/detailed', 'Detailed component health'],
    ['GET', '/dashboard/compensation', 'Compensation dashboard (HTML)'],
    ['GET', '/dashboard/sop', 'SOP dashboard (HTML)'],
  ];

  for (const [method, path, desc] of stable) {
    mgr.registerEndpoint({ method, path, stability: 'stable', version: 1, description: desc });
  }
  for (const [method, path, desc] of beta) {
    mgr.registerEndpoint({ method, path, stability: 'beta', version: 1, description: desc });
  }
  for (const [method, path, desc] of experimental) {
    mgr.registerEndpoint({ method, path, stability: 'experimental', version: 1, description: desc });
  }
}
