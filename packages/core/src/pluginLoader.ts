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
import * as crypto from 'node:crypto';
import { getHookManager, type CommanderPlugin } from './pluginManager';
import { getGlobalLogger } from './logging';
import { getIMProviderRegistry } from './im';
import { getSupplyChainScanner } from './security/supplyChainScanner';
import {
  getGlobalPluginPermissionRegistry,
  type PluginPermissions,
} from './security/pluginPermissions';
import {
  DefaultContentScanner,
  type HarmfulContentRule,
  type ContentThreatSeverity,
} from './contentScanner';
import type { PluginContentScannerRules } from './pluginTypes';

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
  /** Content scanner rules contributed by this plugin. */
  contentScannerRules?: PluginContentScannerRules;
}

export interface PluginImportGrant {
  pluginName: string;
  digest: string;
}

export interface PluginLoaderOptions {
  /** Operator-owned grants injected by a trusted bootstrapper or test harness. */
  importGrants?: readonly PluginImportGrant[];
  /** Operator-owned grant file; defaults outside discovered plugin directories. */
  importGrantFile?: string;
  /** Workspace trust boundary; defaults to process.cwd(). */
  workspaceRoot?: string;
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
  private readonly importGrants?: readonly PluginImportGrant[];
  private readonly importGrantFile: string;
  private readonly workspaceRoot: string;

  constructor(options: PluginLoaderOptions = {}) {
    this.workspaceRoot = path.resolve(options.workspaceRoot ?? process.cwd());
    this.watchDirs = this.getDefaultWatchDirs();
    this.importGrants = options.importGrants;
    this.importGrantFile =
      options.importGrantFile ??
      process.env.COMMANDER_PLUGIN_IMPORT_GRANTS ??
      path.join(os.homedir(), '.commander', 'operator', 'plugin-import-grants.json');
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
      path.join(this.workspaceRoot, '.commander', 'plugins'),
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
    const hookManager = getHookManager();
    const permissionRegistry = getGlobalPluginPermissionRegistry();
    if (
      hookManager.hasPlugin(manifest.name) ||
      permissionRegistry.get(manifest.name) ||
      DefaultContentScanner.listRulePacks().includes(manifest.name)
    ) {
      throw new Error(`Plugin "${manifest.name}" conflicts with existing global plugin state`);
    }

    // SECURITY: supply-chain scan before loading any plugin code.
    // P-SEC: Scan ALL .js/.ts/.mjs files in the plugin directory, not just
    // the entry file. The previous scan only inspected the main file, leaving
    // transitive dependencies and bundled code unchecked — a bypassable gate.
    const mainFile = manifest.main ?? 'index.js';
    const mainPath = resolvePluginPackagePath(resolvedDir, mainFile, 'main');
    let pluginInstance: CommanderPlugin;
    let permissionRegistered = false;
    let rulePackRegistered = false;

    try {
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

        const pluginDigest = computePluginImportDigest(resolvedDir);

        // P-SEC: Register permission enforcer BEFORE importing plugin code.
        // This ensures the enforcer is active when the plugin's onLoad runs.
        const enforcer = getGlobalPluginPermissionRegistry().register(
          manifest.name,
          manifest.permissions,
        );
        permissionRegistered = true;

        // A dynamic import executes all module top-level code with the
        // Commander process' ambient privileges. The sandbox context is only
        // created later by HookManager.onLoad and cannot mediate that code.
        // Fail closed unless the operator explicitly grants this authority.
        if (
          !enforcer.requiresHostModuleImport ||
          !this.hasOperatorImportGrant(manifest.name, pluginDigest, resolvedDir)
        ) {
          getGlobalPluginPermissionRegistry().unregister(manifest.name);
          throw new Error(
            `Plugin "${manifest.name}" blocked: module initialization requires an operator-owned digest-bound grant`,
          );
        }

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
          hostModuleImportRequested: declaredPerms.hostModuleImport,
          importDigest: pluginDigest,
          hooks: declaredPerms.hooks.length,
          tools: declaredPerms.tools.length,
        });

        // Register manifest-declared content scanner rules before plugin onLoad runs.
        if (manifest.contentScannerRules) {
          const rules = await resolveContentScannerRules(manifest, resolvedDir);
          if (rules.length > 0) {
            DefaultContentScanner.registerRulePack(manifest.name, rules);
            rulePackRegistered = true;
            getGlobalLogger().info(
              'PluginLoader',
              `Registered ${rules.length} content scanner rules`,
              {
                plugin: manifest.name,
              },
            );
          }
        }

