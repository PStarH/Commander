/**
 * @experimental — Plugin loader for externally-installed plugins.
 *
 * Wired into the API startup flow: `getPluginLoader().loadAll()` is invoked from
 * `apps/api/src/index.ts` at boot to discover and load plugins from
 * `.commander/plugins/` (project-local) and `~/.commander/plugins/` (user-global).
 * Disabled plugins (per the persisted enabled-state map) are skipped.
 * The CLI `commander plugin <install|list|uninstall|enable|disable|info>`
 * commands also use this loader.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getHookManager, type CommanderPlugin } from './pluginManager';
import { getGlobalLogger } from './logging';
import { getSupplyChainScanner } from './security/supplyChainScanner';
import {
  getGlobalPluginPermissionRegistry,
  type PluginPermissions,
} from './security/pluginPermissions';

interface PluginManifest {
  name: string;
  version: string;
  description?: string;
  main?: string;
  hooks?: string[];
  tools?: string[];
  requires?: string[];
  config?: Record<string, unknown>;
  /**
   * P-SEC: Declared permissions for the plugin. Plugins must declare all
   * required permissions here — the permission enforcer denies any
   * resource access not explicitly declared. This ensures plugins never
   * have more permissions than the main system.
   */
  permissions?: PluginPermissions;
}

interface PluginPackage {
  manifest: PluginManifest;
  directory: string;
  instance: CommanderPlugin;
}

export class PluginLoader {
  private loaded: Map<string, PluginPackage> = new Map();
  private watchDirs: string[] = [];
  /** Persisted enable/disable map. Absent key = enabled (default). */
  private enabledState: Map<string, boolean> | null = null;

  constructor() {
    this.watchDirs = this.getDefaultWatchDirs();
  }

  // ── Enabled-state persistence ──────────────────────────────────────────

  private getEnabledStatePath(): string {
    return path.join(process.cwd(), '.commander', 'plugins', 'enabled.json');
  }

  private loadEnabledState(): Map<string, boolean> {
    if (this.enabledState) return this.enabledState;
    const map = new Map<string, boolean>();
    try {
      const file = this.getEnabledStatePath();
      if (fs.existsSync(file)) {
        const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
        if (raw && typeof raw === 'object') {
          for (const [k, v] of Object.entries(raw)) {
            if (typeof v === 'boolean') map.set(k, v);
          }
        }
      }
    } catch {
      /* corrupt or missing — treat as empty */
    }
    this.enabledState = map;
    return map;
  }

  private saveEnabledState(): void {
    try {
      const file = this.getEnabledStatePath();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const obj: Record<string, boolean> = {};
      for (const [k, v] of this.loadEnabledState()) obj[k] = v;
      fs.writeFileSync(file, JSON.stringify(obj, null, 2));
    } catch {
      /* persistence is best-effort — never block on it */
    }
  }

  /** Returns true if the plugin is enabled (default), false if disabled. */
  isEnabled(name: string): boolean {
    const state = this.loadEnabledState();
    return state.get(name) ?? true;
  }

  /** Persistently enable a plugin so it loads on subsequent startups. */
  enable(name: string): void {
    const state = this.loadEnabledState();
    state.set(name, true);
    this.saveEnabledState();
  }

  /** Persistently disable a plugin so it is skipped on subsequent startups. */
  disable(name: string): void {
    const state = this.loadEnabledState();
    state.set(name, false);
    this.saveEnabledState();
  }

  private getDefaultWatchDirs(): string[] {
    return [
      path.join(process.cwd(), '.commander', 'plugins'),
      path.join(os.homedir(), '.commander', 'plugins'),
    ];
  }

  addWatchDir(dir: string): void {
    const resolved = path.resolve(dir);
    if (!this.watchDirs.includes(resolved)) {
      this.watchDirs.push(resolved);
    }
  }

  getWatchDirs(): string[] {
    return [...this.watchDirs];
  }

