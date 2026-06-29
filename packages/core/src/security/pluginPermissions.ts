// ─────────────────────────────────────────────────────────────────────────────
// PluginPermissionSystem
//
// Enforces least-privilege for plugins. Plugins must declare all required
// permissions in their manifest; the permission system validates and enforces
// them at load time and runtime.
//
// Core principle: plugins NEVER have more permissions than the main system.
// The main system has full access; plugins get only what they declare AND
// what the operator explicitly grants.
//
// Permission levels (strict subset of main system capabilities):
// - filesystem: { read: string[], write: string[] } — scoped paths only
// - network: { allowedDomains: string[], allowedPorts: number[] } — deny by default
// - process: boolean — child_process access (default false)
// - env: string[] — allowlist of env var names (default: empty)
// - hooks: string[] — which lifecycle hooks the plugin can register
// - tools: string[] — which tools the plugin can register
// - maxExecutionTimeMs: number — hook execution timeout (default 5000)
// - maxMemoryMB: number — memory budget for plugin (default 64)
// ─────────────────────────────────────────────────────────────────────────────

import { getGlobalLogger } from '../logging';
import { reportSilentFailure } from '../silentFailureReporter';

// ============================================================================
// Types
// ============================================================================

export interface PluginPermissions {
  /** Filesystem access — scoped to specific paths within the workspace */
  filesystem: {
    read: string[];
    write: string[];
  };
  /** Network access — allowlist of domains and ports */
  network: {
    allowedDomains: string[];
    allowedPorts: number[];
  };
  /** Child process spawning — DANGEROUS, default false */
  process: boolean;
  /** Environment variable access — allowlist of variable names */
  env: string[];
  /** Lifecycle hooks the plugin is allowed to register */
  hooks: string[];
  /** Tools the plugin is allowed to register */
  tools: string[];
  /** Maximum execution time for a single hook call (ms) */
  maxExecutionTimeMs?: number;
  /** Maximum memory the plugin can allocate (MB) */
  maxMemoryMB?: number;
}

export interface PluginManifestWithPermissions {
  name: string;
  version: string;
  description?: string;
  main?: string;
  /** Declared permissions — must be present for any resource access */
  permissions?: PluginPermissions;
  /** Whether the plugin is critical (failure stops the system) */
  required?: boolean;
}

export type PermissionCheckResult =
  | { allowed: true }
  | { allowed: false; reason: string; missingPermission: string };

// ============================================================================
// Default permissions (most restrictive)
// ============================================================================

export const DEFAULT_PLUGIN_PERMISSIONS: Required<PluginPermissions> = {
  filesystem: { read: [], write: [] },
  network: { allowedDomains: [], allowedPorts: [] },
  process: false,
  env: [],
  hooks: [],
  tools: [],
  maxExecutionTimeMs: 5000,
  maxMemoryMB: 64,
};

// ============================================================================
// PluginPermissionEnforcer
// ============================================================================

/**
 * Enforces plugin permissions at runtime. Each plugin gets a scoped
 * enforcer instance that validates every resource access attempt.
 */
export class PluginPermissionEnforcer {
  private permissions: Required<PluginPermissions>;
  private violations: Array<{ timestamp: string; resource: string; reason: string }> = [];

  constructor(
    private pluginName: string,
    permissions?: Partial<PluginPermissions>,
  ) {
    // Merge with defaults — missing permissions are denied (empty arrays)
    this.permissions = {
      ...DEFAULT_PLUGIN_PERMISSIONS,
      ...permissions,
      filesystem: {
        read: permissions?.filesystem?.read ?? [],
        write: permissions?.filesystem?.write ?? [],
      },
      network: {
        allowedDomains: permissions?.network?.allowedDomains ?? [],
        allowedPorts: permissions?.network?.allowedPorts ?? [],
      },
      process: permissions?.process ?? false,
      env: permissions?.env ?? [],
      hooks: permissions?.hooks ?? [],
      tools: permissions?.tools ?? [],
      maxExecutionTimeMs: permissions?.maxExecutionTimeMs ?? 5000,
      maxMemoryMB: permissions?.maxMemoryMB ?? 64,
    };
  }

  /** Check filesystem read access for a path */
  checkFileRead(filePath: string): PermissionCheckResult {
    const allowed = this.permissions.filesystem.read;
    if (allowed.length === 0) {
      return this.deny(
        'filesystem.read',
        `Plugin "${this.pluginName}" has no filesystem read permissions`,
      );
    }
    for (const pattern of allowed) {
      if (this.matchPath(filePath, pattern)) {
        return { allowed: true };
      }
    }
    return this.deny(
      'filesystem.read',
      `Path "${filePath}" not in read allowlist for plugin "${this.pluginName}"`,
    );
  }

  /** Check filesystem write access for a path */
  checkFileWrite(filePath: string): PermissionCheckResult {
    const allowed = this.permissions.filesystem.write;
    if (allowed.length === 0) {
      return this.deny(
        'filesystem.write',
        `Plugin "${this.pluginName}" has no filesystem write permissions`,
      );
    }
    for (const pattern of allowed) {
      if (this.matchPath(filePath, pattern)) {
        return { allowed: true };
      }
    }
    return this.deny(
      'filesystem.write',
      `Path "${filePath}" not in write allowlist for plugin "${this.pluginName}"`,
    );
  }