        try {
          const mod = await import(mainPath);
          pluginInstance = mod.default ?? mod.plugin ?? mod;
          if (!pluginInstance.name) {
            pluginInstance.name = manifest.name;
          }
          if (pluginInstance.name !== manifest.name) {
            throw new Error(
              `Plugin module name "${pluginInstance.name}" does not match manifest name "${manifest.name}"`,
            );
          }
        } catch (err: unknown) {
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

      if (pluginInstance.provides) {
        for (const declaration of pluginInstance.provides) {
          if (declaration.service !== 'im.provider') continue;
          const implementation = declaration.implementation as { id?: unknown } | undefined;
          if (!implementation || typeof implementation.id !== 'string' || !implementation.id) {
            continue;
          }
          const existing = getIMProviderRegistry().resolve(implementation.id);
          if (existing) {
            throw new Error(
              `Plugin "${manifest.name}" IM provider "${implementation.id}" conflicts with existing global state`,
            );
          }
        }
      }

      const pkg: PluginPackage = { manifest, directory: resolvedDir, instance: pluginInstance };
      await hookManager.register(pluginInstance);
      this.loaded.set(manifest.name, pkg);

      getGlobalLogger().debug('PluginLoader', `Loaded: ${manifest.name}@${manifest.version}`);
      return pkg;
    } catch (error) {
      this.loaded.delete(manifest.name);
      if (hookManager.getPlugin(manifest.name) === pluginInstance!) {
        try {
          await hookManager.unregister(manifest.name);
        } catch (cleanupError) {
          getGlobalLogger().warn('PluginLoader', `Failed to roll back plugin "${manifest.name}"`, {
            error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
          });
        }
      }
      if (rulePackRegistered) DefaultContentScanner.unregisterRulePack(manifest.name);
      if (permissionRegistered) getGlobalPluginPermissionRegistry().unregister(manifest.name);
      throw error;
    }
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
    DefaultContentScanner.unregisterRulePack(name);
    this.loaded.delete(name);
    return true;
  }

  getLoadedPlugins(): PluginPackage[] {
    return Array.from(this.loaded.values());
  }

  private hasOperatorImportGrant(pluginName: string, digest: string, pluginDir: string): boolean {
    const grants =
      this.importGrants ??
      readOperatorImportGrants(this.importGrantFile, [
        this.workspaceRoot,
        ...this.watchDirs,
        pluginDir,
      ]);
    return grants.some((grant) => grant.pluginName === pluginName && grant.digest === digest);
  }

  isLoaded(name: string): boolean {
    return this.loaded.has(name);
  }
}

/**
 * MCP-12: compile a plugin-supplied regex with ReDoS guards. Plugin content is
 * untrusted, and a catastrophic-backtracking pattern would hang the scanner that
 * runs it against arbitrary content. We cap the source length and reject the
 * classic catastrophic shapes (a quantified group whose body is itself
 * unbounded-quantified, or an enormous repetition bound) before compiling.
 */
const MAX_USER_REGEX_LENGTH = 1000;
// A group whose body contains an unbounded quantifier and is then quantified
// again — (a+)+, (a*)*, (.*)+, (?:x+)* — plus a class quantified twice.
const NESTED_QUANTIFIER_RE = /\((?:\?[:=!<]*)?[^()]*[+*][^()]*\)\s*[+*]|\[[^\]]*\][+*]\s*[+*]/;
// Repetition bound with a very large lower/upper limit, e.g. {5000} / {1000,}.
const HUGE_BOUND_RE = /\{\s*\d{4,}\s*,?\s*\d*\s*\}/;

function compileBoundedUserRegex(source: string, flags: string, context: string): RegExp {
  if (typeof source !== 'string') {
    throw new Error(`${context}: regex pattern must be a string`);
  }
  if (source.length > MAX_USER_REGEX_LENGTH) {
    throw new Error(
      `${context}: regex pattern exceeds ${MAX_USER_REGEX_LENGTH} chars (ReDoS guard)`,
    );
  }
  if (NESTED_QUANTIFIER_RE.test(source) || HUGE_BOUND_RE.test(source)) {
    throw new Error(
      `${context}: regex pattern rejected as potentially catastrophic (nested or oversized quantifier)`,
    );
  }
  return new RegExp(source, flags);
}

/**
 * Resolve content scanner rules declared in a plugin manifest.
 * Supports inline JSON rules and module exports containing HarmfulContentRule[].
 */
