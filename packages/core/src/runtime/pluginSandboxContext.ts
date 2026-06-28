// ─────────────────────────────────────────────────────────────────────────────
// PluginSandboxContext
//
// Replaces the raw HookManager reference passed to plugins with a scoped,
// permission-checked context. This prevents plugins from:
// - Accessing other plugins' internal state
// - Modifying the hook system directly
// - Reaching into system internals via the HookManager reference
//
// Every API method on this context goes through the PluginPermissionEnforcer
// before delegating to the real system component.
// ─────────────────────────────────────────────────────────────────────────────

import { getGlobalLogger } from '../logging';
import { reportSilentFailure } from '../silentFailureReporter';
import type { PluginPermissionEnforcer } from '../security/pluginPermissions';

// ============================================================================
// Types
// ============================================================================

export interface PluginSandboxContext {
  /** Plugin name (for logging/audit) */
  readonly pluginName: string;

  /** Register a hook callback (permission-checked) */
  registerHook(
    hookName: string,
    callback: (...args: unknown[]) => unknown | Promise<unknown>,
  ): boolean;

  /** Read a file (permission-checked) */
  readFile(path: string): Promise<string | null>;

  /** Write a file (permission-checked) */
  writeFile(path: string, content: string): Promise<boolean>;

  /** Make an HTTP request (permission-checked) */
  fetch(url: string, options?: { method?: string; headers?: Record<string, string> }): Promise<{
    status: number;
    body: string;
  } | null>;

  /** Get an environment variable (permission-checked) */
  getEnvVar(name: string): string | undefined;

  /** Get plugin config (safe — no permissions needed) */
  getConfig(): Record<string, unknown>;

  /** Log a message (safe — always allowed) */
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string, meta?: Record<string, unknown>): void;
}

// ============================================================================
// PluginSandboxContextImpl
// ============================================================================

/**
 * Creates a sandboxed context for a plugin. All resource access is mediated
 * by the PluginPermissionEnforcer. This replaces the previous pattern of
 * passing the raw HookManager instance to plugins.
 */
export function createPluginSandboxContext(
  pluginName: string,
  enforcer: PluginPermissionEnforcer,
  config: Record<string, unknown>,
  hookRegistrar: (hookName: string, callback: (...args: unknown[]) => unknown | Promise<unknown>) => void,
): PluginSandboxContext {
  return {
    pluginName,

    registerHook(hookName: string, callback: (...args: unknown[]) => unknown | Promise<unknown>): boolean {
      const check = enforcer.checkHook(hookName);
      if (!check.allowed) {
        getGlobalLogger().warn('PluginSecurity', 'Hook registration denied', {
          plugin: pluginName,
          hook: hookName,
          reason: check.reason,
        });
        return false;
      }
      hookRegistrar(hookName, callback);
      return true;
    },

    async readFile(path: string): Promise<string | null> {
      const check = enforcer.checkFileRead(path);
      if (!check.allowed) return null;
      try {
        const fs = await import('node:fs/promises');
        return await fs.readFile(path, 'utf-8');
      } catch (err) {
        reportSilentFailure(err, `pluginSandbox:readFile:${pluginName}`);
        return null;
      }
    },

    async writeFile(path: string, content: string): Promise<boolean> {
      const check = enforcer.checkFileWrite(path);
      if (!check.allowed) return false;
      try {
        const fs = await import('node:fs/promises');
        await fs.writeFile(path, content, { mode: 0o600 });
        return true;
      } catch (err) {
        reportSilentFailure(err, `pluginSandbox:writeFile:${pluginName}`);
        return false;
      }
    },

    async fetch(
      url: string,
      options?: { method?: string; headers?: Record<string, string> },
    ): Promise<{ status: number; body: string } | null> {
      let domain: string;
      let port: number | undefined;
      try {
        const parsed = new URL(url);
        domain = parsed.hostname;
        port = parsed.port ? parseInt(parsed.port, 10) : parsed.protocol === 'https:' ? 443 : 80;
      } catch {
        return null;
      }

      const check = enforcer.checkNetwork(domain, port);
      if (!check.allowed) return null;

      try {
        const response = await fetch(url, {
          method: options?.method ?? 'GET',
          headers: options?.headers,
        });
        const body = await response.text();
        return { status: response.status, body };
      } catch (err) {
        reportSilentFailure(err, `pluginSandbox:fetch:${pluginName}`);
        return null;
      }
    },

    getEnvVar(name: string): string | undefined {
      const check = enforcer.checkEnv(name);
      if (!check.allowed) return undefined;
      return process.env[name];
    },

    getConfig(): Record<string, unknown> {
      return { ...config };
    },

    log(
      level: 'debug' | 'info' | 'warn' | 'error',
      message: string,
      meta?: Record<string, unknown>,
    ): void {
      const logger = getGlobalLogger();
      const component = `Plugin:${pluginName}`;
      if (level === 'error') {
        logger.error(component, message, undefined, meta ?? {});
      } else {
        logger[level](component, message, meta);
      }
    },
  };
}
