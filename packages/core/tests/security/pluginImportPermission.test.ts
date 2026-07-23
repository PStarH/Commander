import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createServer } from 'node:net';
import { computePluginImportDigest, PluginLoader } from '../../src/pluginLoader';
import { getGlobalPluginPermissionRegistry } from '../../src/security/pluginPermissions';
import { getHookManager } from '../../src/pluginManager';
import { DefaultContentScanner } from '../../src/contentScanner';
import { getIMProviderRegistry } from '../../src/im';

const tempDirs: string[] = [];

async function createPlugin(hostModuleImport: boolean): Promise<{ dir: string; marker: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'commander-plugin-import-'));
  return writePlugin(dir, hostModuleImport);
}

async function writePlugin(
  dir: string,
  hostModuleImport: boolean,
): Promise<{ dir: string; marker: string }> {
  await fs.mkdir(dir, { recursive: true });
  tempDirs.push(dir);
  const marker = path.join(dir, 'initialized');
  await fs.writeFile(
    path.join(dir, 'plugin.json'),
    JSON.stringify({
      name: `import-permission-${path.basename(dir)}`,
      version: '1.0.0',
      main: 'index.mjs',
      permissions: { hostModuleImport },
    }),
  );
  await fs.writeFile(
    path.join(dir, 'index.mjs'),
    `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'ran');\nexport default { name: ${JSON.stringify(`import-permission-${path.basename(dir)}`)} };\n`,
  );
  return { dir, marker };
}

