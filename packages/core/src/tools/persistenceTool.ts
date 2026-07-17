import { reportSilentFailure } from '../silentFailureReporter';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { Tool, ToolDefinition } from '../runtime/types';
import { getGlobalLogger } from '../logging';
import { pathExists } from './_utils/pathExists';

const MEMORY_DIR = path.join(process.cwd(), '.commander_memory');

/**
 * Lazy async init for the memory directory.
 *
 * Replaces the original top-level `if (!existsSync(MEMORY_DIR)) mkdirSync(...)`
 * (which would block the event loop at module load — and forbid the use of
 * async I/O at module scope). The dir is created on first tool call, only
 * once per process, and is idempotent under {@link fsp.mkdir} `{recursive:true}`.
 */
let ensureMemoryDirOnce: Promise<void> | undefined;
function ensureMemoryDir(): Promise<void> {
  if (!ensureMemoryDirOnce) {
    ensureMemoryDirOnce = fsp.mkdir(MEMORY_DIR, { recursive: true }).then(() => undefined);
    // Reset the cached promise if mkdir fails so a later retry can re-attempt
    // (e.g. transient EACCES that goes away). Without this we'd lock in
    // failure for the lifetime of the process.
    ensureMemoryDirOnce.catch(() => {
      ensureMemoryDirOnce = undefined;
    });
  }
  return ensureMemoryDirOnce;
}

/** Lazy async init for a namespace subdirectory. Idempotent. */
function ensureNamespace(nsDir: string): Promise<void> {
  // fsp.mkdir resolves to the first directory created (or undefined). We
  // explicitly discard the value so callers receive a clean Promise<void>.
  return fsp.mkdir(nsDir, { recursive: true }).then(() => undefined);
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

  async execute(args: Record<string, unknown>): Promise<string> {
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

    await ensureMemoryDir();
    const nsDir = path.join(MEMORY_DIR, namespace);
    await ensureNamespace(nsDir);
    const safeKey = key.replace(/[^a-zA-Z0-9_-]/g, '_');
    const filePath = path.join(nsDir, `${safeKey}.json`);
    const data = JSON.stringify({ key, value, timestamp: new Date().toISOString() }, null, 2);
    await fsp.writeFile(filePath, data, 'utf-8');
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

  async execute(args: Record<string, unknown>): Promise<string> {
    const key = args.key ? String(args.key) : null;
    const namespace = String(args.namespace ?? 'default');
    const search = args.search ? String(args.search).toLowerCase() : null;
    const limit = Math.min(Number(args.limit ?? 10), 100);
    const nsDir = path.join(MEMORY_DIR, namespace);
    if (!(await pathExists(nsDir))) return `No memories in "${namespace}"`;

    if (key) {
      const safeKey = key.replace(/[^a-zA-Z0-9_-]/g, '_');
      const filePath = path.join(nsDir, `${safeKey}.json`);
      if (!(await pathExists(filePath))) return `No memory for "${key}"`;
      let d: { key?: string; value?: string; timestamp?: string } = {};
      try {
        const raw = await fsp.readFile(filePath, 'utf-8');
        d = JSON.parse(raw);
      } catch (e) {
        getGlobalLogger().warn('MemoryRecallTool', 'Failed to parse memory file', {
          error: (e as Error)?.message,
        });
      }
      return `${d.key}: ${d.value}\n(updated: ${d.timestamp})`;
    }

    // Sequential awaits instead of Promise.all so each parse failure is
    // logged individually (matches the original per-file try/catch semantics).
    const entries = await fsp.readdir(nsDir);
    const files = entries.filter((f) => f.endsWith('.json'));
    const results: Array<{ key: string; value: string; timestamp: string }> = [];
    for (const file of files) {
      try {
        let d: { key?: string; value?: string; timestamp?: string } = {};
        try {
          const raw = await fsp.readFile(path.join(nsDir, file), 'utf-8');
          d = JSON.parse(raw);
        } catch (err) {
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

  async execute(): Promise<string> {
    if (!(await pathExists(MEMORY_DIR))) return 'No memory directory found';
    const allEntries = await fsp.readdir(MEMORY_DIR);
    const namespaces: string[] = [];
    for (const f of allEntries) {
      try {
        const stat = await fsp.stat(path.join(MEMORY_DIR, f));
        if (stat.isDirectory()) namespaces.push(f);
      } catch (e) {
        getGlobalLogger().warn('MemoryListTool', 'Failed to stat namespace', {
          error: (e as Error)?.message,
        });
      }
    }
    if (namespaces.length === 0) return 'No memories stored';
    const parts: string[] = [];
    for (const ns of namespaces) {
      try {
        const entries = await fsp.readdir(path.join(MEMORY_DIR, ns));
        const count = entries.filter((f) => f.endsWith('.json')).length;
        parts.push(`${ns}: ${count} entries`);
      } catch (e) {
        getGlobalLogger().warn('MemoryListTool', 'Failed to count namespace entries', {
          namespace: ns,
          error: (e as Error)?.message,
        });
      }
    }
    return parts.join('\n');
  }
}