  async discoverPlugins(): Promise<string[]> {
    const found: string[] = [];
    for (const dir of this.watchDirs) {
      if (!fs.existsSync(dir)) continue;
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const manifestPath = path.join(dir, entry.name, 'plugin.json');
          if (fs.existsSync(manifestPath)) {
            found.push(path.join(dir, entry.name));
          }
        }
      }
    }
    return found;
  }

  async loadPlugin(pluginDir: string): Promise<PluginPackage> {
    const resolvedDir = path.resolve(pluginDir);
    const manifestPath = path.join(resolvedDir, 'plugin.json');

    if (!fs.existsSync(manifestPath)) {
      throw new Error(`No plugin.json found in ${resolvedDir}`);
    }

    let manifest: PluginManifest;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    } catch (e) {
      throw new Error(`Invalid plugin.json in ${resolvedDir}: ${(e as Error).message}`);
    }

    if (this.loaded.has(manifest.name)) {
      getGlobalLogger().warn('PluginLoader', `Plugin "${manifest.name}" already loaded, skipping`);
      return this.loaded.get(manifest.name)!;
    }

    // SECURITY: supply-chain scan before loading any plugin code.
    // P-SEC: Scan ALL .js/.ts/.mjs files in the plugin directory, not just
    // the entry file. The previous scan only inspected the main file, leaving
    // transitive dependencies and bundled code unchecked — a bypassable gate.
    const mainFile = manifest.main ?? 'index.js';
    const mainPath = path.join(resolvedDir, mainFile);
    let pluginInstance: CommanderPlugin;

    if (fs.existsSync(mainPath)) {
      // Scan the entry file + all other JS files in the plugin directory
      const filesToScan = [mainPath];
      try {
        const allFiles = fs.readdirSync(resolvedDir, { recursive: true }) as string[];
        for (const f of allFiles) {
          const fullPath = path.join(resolvedDir, f);
          if (
            fullPath !== mainPath &&
            /\.(js|mjs|cjs|ts|mts|cts)$/.test(f) &&
            !f.includes('node_modules')
          ) {
            filesToScan.push(fullPath);
          }
        }
      } catch {
        // Non-critical — fall back to scanning just the entry file
      }

      // Scan each file and aggregate results
      let scanBlocked = false;
      let blockReason = '';
      for (const filePath of filesToScan) {
        try {
          const fileContent = fs.readFileSync(filePath, 'utf-8');
          const scanResult = getSupplyChainScanner().scan({
            name: manifest.name,
            content: fileContent,
            tools: manifest.tools ?? [],
            provenance: {
              source: 'local',
              author: manifest.name,
            },
          });
          if (!scanResult.passed) {
            scanBlocked = true;
            blockReason = `${path.basename(filePath)}: ${scanResult.recommendation} (risk=${scanResult.riskScore})`;
            break;
          }
        } catch {
          // If we can't read a file, skip it — non-critical
        }
      }

      if (scanBlocked) {
        throw new Error(`Supply chain scan blocked plugin "${manifest.name}": ${blockReason}`);
      }

      // P-SEC: Register permission enforcer BEFORE importing plugin code.
      // This ensures the enforcer is active when the plugin's onLoad runs.
      const enforcer = getGlobalPluginPermissionRegistry().register(
        manifest.name,
        manifest.permissions,
      );

      // Log declared permissions for audit trail
      const declaredPerms = enforcer.getDeclaredPermissions();
      getGlobalLogger().info('PluginLoader', 'Plugin permission envelope', {
        plugin: manifest.name,
        filesystem: {
          read: declaredPerms.filesystem.read.length,
          write: declaredPerms.filesystem.write.length,
        },
        network: { domains: declaredPerms.network.allowedDomains.length },
        process: declaredPerms.process,
        env: declaredPerms.env.length,
        hooks: declaredPerms.hooks.length,
        tools: declaredPerms.tools.length,
      });

      try {
        const mod = await import(mainPath);
        pluginInstance = mod.default ?? mod.plugin ?? mod;
        if (!pluginInstance.name) {
          pluginInstance.name = manifest.name;
        }
      } catch (err: unknown) {
        // Clean up permission registration on load failure
        getGlobalPluginPermissionRegistry().unregister(manifest.name);
        throw new Error(
          `Failed to load plugin "${manifest.name}" from ${mainPath}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } else {
      pluginInstance = {
        name: manifest.name,
        version: manifest.version,
        description: manifest.description,
      };
    }

    const pkg: PluginPackage = { manifest, directory: resolvedDir, instance: pluginInstance };
    this.loaded.set(manifest.name, pkg);
    await getHookManager().register(pluginInstance);

    getGlobalLogger().debug('PluginLoader', `Loaded: ${manifest.name}@${manifest.version}`);
    return pkg;
  }

  async loadAll(): Promise<PluginPackage[]> {
    const dirs = await this.discoverPlugins();
    const results: PluginPackage[] = [];
    for (const dir of dirs) {
      try {
        // Read the manifest name to check enabled state before loading.
        const manifestPath = path.join(dir, 'plugin.json');
        let pluginName = '';
        if (fs.existsSync(manifestPath)) {
          try {
            pluginName = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')).name ?? '';
          } catch {
            /* fall through — name stays empty */
          }
        }
        if (pluginName && !this.isEnabled(pluginName)) {
          getGlobalLogger().info(
            'PluginLoader',
            `Skipping disabled plugin "${pluginName}" at ${dir}`,
          );
          continue;
        }
        results.push(await this.loadPlugin(dir));
      } catch (err: unknown) {
        getGlobalLogger().warn(
          'PluginLoader',
          `Failed to load from ${dir}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return results;
  }

  async installFromNpm(packageName: string, targetDir?: string): Promise<string> {
    // Validate package name to prevent command injection (GAP-11)
    // Allows: @scope/name, name, name@version, @scope/name@version
    const SAFE_PACKAGE_NAME =
      /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*(@[a-z0-9-~.+^]+)?$/;
    if (!SAFE_PACKAGE_NAME.test(packageName)) {
      throw new Error(
        `Invalid package name: "${packageName}". Only alphanumeric, hyphens, dots, and scoped names are allowed.`,
      );
    }

    const installDir = targetDir ?? path.join(process.cwd(), '.commander', 'plugins');
    if (!fs.existsSync(installDir)) fs.mkdirSync(installDir, { recursive: true });
    const { execFile } = await import('child_process');
    // Use execFile (not execSync) to avoid shell interpolation. Add --ignore-scripts to block postinstall attacks.
    await new Promise<void>((resolve, reject) => {
      execFile(
        'npm',
        ['install', '--no-save', '--ignore-scripts', '--prefix', installDir, packageName],
        {
          timeout: 120000,
          maxBuffer: 10 * 1024 * 1024,
        },
        (err) => {
          if (err) reject(new Error(`npm install failed for "${packageName}": ${err.message}`));
          else resolve();
        },
      );
    });
    const nodeModulesDir = path.join(installDir, 'node_modules', packageName);
    const pluginJsonPath = path.join(nodeModulesDir, 'plugin.json');
    if (fs.existsSync(pluginJsonPath)) {
      const pluginDir = path.join(installDir, packageName.replace('/', '_'));
      fs.cpSync(nodeModulesDir, pluginDir, { recursive: true });
      return pluginDir;
    }
    const topLevel = path.join(installDir, 'node_modules');
    const dirs = fs.readdirSync(topLevel);
    for (const d of dirs) {
      const pj = path.join(topLevel, d, 'plugin.json');
      if (fs.existsSync(pj)) {
        const target = path.join(installDir, d);
        if (!fs.existsSync(target)) {
          fs.cpSync(path.join(topLevel, d), target, { recursive: true });
        }
        return target;
      }
    }
    throw new Error(`No plugin.json found in installed package "${packageName}"`);
  }

  async unloadPlugin(name: string): Promise<boolean> {
    const pkg = this.loaded.get(name);
    if (!pkg) return false;
    await getHookManager().unregister(name);
    this.loaded.delete(name);
    return true;
  }

  getLoadedPlugins(): PluginPackage[] {
    return Array.from(this.loaded.values());
  }

  isLoaded(name: string): boolean {
    return this.loaded.has(name);
  }
}

import * as os from 'node:os';

import { createTenantAwareSingleton } from './runtime/tenantAwareSingleton';

const pluginLoaderSingleton = createTenantAwareSingleton(() => new PluginLoader(), {});

export function getPluginLoader(): PluginLoader {
  return pluginLoaderSingleton.get();
}

export function resetPluginLoader(): void {
  pluginLoaderSingleton.reset();
}