  /** Check network access to a domain:port */
  checkNetwork(domain: string, port?: number): PermissionCheckResult {
    const { allowedDomains, allowedPorts } = this.permissions.network;
    if (allowedDomains.length === 0) {
      return this.deny('network', `Plugin "${this.pluginName}" has no network permissions`);
    }
    const domainAllowed = allowedDomains.some((d) => domain === d || domain.endsWith(`.${d}`));
    if (!domainAllowed) {
      return this.deny(
        'network',
        `Domain "${domain}" not in allowlist for plugin "${this.pluginName}"`,
      );
    }
    if (port !== undefined && allowedPorts.length > 0 && !allowedPorts.includes(port)) {
      return this.deny('network', `Port ${port} not in allowlist for plugin "${this.pluginName}"`);
    }
    return { allowed: true };
  }

  /** Check child_process access */
  checkProcess(): PermissionCheckResult {
    if (!this.permissions.process) {
      return this.deny(
        'process',
        `Plugin "${this.pluginName}" does not have process spawn permission`,
      );
    }
    return { allowed: true };
  }

  /** Check environment variable access */
  checkEnv(varName: string): PermissionCheckResult {
    if (!this.permissions.env.includes(varName)) {
      return this.deny(
        'env',
        `Env var "${varName}" not in allowlist for plugin "${this.pluginName}"`,
      );
    }
    return { allowed: true };
  }

  /** Check if a hook is allowed */
  checkHook(hookName: string): PermissionCheckResult {
    if (this.permissions.hooks.length === 0) {
      return this.deny('hooks', `Plugin "${this.pluginName}" has no hook permissions`);
    }
    if (!this.permissions.hooks.includes(hookName)) {
      return this.deny(
        'hooks',
        `Hook "${hookName}" not in allowlist for plugin "${this.pluginName}"`,
      );
    }
    return { allowed: true };
  }

  /** Check if a tool registration is allowed */
  checkToolRegistration(toolName: string): PermissionCheckResult {
    if (this.permissions.tools.length === 0) {
      return this.deny('tools', `Plugin "${this.pluginName}" has no tool registration permissions`);
    }
    if (!this.permissions.tools.includes(toolName)) {
      return this.deny(
        'tools',
        `Tool "${toolName}" not in allowlist for plugin "${this.pluginName}"`,
      );
    }
    return { allowed: true };
  }

  /** Get execution timeout for hooks */
  get maxExecutionTimeMs(): number {
    return this.permissions.maxExecutionTimeMs;
  }

  /** Get memory budget */
  get maxMemoryMB(): number {
    return this.permissions.maxMemoryMB;
  }

  /** Get all declared permissions (for audit/display) */
  getDeclaredPermissions(): Required<PluginPermissions> {
    return { ...this.permissions };
  }

  /** Get violation history */
  getViolations(): Array<{ timestamp: string; resource: string; reason: string }> {
    return [...this.violations];
  }

  // ── Private ──────────────────────────────────────────────────────────

  private deny(missingPermission: string, reason: string): PermissionCheckResult {
    this.violations.push({
      timestamp: new Date().toISOString(),
      resource: missingPermission,
      reason,
    });

    getGlobalLogger().warn('PluginSecurity', 'Permission denied', {
      plugin: this.pluginName,
      permission: missingPermission,
      reason,
    });

    return { allowed: false, reason, missingPermission };
  }

  /**
   * Match a file path against a pattern. Supports:
   * - Exact path match
   * - Prefix match with trailing /**
   * - Glob-style * for single segment
   */
  private matchPath(filePath: string, pattern: string): boolean {
    // Normalize separators
    const normalizedPath = filePath.replace(/\\/g, '/');
    const normalizedPattern = pattern.replace(/\\/g, '/');

    // Exact match
    if (normalizedPath === normalizedPattern) return true;

    // Prefix match with /**
    if (normalizedPattern.endsWith('/**')) {
      const prefix = normalizedPattern.slice(0, -3);
      return normalizedPath.startsWith(prefix);
    }

    // Prefix match with /
    if (normalizedPattern.endsWith('/')) {
      return normalizedPath.startsWith(normalizedPattern);
    }

    // Wildcard match (simple)
    const regex = new RegExp(
      '^' + normalizedPattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$',
    );
    return regex.test(normalizedPath);
  }
}

// ============================================================================
// Permission Registry — tracks all active plugin enforcers
// ============================================================================

export class PluginPermissionRegistry {
  private enforcers: Map<string, PluginPermissionEnforcer> = new Map();

  /** Register a permission enforcer for a plugin */
  register(pluginName: string, permissions?: Partial<PluginPermissions>): PluginPermissionEnforcer {
    const enforcer = new PluginPermissionEnforcer(pluginName, permissions);
    this.enforcers.set(pluginName, enforcer);
    return enforcer;
  }

  /** Get the enforcer for a plugin */
  get(pluginName: string): PluginPermissionEnforcer | undefined {
    return this.enforcers.get(pluginName);
  }

  /** Unregister a plugin's enforcer */
  unregister(pluginName: string): void {
    this.enforcers.delete(pluginName);
  }

  /** List all registered plugins and their permissions */
  list(): Array<{ pluginName: string; permissions: Required<PluginPermissions> }> {
    return [...this.enforcers.entries()].map(([name, enforcer]) => ({
      pluginName: name,
      permissions: enforcer.getDeclaredPermissions(),
    }));
  }

  /** Get all violations across all plugins */
  getAllViolations(): Array<{
    pluginName: string;
    violations: Array<{ timestamp: string; resource: string; reason: string }>;
  }> {
    return [...this.enforcers.entries()].map(([name, enforcer]) => ({
      pluginName: name,
      violations: enforcer.getViolations(),
    }));
  }
}

// ============================================================================
// Singleton
// ============================================================================

let globalRegistry: PluginPermissionRegistry | null = null;

export function getGlobalPluginPermissionRegistry(): PluginPermissionRegistry {
  if (!globalRegistry) {
    globalRegistry = new PluginPermissionRegistry();
  }
  return globalRegistry;
}