async function resolveContentScannerRules(
  manifest: PluginManifest,
  pluginDir: string,
): Promise<HarmfulContentRule[]> {
  const declaration = manifest.contentScannerRules;
  if (!declaration) return [];

  if (declaration.inline) {
    return declaration.inline.map((r) => ({
      category: r.category,
      severity: r.severity,
      pattern: compileBoundedUserRegex(
        r.pattern,
        r.flags ?? 'gi',
        `Plugin "${manifest.name}" contentScannerRules.inline`,
      ),
    }));
  }

  if (declaration.export) {
    const enforcer = getGlobalPluginPermissionRegistry().get(manifest.name);
    if (!enforcer?.requiresHostModuleImport) {
      throw new Error(
        `Plugin "${manifest.name}" blocked: content scanner module initialization requires the explicit "permissions.hostModuleImport" grant`,
      );
    }
    const modulePath = resolvePluginPackagePath(
      pluginDir,
      declaration.export.module,
      'content scanner export',
    );
    const mod = await import(modulePath);
    const exported = mod[declaration.export.name];
    if (!Array.isArray(exported)) {
      throw new Error(
        `Plugin "${manifest.name}" contentScannerRules export "${declaration.export.name}" is not an array`,
      );
    }
    return exported.map((r: HarmfulContentRule) => ({
      category: r.category,
      severity: r.severity,
      pattern: compileBoundedUserRegex(
        r.pattern.source,
        r.pattern.flags,
        `Plugin "${manifest.name}" contentScannerRules.export`,
      ),
    }));
  }

  return [];
}

/** Compute the package digest an operator must bind before host import. */
export function computePluginImportDigest(pluginDir: string): string {
  const resolvedDir = path.resolve(pluginDir);
  const packageFiles = collectPluginPackageFiles(resolvedDir);
  const hash = crypto.createHash('sha256');
  hash.update('commander-plugin-package-v1\0');
  for (const filePath of packageFiles.sort()) {
    const relative = path.relative(resolvedDir, filePath).split(path.sep).join('/');
    hash.update(`\0${relative}\0`);
    hash.update(fs.readFileSync(filePath));
  }
  return hash.digest('hex');
}

function collectPluginPackageFiles(pluginDir: string): string[] {
  const files: string[] = [];
  const rootStat = fs.lstatSync(pluginDir);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error('Plugin package root must be a real directory');
  }
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const filePath = path.join(dir, entry.name);
      const stat = fs.lstatSync(filePath);
      if (stat.isSymbolicLink()) {
        throw new Error(`Plugin package contains forbidden symbolic link: ${filePath}`);
      }
      if (stat.isDirectory()) walk(filePath);
      else if (stat.isFile()) files.push(filePath);
      else throw new Error(`Plugin package contains forbidden special file: ${filePath}`);
    }
  };
  walk(pluginDir);
  return files;
}

function resolvePluginPackagePath(pluginDir: string, candidate: string, label: string): string {
  const root = path.resolve(pluginDir);
  const resolved = path.resolve(root, candidate);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Plugin ${label} path must stay inside the package directory`);
  }
  return resolved;
}

function isWithinAnyRoot(candidate: string, roots: readonly string[]): boolean {
  return roots.some((root) => {
    const resolvedRoot = path.resolve(root);
    return candidate === resolvedRoot || candidate.startsWith(`${resolvedRoot}${path.sep}`);
  });
}

function readOperatorImportGrants(
  filePath: string,
  forbiddenRoots: readonly string[],
): PluginImportGrant[] {
  const resolvedGrantFile = path.resolve(filePath);
  if (isWithinAnyRoot(resolvedGrantFile, forbiddenRoots)) {
    throw new Error('Plugin import grant file must be outside workspace and plugin watched roots');
  }
  if (!fs.existsSync(resolvedGrantFile)) return [];

  const stat = fs.lstatSync(resolvedGrantFile);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error('Plugin import grant path must be a regular file, not a link or special file');
  }
  const realGrantFile = fs.realpathSync(resolvedGrantFile);
  if (isWithinAnyRoot(realGrantFile, forbiddenRoots)) {
    throw new Error('Plugin import grant file must be outside workspace and plugin watched roots');
  }
  if (process.platform !== 'win32') {
    if ((stat.mode & 0o022) !== 0) {
      throw new Error('Plugin import grant file must not be group/world writable');
    }
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
      throw new Error('Plugin import grant file must be owned by the current operator');
    }
  }

  const parsed: unknown = JSON.parse(fs.readFileSync(realGrantFile, 'utf8'));
  const rows = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as { grants?: unknown }).grants)
      ? (parsed as { grants: unknown[] }).grants
      : [];
  return rows.filter(
    (row): row is PluginImportGrant =>
      !!row &&
      typeof row === 'object' &&
      typeof (row as PluginImportGrant).pluginName === 'string' &&
      /^[a-f0-9]{64}$/i.test((row as PluginImportGrant).digest),
  );
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
