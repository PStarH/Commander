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
exports.PluginLoader = void 0;
exports.getPluginLoader = getPluginLoader;
exports.resetPluginLoader = resetPluginLoader;
/**
 * @experimental — Plugin system scaffolding. Not wired into the main execution flow.
 */
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const pluginManager_1 = require("./pluginManager");
const logging_1 = require("./logging");
class PluginLoader {
    constructor() {
        this.loaded = new Map();
        this.watchDirs = [];
        this.watchDirs = this.getDefaultWatchDirs();
    }
    getDefaultWatchDirs() {
        return [
            path.join(process.cwd(), '.commander', 'plugins'),
            path.join(os.homedir(), '.commander', 'plugins'),
        ];
    }
    addWatchDir(dir) {
        const resolved = path.resolve(dir);
        if (!this.watchDirs.includes(resolved)) {
            this.watchDirs.push(resolved);
        }
    }
    getWatchDirs() {
        return [...this.watchDirs];
    }
    async discoverPlugins() {
        const found = [];
        for (const dir of this.watchDirs) {
            if (!fs.existsSync(dir))
                continue;
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
    async loadPlugin(pluginDir) {
        var _a, _b, _c;
        const resolvedDir = path.resolve(pluginDir);
        const manifestPath = path.join(resolvedDir, 'plugin.json');
        if (!fs.existsSync(manifestPath)) {
            throw new Error(`No plugin.json found in ${resolvedDir}`);
        }
        let manifest;
        try {
            manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
        }
        catch (e) {
            throw new Error(`Invalid plugin.json in ${resolvedDir}: ${e.message}`);
        }
        if (this.loaded.has(manifest.name)) {
            (0, logging_1.getGlobalLogger)().warn('PluginLoader', `Plugin "${manifest.name}" already loaded, skipping`);
            return this.loaded.get(manifest.name);
        }
        const mainFile = (_a = manifest.main) !== null && _a !== void 0 ? _a : 'index.js';
        const mainPath = path.join(resolvedDir, mainFile);
        let pluginInstance;
        if (fs.existsSync(mainPath)) {
            try {
                const mod = await Promise.resolve(`${mainPath}`).then(s => __importStar(require(s)));
                pluginInstance = (_c = (_b = mod.default) !== null && _b !== void 0 ? _b : mod.plugin) !== null && _c !== void 0 ? _c : mod;
                if (!pluginInstance.name) {
                    pluginInstance.name = manifest.name;
                }
            }
            catch (err) {
                throw new Error(`Failed to load plugin "${manifest.name}" from ${mainPath}: ${err instanceof Error ? err.message : String(err)}`);
            }
        }
        else {
            pluginInstance = {
                name: manifest.name,
                version: manifest.version,
                description: manifest.description,
            };
        }
        const pkg = { manifest, directory: resolvedDir, instance: pluginInstance };
        this.loaded.set(manifest.name, pkg);
        await (0, pluginManager_1.getHookManager)().register(pluginInstance);
        (0, logging_1.getGlobalLogger)().debug('PluginLoader', `Loaded: ${manifest.name}@${manifest.version}`);
        return pkg;
    }
    async loadAll() {
        const dirs = await this.discoverPlugins();
        const results = [];
        for (const dir of dirs) {
            try {
                results.push(await this.loadPlugin(dir));
            }
            catch (err) {
                (0, logging_1.getGlobalLogger)().warn('PluginLoader', `Failed to load from ${dir}: ${err instanceof Error ? err.message : String(err)}`);
            }
        }
        return results;
    }
    async installFromNpm(packageName, targetDir) {
        // Validate package name to prevent command injection (GAP-11)
        // Allows: @scope/name, name, name@version, @scope/name@version
        const SAFE_PACKAGE_NAME = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*(@[a-z0-9-~.+^]+)?$/;
        if (!SAFE_PACKAGE_NAME.test(packageName)) {
            throw new Error(`Invalid package name: "${packageName}". Only alphanumeric, hyphens, dots, and scoped names are allowed.`);
        }
        const installDir = targetDir !== null && targetDir !== void 0 ? targetDir : path.join(process.cwd(), '.commander', 'plugins');
        if (!fs.existsSync(installDir))
            fs.mkdirSync(installDir, { recursive: true });
        const { execFile } = await Promise.resolve().then(() => __importStar(require('child_process')));
        // Use execFile (not execSync) to avoid shell interpolation. Add --ignore-scripts to block postinstall attacks.
        await new Promise((resolve, reject) => {
            execFile('npm', ['install', '--no-save', '--ignore-scripts', '--prefix', installDir, packageName], {
                timeout: 120000,
                maxBuffer: 10 * 1024 * 1024,
            }, (err) => {
                if (err)
                    reject(new Error(`npm install failed for "${packageName}": ${err.message}`));
                else
                    resolve();
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
    async unloadPlugin(name) {
        const pkg = this.loaded.get(name);
        if (!pkg)
            return false;
        await (0, pluginManager_1.getHookManager)().unregister(name);
        this.loaded.delete(name);
        return true;
    }
    getLoadedPlugins() {
        return Array.from(this.loaded.values());
    }
    isLoaded(name) {
        return this.loaded.has(name);
    }
}
exports.PluginLoader = PluginLoader;
const os = __importStar(require("os"));
const tenantAwareSingleton_1 = require("./runtime/tenantAwareSingleton");
const pluginLoaderSingleton = (0, tenantAwareSingleton_1.createTenantAwareSingleton)(() => new PluginLoader());
function getPluginLoader() {
    return pluginLoaderSingleton.get();
}
function resetPluginLoader() {
    pluginLoaderSingleton.reset();
}
