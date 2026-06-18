import { type CommanderPlugin } from './pluginManager';
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
export declare class PluginLoader {
    private loaded;
    private watchDirs;
    constructor();
    private getDefaultWatchDirs;
    addWatchDir(dir: string): void;
    getWatchDirs(): string[];
    discoverPlugins(): Promise<string[]>;
    loadPlugin(pluginDir: string): Promise<PluginPackage>;
    loadAll(): Promise<PluginPackage[]>;
    installFromNpm(packageName: string, targetDir?: string): Promise<string>;
    unloadPlugin(name: string): Promise<boolean>;
    getLoadedPlugins(): PluginPackage[];
    isLoaded(name: string): boolean;
}
export declare function getPluginLoader(): PluginLoader;
export declare function resetPluginLoader(): void;
export {};
//# sourceMappingURL=pluginLoader.d.ts.map