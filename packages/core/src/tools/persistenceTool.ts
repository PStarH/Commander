import { reportSilentFailure } from '../silentFailureReporter';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AgentExecutionContext, Tool, ToolDefinition } from '../runtime/types';
import { getGlobalLogger } from '../logging';
import {
  assertSameTenant,
  getCurrentTenantId,
  isMultiTenantEnabled,
  tenantPathSegment,
  TenantIsolationError,
} from '../runtime/tenantContext';

const MEMORY_DIR = path.join(process.cwd(), '.commander_memory');
const NO_FOLLOW = fs.constants.O_NOFOLLOW ?? 0;

function unsafeMemoryPath(target: string): TenantIsolationError {
  return new TenantIsolationError(
    `Unsafe memory path: symbolic link or reparse point at ${target}`,
  );
}

function isWithinRoot(target: string, root: string): boolean {
  return target === root || target.startsWith(`${root}${path.sep}`);
}

async function lstatIfExists(target: string): Promise<fs.Stats | undefined> {
  try {
    return await fsp.lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function assertDirectoryComponent(target: string, stat: fs.Stats): void {
  if (stat.isSymbolicLink()) throw unsafeMemoryPath(target);
  if (!stat.isDirectory()) {
    throw new TenantIsolationError(`Unsafe memory path: expected directory at ${target}`);
  }
}

/** Validate every existing component and ensure its real path remains below MEMORY_DIR. */
async function validateExistingDirectory(target: string): Promise<boolean> {
  const root = path.resolve(MEMORY_DIR);
  const resolved = path.resolve(target);
  if (!isWithinRoot(resolved, root)) {
    throw new TenantIsolationError('Memory path escapes storage root');
  }

  const rootStat = await lstatIfExists(root);
  if (!rootStat) return false;
  assertDirectoryComponent(root, rootStat);
  const realRoot = await fsp.realpath(root);

  let current = root;
  const relative = path.relative(root, resolved);
  for (const segment of relative ? relative.split(path.sep) : []) {
    current = path.join(current, segment);
    const stat = await lstatIfExists(current);
    if (!stat) return false;
    assertDirectoryComponent(current, stat);
    const realCurrent = await fsp.realpath(current);
    if (!isWithinRoot(realCurrent, realRoot)) throw unsafeMemoryPath(current);
  }
  return true;
}

/**
 * Lazy async init for the memory directory.
 *
 * Replaces the original top-level `if (!existsSync(MEMORY_DIR)) mkdirSync(...)`
 * (which would block the event loop at module load — and forbid the use of
 * async I/O at module scope). The dir is created on first tool call, only
 * once per process, and is idempotent under {@link fsp.mkdir} `{recursive:true}`.
 */
let ensureMemoryDirOnce: Promise<void> | undefined;
async function ensureMemoryDir(): Promise<void> {
  if (!ensureMemoryDirOnce) {
    ensureMemoryDirOnce = fsp.mkdir(MEMORY_DIR, { recursive: true }).then(() => undefined);
    // Reset the cached promise if mkdir fails so a later retry can re-attempt
    // (e.g. transient EACCES that goes away). Without this we'd lock in
    // failure for the lifetime of the process.
    ensureMemoryDirOnce.catch(() => {
      ensureMemoryDirOnce = undefined;
    });
  }
  await ensureMemoryDirOnce;
  if (!(await validateExistingDirectory(MEMORY_DIR))) {
    ensureMemoryDirOnce = undefined;
    return ensureMemoryDir();
  }
}

/** Create tenant/namespace directories one component at a time without following links. */
async function ensureNamespace(nsDir: string): Promise<void> {
  await ensureMemoryDir();
  const root = path.resolve(MEMORY_DIR);
  const resolved = path.resolve(nsDir);
  if (!isWithinRoot(resolved, root)) {
    throw new TenantIsolationError('Memory namespace escapes storage root');
  }

  let current = root;
  for (const segment of path.relative(root, resolved).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      await fsp.mkdir(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const stat = await fsp.lstat(current);
    assertDirectoryComponent(current, stat);
  }
  if (!(await validateExistingDirectory(resolved))) {
    throw new TenantIsolationError(`Unsafe memory path: missing namespace ${resolved}`);
  }
}

async function assertSafeFile(filePath: string): Promise<fs.Stats | undefined> {
  const stat = await lstatIfExists(filePath);
  if (!stat) return undefined;
  if (stat.isSymbolicLink()) throw unsafeMemoryPath(filePath);
  if (!stat.isFile()) {
    throw new TenantIsolationError(`Unsafe memory path: expected file at ${filePath}`);
  }
  if (stat.nlink !== 1) {
    throw new TenantIsolationError(`Unsafe memory path: hard link at ${filePath}`);
  }
  return stat;
}

async function readMemoryFile(filePath: string): Promise<string> {
  const beforeOpen = await assertSafeFile(filePath);
  if (!beforeOpen) {
    const error = new Error(`Memory file not found: ${filePath}`) as NodeJS.ErrnoException;
    error.code = 'ENOENT';
    throw error;
  }
  let handle: fsp.FileHandle | undefined;
  try {
    handle = await fsp.open(filePath, fs.constants.O_RDONLY | NO_FOLLOW);
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      opened.dev !== beforeOpen.dev ||
      opened.ino !== beforeOpen.ino
    ) {
      throw unsafeMemoryPath(filePath);
    }
    return await handle.readFile('utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') throw unsafeMemoryPath(filePath);
    throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function writeMemoryFileAtomic(filePath: string, data: string): Promise<void> {
  const nsDir = path.dirname(filePath);
  if (!(await validateExistingDirectory(nsDir))) {
    throw new TenantIsolationError(`Unsafe memory path: missing namespace ${nsDir}`);
  }
  await assertSafeFile(filePath);

  const tmpPath = path.join(
    nsDir,
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle: fsp.FileHandle | undefined;
  try {
    handle = await fsp.open(
      tmpPath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NO_FOLLOW,
      0o600,
    );
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1) throw unsafeMemoryPath(tmpPath);
    await handle.writeFile(data, 'utf-8');
    await handle.sync();
    await handle.close();
    handle = undefined;

    if (!(await validateExistingDirectory(nsDir))) throw unsafeMemoryPath(nsDir);
    await assertSafeFile(filePath);
    await fsp.rename(tmpPath, filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') throw unsafeMemoryPath(filePath);
    throw error;
  } finally {
    await handle?.close().catch(() => {});
    await fsp.unlink(tmpPath).catch(() => {});
  }
}

function resolveTenantMemoryRoot(ctx?: AgentExecutionContext): string {
  const authenticatedTenant = ctx?.tenantId;
  const activeTenant = getCurrentTenantId();

  if (activeTenant && !authenticatedTenant) {
    throw new TenantIsolationError('Authenticated tenant is required for memory access');
  }
  if (isMultiTenantEnabled() && !authenticatedTenant) {
    throw new TenantIsolationError('Tenant-scoped memory access requires an authenticated tenant');
  }
  if (!authenticatedTenant) return MEMORY_DIR;

  assertSameTenant(authenticatedTenant);
  return path.join(MEMORY_DIR, tenantPathSegment(authenticatedTenant));
}

function resolveNamespaceDir(memoryRoot: string, namespace: string): string {
  if (
    !namespace ||
    namespace.includes('\0') ||
    path.isAbsolute(namespace) ||
    namespace
      .split(/[\\/]/)
      .some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new TenantIsolationError('Invalid memory namespace');
  }

  const resolved = path.resolve(memoryRoot, namespace);
  const root = path.resolve(memoryRoot);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new TenantIsolationError('Memory namespace escapes tenant storage');
  }
  return resolved;
}

/**
 * @deprecated L3-10a — filesystem scratch only. Product durable writes must use
 * writeProductMemory / MemoryStore (MEMORY-001). Agent-identified calls fail-closed.
 */
export class MemoryStoreTool implements Tool {
  definition: ToolDefinition = {
    name: 'memory_store',
    description:
      'Store a key-value pair in persistent memory that survives across sessions. Retrieve later with memory_recall. Use for project context, user preferences, and cross-session state.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Memory key (use "project/topic" style)' },
        value: { type: 'string', description: 'Value to store' },
        namespace: {
          type: 'string',
          description: 'Namespace (default: "default")',
          default: 'default',
        },
        agentId: {
          type: 'string',
          description:
            'When set, product writes are required — this tool refuses (use writeProductMemory)',
        },
      },
      required: ['key', 'value'],
    },
    examples: [
      { name: 'memory_store', arguments: { key: 'project/deadline', value: 'May 30th' } },
      {
        name: 'memory_store',
        arguments: { key: 'config/theme', value: 'dark', namespace: 'preferences' },
      },
    ],
    category: 'memory',
  };

  async execute(args: Record<string, unknown>, ctx?: AgentExecutionContext): Promise<string> {
    const key = String(args.key ?? '');
    const value = String(args.value ?? '');
    const namespace = String(args.namespace ?? 'default');
    if (!key) return 'Error: key is required';

    // L3-10a: agent-identified durable writes must not use the FS scratch path.
    if (args.agentId != null && String(args.agentId).length > 0) {
      throw new Error(
        'L3-10a: agent-identified product memory writes must use writeProductMemory / MemoryStore (MEMORY-001); MemoryStoreTool filesystem path is scratch-only',
      );
    }

    const memoryRoot = resolveTenantMemoryRoot(ctx);
    const nsDir = resolveNamespaceDir(memoryRoot, namespace);
    await ensureNamespace(nsDir);
    const safeKey = key.replace(/[^a-zA-Z0-9_-]/g, '_');
    const filePath = path.join(nsDir, `${safeKey}.json`);
    const data = JSON.stringify({ key, value, timestamp: new Date().toISOString() }, null, 2);
    await writeMemoryFileAtomic(filePath, data);
    return `Stored "${key}" in "${namespace}" (${value.length} chars)`;
  }
}

export class MemoryRecallTool implements Tool {
  definition: ToolDefinition = {
    name: 'memory_recall',
    description: 'Recall stored memories by key or search across all stored values.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Specific key to recall' },
        namespace: {
          type: 'string',
          description: 'Namespace (default: "default")',
          default: 'default',
        },
        search: { type: 'string', description: 'Search term across all keys and values' },
        limit: { type: 'number', description: 'Max results (default: 10)', default: 10 },
      },
    },
    examples: [
      { name: 'memory_recall', arguments: { key: 'project/deadline' } },
      { name: 'memory_recall', arguments: { search: 'config', namespace: 'preferences' } },
    ],
    category: 'memory',
  };

  async execute(args: Record<string, unknown>, ctx?: AgentExecutionContext): Promise<string> {
    const key = args.key ? String(args.key) : null;
    const namespace = String(args.namespace ?? 'default');
    const search = args.search ? String(args.search).toLowerCase() : null;
    const limit = Math.min(Number(args.limit ?? 10), 100);
    const memoryRoot = resolveTenantMemoryRoot(ctx);
    const nsDir = resolveNamespaceDir(memoryRoot, namespace);
    if (!(await validateExistingDirectory(nsDir))) return `No memories in "${namespace}"`;

    if (key) {
      const safeKey = key.replace(/[^a-zA-Z0-9_-]/g, '_');
      const filePath = path.join(nsDir, `${safeKey}.json`);
      if (!(await assertSafeFile(filePath))) return `No memory for "${key}"`;
      let d: { key?: string; value?: string; timestamp?: string } = {};
      try {
        const raw = await readMemoryFile(filePath);
        d = JSON.parse(raw);
      } catch (e) {
        if (e instanceof TenantIsolationError) throw e;
        getGlobalLogger().warn('MemoryRecallTool', 'Failed to parse memory file', {
          error: (e as Error)?.message,
        });
      }
      return `${d.key}: ${d.value}\n(updated: ${d.timestamp})`;
    }

    // Sequential awaits instead of Promise.all so each parse failure is
    // logged individually (matches the original per-file try/catch semantics).
    const entries = await fsp.readdir(nsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) throw unsafeMemoryPath(path.join(nsDir, entry.name));
    }
    const files = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.json'));
    const results: Array<{ key: string; value: string; timestamp: string }> = [];
    for (const file of files) {
      try {
        let d: { key?: string; value?: string; timestamp?: string } = {};
        try {
          const raw = await readMemoryFile(path.join(nsDir, file.name));
          d = JSON.parse(raw);
        } catch (err) {
          if (err instanceof TenantIsolationError) throw err;
          reportSilentFailure(err, 'persistenceTool:read');
          d = {};
        }
        const dk = String(d.key ?? '');
        const dv = String(d.value ?? '');
        const dt = String(d.timestamp ?? '');
        if (!search || dk.toLowerCase().includes(search) || dv.toLowerCase().includes(search)) {
          results.push({ key: dk, value: dv, timestamp: dt });
        }
      } catch (e) {
        if (e instanceof TenantIsolationError) throw e;
        getGlobalLogger().warn('MemoryRecallTool', 'Failed to read memory entry', {
          error: (e as Error)?.message,
        });
      }
    }
    // Sort newest-first by timestamp. Coerce NaN to 0 so parse-failed
    // entries (timestamp === '') sort deterministically instead of feeding
    // NaN into the Array#sort comparator (V8 behavior is undefined for NaN).
    results.sort((a, b) => (Date.parse(b.timestamp) || 0) - (Date.parse(a.timestamp) || 0));
    return (
      results
        .slice(0, limit)
        .map((r) => `${r.key}: ${r.value.slice(0, 200)}`)
        .join('\n') || 'No results'
    );
  }
}