afterEach(async () => {
  const registry = getGlobalPluginPermissionRegistry();
  for (const entry of registry.list()) registry.unregister(entry.pluginName);
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('plugin module initialization permission envelope', () => {
  it('rejects a repository-controlled sibling grant file at the default cwd path', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'commander-hostile-workspace-'));
    tempDirs.push(workspace);
    const { dir, marker } = await writePlugin(
      path.join(workspace, '.commander', 'plugins', 'self-authorized'),
      true,
    );
    const manifest = JSON.parse(await fs.readFile(path.join(dir, 'plugin.json'), 'utf8'));
    const digest = computePluginImportDigest(dir);
    const grantFile = path.join(workspace, '.commander', 'plugin-import-grants.json');
    await fs.writeFile(grantFile, JSON.stringify([{ pluginName: manifest.name, digest }]), {
      mode: 0o600,
    });

    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(workspace);
    const loader = new PluginLoader();
    let loadedName: string | undefined;
    try {
      const attempt = loader.loadPlugin(dir).then((loaded) => {
        loadedName = loaded.instance.name;
        return loaded;
      });
      await expect(attempt).rejects.toThrow(/outside.*workspace|operator-owned.*grant/i);
      await expect(fs.access(marker)).rejects.toThrow();
    } finally {
      if (loadedName) await loader.unloadPlugin(loadedName);
      cwd.mockRestore();
    }
  });

  it('does not let a package self-authorize top-level host code via plugin.json', async () => {
    const { dir, marker } = await createPlugin(true);
    const loader = new PluginLoader();

    await expect(loader.loadPlugin(dir)).rejects.toThrow(/operator.*grant/i);
    await expect(fs.access(marker)).rejects.toThrow();
  });

  it('preserves loading when the operator explicitly grants host module import', async () => {
    const { dir, marker } = await createPlugin(true);
    const manifest = JSON.parse(await fs.readFile(path.join(dir, 'plugin.json'), 'utf8'));
    const digest = computePluginImportDigest(dir);
    const loader = new PluginLoader({
      importGrants: [{ pluginName: manifest.name, digest }],
    });

    const loaded = await loader.loadPlugin(dir);
    expect(loaded.instance.name).toBe(`import-permission-${path.basename(dir)}`);
    await expect(fs.readFile(marker, 'utf8')).resolves.toBe('ran');
    await loader.unloadPlugin(loaded.instance.name);
  });

  it('rejects an explicit grant path inside the workspace trust boundary', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'commander-grant-workspace-'));
    tempDirs.push(workspace);
    const { dir, marker } = await createPlugin(true);
    const manifest = JSON.parse(await fs.readFile(path.join(dir, 'plugin.json'), 'utf8'));
    const digest = computePluginImportDigest(dir);
    const grantFile = path.join(workspace, 'operator-grants.json');
    await fs.writeFile(grantFile, JSON.stringify([{ pluginName: manifest.name, digest }]), {
      mode: 0o600,
    });
    const loader = new PluginLoader({ workspaceRoot: workspace, importGrantFile: grantFile });

    await expect(loader.loadPlugin(dir)).rejects.toThrow(/outside workspace/);
    await expect(fs.access(marker)).rejects.toThrow();
  });

  it('rejects an explicit grant path inside any configured plugin watch root', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'commander-grant-workspace-'));
    const watchedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'commander-plugin-watch-'));
    tempDirs.push(workspace, watchedRoot);
    const { dir, marker } = await createPlugin(true);
    const manifest = JSON.parse(await fs.readFile(path.join(dir, 'plugin.json'), 'utf8'));
    const digest = computePluginImportDigest(dir);
    const grantFile = path.join(watchedRoot, 'plugin-import-grants.json');
    await fs.writeFile(grantFile, JSON.stringify([{ pluginName: manifest.name, digest }]), {
      mode: 0o600,
    });
    const loader = new PluginLoader({ workspaceRoot: workspace, importGrantFile: grantFile });
    loader.addWatchDir(watchedRoot);

    await expect(loader.loadPlugin(dir)).rejects.toThrow(/plugin watched roots/);
    await expect(fs.access(marker)).rejects.toThrow();
  });

  it('loads an unchanged package with an external operator-owned grant file', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'commander-grant-workspace-'));
    const operatorState = await fs.mkdtemp(path.join(os.tmpdir(), 'commander-operator-state-'));
    tempDirs.push(workspace, operatorState);
    const { dir, marker } = await createPlugin(true);
    const manifest = JSON.parse(await fs.readFile(path.join(dir, 'plugin.json'), 'utf8'));
    const digest = computePluginImportDigest(dir);
    const grantFile = path.join(operatorState, 'plugin-import-grants.json');
    await fs.writeFile(grantFile, JSON.stringify([{ pluginName: manifest.name, digest }]), {
      mode: 0o600,
    });
    const loader = new PluginLoader({ workspaceRoot: workspace, importGrantFile: grantFile });

    const loaded = await loader.loadPlugin(dir);
    expect(loaded.instance.name).toBe(manifest.name);
    await expect(fs.readFile(marker, 'utf8')).resolves.toBe('ran');
    await loader.unloadPlugin(loaded.instance.name);
  });

  it('rejects a package mutation after the operator grant digest was issued', async () => {
    const { dir, marker } = await createPlugin(true);
    const manifest = JSON.parse(await fs.readFile(path.join(dir, 'plugin.json'), 'utf8'));
    const digest = computePluginImportDigest(dir);
    await fs.appendFile(path.join(dir, 'index.mjs'), '\nexport const changed = true;\n');
    const loader = new PluginLoader({
      importGrants: [{ pluginName: manifest.name, digest }],
    });

    await expect(loader.loadPlugin(dir)).rejects.toThrow(/digest-bound grant/);
    await expect(fs.access(marker)).rejects.toThrow();
  });

  it('rolls back all registered plugin state when main import fails after rule registration', async () => {
    const { dir } = await createPlugin(true);
    const manifestPath = path.join(dir, 'plugin.json');
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as Record<string, unknown>;
    manifest.contentScannerRules = {
      inline: [{ category: 'transaction-test', severity: 'HIGH', pattern: 'transaction-marker' }],
    };
    await fs.writeFile(manifestPath, JSON.stringify(manifest));
    await fs.writeFile(path.join(dir, 'index.mjs'), `throw new Error('main-load-failure');\n`);
    const pluginName = String(manifest.name);
    const digest = computePluginImportDigest(dir);
    const loader = new PluginLoader({ importGrants: [{ pluginName, digest }] });

    await expect(loader.loadPlugin(dir)).rejects.toThrow(/main-load-failure/);
    expect(loader.isLoaded(pluginName)).toBe(false);
    expect(getHookManager().hasPlugin(pluginName)).toBe(false);
    expect(getGlobalPluginPermissionRegistry().get(pluginName)).toBeUndefined();
    expect(DefaultContentScanner.listRulePacks()).not.toContain(pluginName);
  });

  it('rejects a module name mismatch without leaving split plugin ownership state', async () => {
    const { dir } = await createPlugin(true);
    const manifestPath = path.join(dir, 'plugin.json');
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as Record<string, unknown>;
    manifest.contentScannerRules = {
      inline: [{ category: 'identity-test', severity: 'HIGH', pattern: 'identity-marker' }],
    };
    await fs.writeFile(manifestPath, JSON.stringify(manifest));
    const exportedName = `different-${path.basename(dir)}`;
    const providerId = `mismatch-im-${path.basename(dir)}`;
    await fs.writeFile(
      path.join(dir, 'index.mjs'),
      `export default {
  name: ${JSON.stringify(exportedName)},
  provides: [{ service: 'im.provider', implementation: { id: ${JSON.stringify(providerId)} } }],
};
`,
    );
    const pluginName = String(manifest.name);
    const digest = computePluginImportDigest(dir);
    const loader = new PluginLoader({ importGrants: [{ pluginName, digest }] });

    await expect(loader.loadPlugin(dir)).rejects.toThrow(/does not match manifest name/i);
    expect(loader.isLoaded(pluginName)).toBe(false);
    expect(getHookManager().hasPlugin(pluginName)).toBe(false);
    expect(getHookManager().hasPlugin(exportedName)).toBe(false);
    expect(getGlobalPluginPermissionRegistry().get(pluginName)).toBeUndefined();
    expect(DefaultContentScanner.listRulePacks()).not.toContain(pluginName);
    expect(getIMProviderRegistry().resolve(providerId)).toBeUndefined();
  });

  it('rejects a global plugin-name collision without removing the existing state', async () => {
    const { dir } = await createPlugin(true);
    const manifest = JSON.parse(await fs.readFile(path.join(dir, 'plugin.json'), 'utf8')) as {
      name: string;
    };
    const existingPlugin = { name: manifest.name, version: 'existing' };
    const existingEnforcer = getGlobalPluginPermissionRegistry().register(manifest.name, {
      hostModuleImport: false,
    });
    await getHookManager().register(existingPlugin);
    const digest = computePluginImportDigest(dir);
    const loader = new PluginLoader({
      importGrants: [{ pluginName: manifest.name, digest }],
    });

    try {
      await expect(loader.loadPlugin(dir)).rejects.toThrow(/conflicts with existing global/i);
      expect(loader.isLoaded(manifest.name)).toBe(false);
      expect(getHookManager().getPlugin(manifest.name)).toBe(existingPlugin);
      expect(getGlobalPluginPermissionRegistry().get(manifest.name)).toBe(existingEnforcer);
    } finally {
      await getHookManager().unregister(manifest.name);
    }
  });

  it('registers and unloads a valid IM provider transactionally', async () => {
    const { dir } = await createPlugin(true);
    const manifest = JSON.parse(await fs.readFile(path.join(dir, 'plugin.json'), 'utf8')) as {
      name: string;
    };
    const providerId = `im-${path.basename(dir)}`;
    await fs.writeFile(
      path.join(dir, 'index.mjs'),
      `const provider = {
  id: ${JSON.stringify(providerId)},
  name: 'Transaction IM',
  verify: () => true,
  parseMessage: () => ({ senderId: 'sender', conversationId: 'conversation', text: 'hello' }),
  formatReply: (reply) => ({ body: reply }),
  stripMention: (text) => text,
};
export default {
  name: ${JSON.stringify(manifest.name)},
  provides: [{ service: 'im.provider', implementation: provider }],
};
`,
    );
    const digest = computePluginImportDigest(dir);
    const loader = new PluginLoader({
      importGrants: [{ pluginName: manifest.name, digest }],
    });

    const loaded = await loader.loadPlugin(dir);
    expect(getIMProviderRegistry().resolve(providerId)?.name).toBe('Transaction IM');
    await loader.unloadPlugin(loaded.instance.name);
    expect(getIMProviderRegistry().resolve(providerId)).toBeUndefined();
  });

  it('does not register an invalid IM provider implementation', async () => {
    const { dir } = await createPlugin(true);
    const manifest = JSON.parse(await fs.readFile(path.join(dir, 'plugin.json'), 'utf8')) as {
      name: string;
    };
    const providerId = `invalid-im-${path.basename(dir)}`;
    await fs.writeFile(
      path.join(dir, 'index.mjs'),
      `export default {
  name: ${JSON.stringify(manifest.name)},
  provides: [{ service: 'im.provider', implementation: { id: ${JSON.stringify(providerId)}, name: 'Invalid' } }],
};
`,
    );
    const digest = computePluginImportDigest(dir);
    const loader = new PluginLoader({
      importGrants: [{ pluginName: manifest.name, digest }],
    });

    const loaded = await loader.loadPlugin(dir);
    expect(getIMProviderRegistry().resolve(providerId)).toBeUndefined();
    await loader.unloadPlugin(loaded.instance.name);
    expect(getIMProviderRegistry().resolve(providerId)).toBeUndefined();
  });

  it('preserves an existing IM provider when a plugin declares a colliding id', async () => {
    const { dir } = await createPlugin(true);
    const manifest = JSON.parse(await fs.readFile(path.join(dir, 'plugin.json'), 'utf8')) as {
      name: string;
    };
    const providerId = `existing-im-${path.basename(dir)}`;
    const existingProvider = {
      id: providerId,
      name: 'Existing IM',
      verify: () => true,
      parseMessage: () => ({ senderId: 'sender', conversationId: 'conversation', text: 'hello' }),
      formatReply: (reply: { text: string }) => ({ body: reply }),
      stripMention: (text: string) => text,
    };
    getIMProviderRegistry().register(existingProvider);
    await fs.writeFile(
      path.join(dir, 'index.mjs'),
      `const provider = {
  id: ${JSON.stringify(providerId)},
  name: 'Colliding IM',
  verify: () => true,
  parseMessage: () => ({ senderId: 'sender', conversationId: 'conversation', text: 'hello' }),
  formatReply: (reply) => ({ body: reply }),
  stripMention: (text) => text,
};
export default {
  name: ${JSON.stringify(manifest.name)},
  provides: [{ service: 'im.provider', implementation: provider }],
};
`,
    );
    const digest = computePluginImportDigest(dir);
    const loader = new PluginLoader({
      importGrants: [{ pluginName: manifest.name, digest }],
    });

    try {
      await expect(loader.loadPlugin(dir)).rejects.toThrow(/IM provider.*conflicts/i);
      expect(getIMProviderRegistry().resolve(providerId)).toBe(existingProvider);
      expect(loader.isLoaded(manifest.name)).toBe(false);
      expect(getHookManager().hasPlugin(manifest.name)).toBe(false);
      expect(getGlobalPluginPermissionRegistry().get(manifest.name)).toBeUndefined();
    } finally {
      getIMProviderRegistry().unregister(providerId);
    }
  });

  it('invalidates a grant when an imported node_modules dependency changes', async () => {
    const { dir, marker } = await createPlugin(true);
    const dependency = path.join(dir, 'node_modules', 'grant-dependency', 'index.mjs');
    await fs.mkdir(path.dirname(dependency), { recursive: true });
    await fs.writeFile(dependency, `export const value = 'before';\n`);
    await fs.writeFile(
      path.join(dir, 'index.mjs'),
      `import { writeFileSync } from 'node:fs';\nimport { value } from './node_modules/grant-dependency/index.mjs';\nwriteFileSync(${JSON.stringify(marker)}, value);\nexport default { name: ${JSON.stringify(`import-permission-${path.basename(dir)}`)} };\n`,
    );
    const manifest = JSON.parse(await fs.readFile(path.join(dir, 'plugin.json'), 'utf8'));
    const digest = computePluginImportDigest(dir);
    await fs.writeFile(dependency, `export const value = 'after';\n`);
    const loader = new PluginLoader({
      importGrants: [{ pluginName: manifest.name, digest }],
    });

    await expect(loader.loadPlugin(dir)).rejects.toThrow(/digest-bound grant/);
    await expect(fs.access(marker)).rejects.toThrow();
  });

  it('invalidates a grant when a package-local JSON asset changes', async () => {
    const { dir, marker } = await createPlugin(true);
    const asset = path.join(dir, 'config.json');
    await fs.writeFile(asset, JSON.stringify({ value: 'before' }));
    await fs.writeFile(
      path.join(dir, 'index.mjs'),
      `import { readFileSync, writeFileSync } from 'node:fs';\nconst config = JSON.parse(readFileSync(new URL('./config.json', import.meta.url), 'utf8'));\nwriteFileSync(${JSON.stringify(marker)}, config.value);\nexport default { name: ${JSON.stringify(`import-permission-${path.basename(dir)}`)} };\n`,
    );
    const manifest = JSON.parse(await fs.readFile(path.join(dir, 'plugin.json'), 'utf8'));
    const digest = computePluginImportDigest(dir);
    await fs.writeFile(asset, JSON.stringify({ value: 'after' }));
    const loader = new PluginLoader({
      importGrants: [{ pluginName: manifest.name, digest }],
    });

    await expect(loader.loadPlugin(dir)).rejects.toThrow(/digest-bound grant/);
    await expect(fs.access(marker)).rejects.toThrow();
  });

  it('invalidates a grant when a package-local binary asset changes', async () => {
    const { dir, marker } = await createPlugin(true);
    const asset = path.join(dir, 'module.wasm');
    await fs.writeFile(asset, Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01]));
    const manifest = JSON.parse(await fs.readFile(path.join(dir, 'plugin.json'), 'utf8'));
    const digest = computePluginImportDigest(dir);
    await fs.writeFile(asset, Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x02]));
    const loader = new PluginLoader({
      importGrants: [{ pluginName: manifest.name, digest }],
    });

    await expect(loader.loadPlugin(dir)).rejects.toThrow(/digest-bound grant/);
    await expect(fs.access(marker)).rejects.toThrow();
  });

  it('rejects packages containing symbolic links instead of hashing through them', async () => {
    const { dir } = await createPlugin(true);
    const outside = path.join(os.tmpdir(), `commander-plugin-link-${Date.now()}.mjs`);
    tempDirs.push(outside);
    await fs.writeFile(outside, `export const value = 'outside';\n`);
    await fs.symlink(outside, path.join(dir, 'linked-dependency.mjs'));

    expect(() => computePluginImportDigest(dir)).toThrow(/forbidden symbolic link/);
  });

  it.skipIf(process.platform === 'win32')(
    'rejects packages containing special files instead of hashing them',
    async () => {
      const { dir } = await createPlugin(true);
      const socketPath = path.join(dir, 'package.sock');
      const server = createServer();
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(socketPath, resolve);
      });
      try {
        expect(() => computePluginImportDigest(dir)).toThrow(/forbidden special file/);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );
});
