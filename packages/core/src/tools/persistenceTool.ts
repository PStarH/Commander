import * as fs from 'fs';
import * as path from 'path';
import type { Tool, ToolDefinition } from '../runtime/types';
import { getGlobalLogger } from '../logging';

const MEMORY_DIR = path.join(process.cwd(), '.commander_memory');
if (!fs.existsSync(MEMORY_DIR)) fs.mkdirSync(MEMORY_DIR, { recursive: true });

export class MemoryStoreTool implements Tool {
  definition: ToolDefinition = {
    name: 'memory_store',
    description: 'Store a key-value pair in persistent memory that survives across sessions. Retrieve later with memory_recall. Use for project context, user preferences, and cross-session state.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Memory key (use "project/topic" style)' },
        value: { type: 'string', description: 'Value to store' },
        namespace: { type: 'string', description: 'Namespace (default: "default")', default: 'default' },
      },
      required: ['key', 'value'],
    },
    examples: [
      { name: 'memory_store', arguments: { key: 'project/deadline', value: 'May 30th' } },
      { name: 'memory_store', arguments: { key: 'config/theme', value: 'dark', namespace: 'preferences' } },
    ],
    category: 'memory',
  };

  async execute(args: Record<string, unknown>): Promise<string> {
    const key = String(args.key ?? '');
    const value = String(args.value ?? '');
    const namespace = String(args.namespace ?? 'default');
    if (!key) return 'Error: key is required';
    const nsDir = path.join(MEMORY_DIR, namespace);
    if (!fs.existsSync(nsDir)) fs.mkdirSync(nsDir, { recursive: true });
    const safeKey = key.replace(/[^a-zA-Z0-9_-]/g, '_');
    const filePath = path.join(nsDir, `${safeKey}.json`);
    const data = JSON.stringify({ key, value, timestamp: new Date().toISOString() }, null, 2);
    fs.writeFileSync(filePath, data, 'utf-8');
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
        namespace: { type: 'string', description: 'Namespace (default: "default")', default: 'default' },
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
    if (!fs.existsSync(nsDir)) return `No memories in "${namespace}"`;

    if (key) {
      const safeKey = key.replace(/[^a-zA-Z0-9_-]/g, '_');
      const filePath = path.join(nsDir, `${safeKey}.json`);
      if (!fs.existsSync(filePath)) return `No memory for "${key}"`;
      let d; try { d = JSON.parse(fs.readFileSync(filePath, 'utf-8')); } catch (e) { getGlobalLogger().warn('MemoryRecallTool', 'Failed to parse memory file', { error: (e as Error)?.message }); d = {}; }
      return `${d.key}: ${d.value}\n(updated: ${d.timestamp})`;
    }

    const files = fs.readdirSync(nsDir).filter(f => f.endsWith('.json'));
    const results: Array<{ key: string; value: string; timestamp: string }> = [];
    for (const file of files) {
      try {
        let d; try { d = JSON.parse(fs.readFileSync(path.join(nsDir, file), 'utf-8')); } catch { d = {}; }
        if (!search || d.key.toLowerCase().includes(search) || d.value.toLowerCase().includes(search)) {
          results.push(d);
        }
      } catch (e) { getGlobalLogger().warn('MemoryRecallTool', 'Failed to read memory entry', { error: (e as Error)?.message }); }
    }
    results.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    return results.slice(0, limit).map(r => `${r.key}: ${r.value.slice(0, 200)}`).join('\n') || 'No results';
  }
}

export class MemoryListTool implements Tool {
  definition: ToolDefinition = {
    name: 'memory_list',
    description: 'List all namespaces and entry counts in persistent memory.',
    inputSchema: { type: 'object', properties: {} },
    examples: [
      { name: 'memory_list', arguments: {} },
    ],
    category: 'memory',
  };

  async execute(): Promise<string> {
    if (!fs.existsSync(MEMORY_DIR)) return 'No memory directory found';
    const namespaces = fs.readdirSync(MEMORY_DIR).filter(f => {
      try { return fs.statSync(path.join(MEMORY_DIR, f)).isDirectory(); } catch (e) { getGlobalLogger().warn('MemoryListTool', 'Failed to stat namespace', { error: (e as Error)?.message }); return false; }
    });
    if (namespaces.length === 0) return 'No memories stored';
    const parts = namespaces.map(ns => {
      const count = fs.readdirSync(path.join(MEMORY_DIR, ns)).filter(f => f.endsWith('.json')).length;
      return `${ns}: ${count} entries`;
    });
    return parts.join('\n');
  }
}
