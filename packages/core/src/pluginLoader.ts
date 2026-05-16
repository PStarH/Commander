import * as fs from 'fs';
import * as path from 'path';
import { getHookManager, type CommanderPlugin } from './pluginManager';

interface PluginManifest {
  name: string;
  version: string;
  description?: string;
  main?: string;
  hooks?: string[];
  tools?: string[];
  requires?: string[];
  config?: Record<string, unknown>;
}

interface PluginPackage {
  manifest: PluginManifest;
  directory: string;
  instance: CommanderPlugin;
}

export class PluginLoader {
  private loaded: Map<string, PluginPackage> = new Map();
  private watchDirs: string[] = [];

  constructor() {
    this.watchDirs = this.getDefaultWatchDirs();
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

    const manifest: PluginManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));

    if (this.loaded.has(manifest.name)) {
      console.warn(`[plugins] Plugin "${manifest.name}" already loaded, skipping`);
      return this.loaded.get(manifest.name)!;
    }

    const mainFile = manifest.main ?? 'index.js';
    const mainPath = path.join(resolvedDir, mainFile);
    let pluginInstance: CommanderPlugin;

    if (fs.existsSync(mainPath)) {
      try {
        const mod = await import(mainPath);
        pluginInstance = mod.default ?? mod.plugin ?? mod;
        if (!pluginInstance.name) {
          pluginInstance.name = manifest.name;
        }
      } catch (err: any) {
        throw new Error(`Failed to load plugin "${manifest.name}" from ${mainPath}: ${err.message}`);
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
    getHookManager().register(pluginInstance);

    console.debug(`[plugins] Loaded: ${manifest.name}@${manifest.version}`);
    return pkg;
  }

  async loadAll(): Promise<PluginPackage[]> {
    const dirs = await this.discoverPlugins();
    const results: PluginPackage[] = [];
    for (const dir of dirs) {
      try {
        results.push(await this.loadPlugin(dir));
      } catch (err: any) {
        console.warn(`[plugins] Failed to load from ${dir}: ${err.message}`);
      }
    }
    return results;
  }

  async installFromNpm(packageName: string, targetDir?: string): Promise<string> {
    // Validate package name to prevent command injection (GAP-11)
    // Allows: @scope/name, name, name@version, @scope/name@version
    const SAFE_PACKAGE_NAME = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*(@[a-z0-9-~.+^]+)?$/;
    if (!SAFE_PACKAGE_NAME.test(packageName)) {
      throw new Error(`Invalid package name: "${packageName}". Only alphanumeric, hyphens, dots, and scoped names are allowed.`);
    }

    const installDir = targetDir ?? path.join(process.cwd(), '.commander', 'plugins');
    if (!fs.existsSync(installDir)) fs.mkdirSync(installDir, { recursive: true });
    const { execFile } = await import('child_process');
    // Use execFile (not execSync) to avoid shell interpolation. Add --ignore-scripts to block postinstall attacks.
    await new Promise<void>((resolve, reject) => {
      execFile('npm', ['install', '--no-save', '--ignore-scripts', '--prefix', installDir, packageName], {
        timeout: 120000,
        maxBuffer: 10 * 1024 * 1024,
      }, (err) => {
        if (err) reject(new Error(`npm install failed for "${packageName}": ${err.message}`));
        else resolve();
      });
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
    getHookManager().unregister(name);
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

import * as os from 'os';

let globalLoader: PluginLoader | null = null;

export function getPluginLoader(): PluginLoader {
  if (!globalLoader) globalLoader = new PluginLoader();
  return globalLoader;
}