export class MemoryListTool implements Tool {
  definition: ToolDefinition = {
    name: 'memory_list',
    description: 'List all namespaces and entry counts in persistent memory.',
    inputSchema: { type: 'object', properties: {} },
    examples: [{ name: 'memory_list', arguments: {} }],
    category: 'memory',
  };

  async execute(_args: Record<string, unknown> = {}, ctx?: AgentExecutionContext): Promise<string> {
    const memoryRoot = resolveTenantMemoryRoot(ctx);
    if (!(await validateExistingDirectory(memoryRoot))) return 'No memory directory found';
    const allEntries = await fsp.readdir(memoryRoot, { withFileTypes: true });
    const namespaces: string[] = [];
    for (const entry of allEntries) {
      try {
        const namespacePath = path.join(memoryRoot, entry.name);
        if (entry.isSymbolicLink()) throw unsafeMemoryPath(namespacePath);
        if (entry.isDirectory()) {
          if (!(await validateExistingDirectory(namespacePath)))
            throw unsafeMemoryPath(namespacePath);
          namespaces.push(entry.name);
        }
      } catch (e) {
        getGlobalLogger().warn('MemoryListTool', 'Failed to stat namespace', {
          error: (e as Error)?.message,
        });
        throw e;
      }
    }
    if (namespaces.length === 0) return 'No memories stored';
    const parts: string[] = [];
    for (const ns of namespaces) {
      try {
        const namespacePath = path.join(memoryRoot, ns);
        if (!(await validateExistingDirectory(namespacePath)))
          throw unsafeMemoryPath(namespacePath);
        const entries = await fsp.readdir(namespacePath, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isSymbolicLink()) throw unsafeMemoryPath(path.join(namespacePath, entry.name));
        }
        const count = entries.filter(
          (entry) => entry.isFile() && entry.name.endsWith('.json'),
        ).length;
        parts.push(`${ns}: ${count} entries`);
      } catch (e) {
        getGlobalLogger().warn('MemoryListTool', 'Failed to count namespace entries', {
          namespace: ns,
          error: (e as Error)?.message,
        });
        throw e;
      }
    }
    return parts.join('\n');
  }
}
