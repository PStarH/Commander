/**
 * LspResourceTool — STRAP-consolidated LSP resource tool.
 *
 * Provides IDE-level code intelligence through the Language Server Protocol.
 * Actions: diagnostics, definition, references, hover, rename, code_actions, format, status.
 *
 * Inspired by OhMyPi's LSP integration — the agent can query type information,
 * find references, rename symbols, and fix diagnostics without leaving the terminal.
 */

import type { Tool, ToolDefinition } from '../runtime/types';
import { getLspManager } from '../lsp/lspManager';
import { safePath } from './fileSystemTool';
import { reportSilentFailure } from '../silentFailureReporter';

// ============================================================================
// Resource Action Definitions
// ============================================================================

interface ResourceActionDef {
  description: string;
  params: Record<string, unknown>;
  required?: string[];
  handler: (args: Record<string, unknown>) => Promise<string>;
}

export class LspResourceTool implements Tool {
  definition: ToolDefinition = {
    name: 'lsp',
    description: `Language Server Protocol — IDE-level code intelligence from the terminal.

ACTIONS:
- diagnostics: Get errors/warnings for a file
- definition: Go to definition of a symbol
- references: Find all references to a symbol
- hover: Get type info and documentation for a symbol
- rename: Rename a symbol across the project
- code_actions: Get available quick-fixes and refactorings
- format: Auto-format a document
- status: List active LSP servers

All positions use 0-indexed line:character (same as LSP protocol).
Use file_read to get the file content first, then query LSP for deeper analysis.`,
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [
            'diagnostics',
            'definition',
            'references',
            'hover',
            'rename',
            'code_actions',
            'format',
            'status',
          ],
          description: 'The LSP operation to perform',
        },
        path: {
          type: 'string',
          description: 'File path (relative to workspace)',
        },
        line: {
          type: 'number',
          description: 'Line number (0-indexed) for position-based queries',
        },
        character: {
          type: 'number',
          description: 'Character offset (0-indexed) for position-based queries',
        },
        newName: {
          type: 'string',
          description: 'New name for rename operations',
        },
        endLine: {
          type: 'number',
          description: 'End line (0-indexed) for range-based queries (code_actions)',
        },
        endCharacter: {
          type: 'number',
          description: 'End character (0-indexed) for range-based queries (code_actions)',
        },
      },
      required: ['action'],
    },
    examples: [
      { name: 'lsp/diagnostics', arguments: { action: 'diagnostics', path: 'src/app.ts' } },
      {
        name: 'lsp/definition',
        arguments: { action: 'definition', path: 'src/app.ts', line: 42, character: 10 },
      },
      {
        name: 'lsp/references',
        arguments: { action: 'references', path: 'src/app.ts', line: 42, character: 10 },
      },
      {
        name: 'lsp/hover',
        arguments: { action: 'hover', path: 'src/app.ts', line: 42, character: 10 },
      },
      {
        name: 'lsp/rename',
        arguments: {
          action: 'rename',
          path: 'src/app.ts',
          line: 42,
          character: 10,
          newName: 'newFunctionName',
        },
      },
      {
        name: 'lsp/code_actions',
        arguments: {
          action: 'code_actions',
          path: 'src/app.ts',
          line: 42,
          character: 0,
          endLine: 42,
          endCharacter: 80,
        },
      },
      { name: 'lsp/format', arguments: { action: 'format', path: 'src/app.ts' } },
      { name: 'lsp/status', arguments: { action: 'status' } },
    ],
    category: 'code_intelligence',
    costTier: 'low',
    riskMetadata: { sideEffect: 'none' },
  };

  private actions: Record<string, ResourceActionDef> = {
    diagnostics: {
      description: 'Get errors and warnings for a file',
      params: {
        path: { type: 'string', description: 'File path' },
      },
      required: ['path'],
      handler: async (args) => {
        const filePath = String(args.path ?? '');
        const resolved = await safePath(filePath);
        const mgr = getLspManager();
        const result = await mgr.getDiagnostics(resolved);

        if (result.error && result.diagnostics.length === 0) {
          return `LSP diagnostics not available: ${result.error}\n\nInstall the language server for this file type. Use lsp:status to see active servers.`;
        }

        if (result.diagnostics.length === 0) {
          return `✅ No diagnostics for ${filePath}`;
        }

        const severityLabels: Record<number, string> = {
          1: 'ERROR',
          2: 'WARNING',
          3: 'INFO',
          4: 'HINT',
        };
        const lines: string[] = [
          `📊 Diagnostics for ${filePath} (${result.diagnostics.length} issue(s)):`,
          '',
        ];

        // Sort by severity (errors first), then line
        const sorted = [...result.diagnostics].sort((a, b) => {
          if (a.severity !== b.severity) return a.severity - b.severity;
          return a.range.start.line - b.range.start.line;
        });

        for (const d of sorted) {
          const sev = severityLabels[d.severity] ?? 'UNKNOWN';
          const icon = d.severity === 1 ? '🔴' : d.severity === 2 ? '🟡' : '🔵';
          const line = d.range.start.line + 1; // 1-indexed for display
          const col = d.range.start.character + 1;
          lines.push(`${icon} [${sev}] Line ${line}:${col} - ${d.message}`);
          if (d.code) {
            lines.push(`   Code: ${d.code}${d.source ? ` (${d.source})` : ''}`);
          }
        }

        return lines.join('\n');
      },
    },

    definition: {
      description: 'Go to definition of a symbol',
      params: {
        path: { type: 'string', description: 'File path' },
        line: { type: 'number', description: 'Line number (0-indexed)' },
        character: { type: 'number', description: 'Character offset (0-indexed)' },
      },
      required: ['path', 'line', 'character'],
      handler: async (args) => {
        const filePath = String(args.path ?? '');
        const line = Number(args.line ?? 0);
        const character = Number(args.character ?? 0);
        const resolved = await safePath(filePath);
        const mgr = getLspManager();
        const result = await mgr.goToDefinition(resolved, line, character);

        if (result.error && result.locations.length === 0) {
          return `Go-to-definition failed: ${result.error}`;
        }

        if (result.locations.length === 0) {
          return `No definition found at ${filePath}:${line + 1}:${character + 1}`;
        }

        const lines: string[] = [
          `🔍 Definition(s) for ${filePath}:${line + 1}:${character + 1}:`,
          '',
        ];
        for (const loc of result.locations) {
          const uri = loc.uri.replace('file://', '');
          const l = loc.range.start.line + 1;
          const c = loc.range.start.character + 1;
          lines.push(`  → ${uri}:${l}:${c}`);
        }

        return lines.join('\n');
      },
    },

    references: {
      description: 'Find all references to a symbol',
      params: {
        path: { type: 'string', description: 'File path' },
        line: { type: 'number', description: 'Line number (0-indexed)' },
        character: { type: 'number', description: 'Character offset (0-indexed)' },
      },
      required: ['path', 'line', 'character'],
      handler: async (args) => {
        const filePath = String(args.path ?? '');
        const line = Number(args.line ?? 0);
        const character = Number(args.character ?? 0);
        const resolved = await safePath(filePath);
        const mgr = getLspManager();
        const result = await mgr.findReferences(resolved, line, character);

        if (result.error && result.locations.length === 0) {
          return `Find references failed: ${result.error}`;
        }

        if (result.locations.length === 0) {
          return `No references found for symbol at ${filePath}:${line + 1}:${character + 1}`;
        }

        const lines: string[] = [
          `📎 ${result.locations.length} reference(s) for ${filePath}:${line + 1}:${character + 1}:`,
          '',
        ];

        // Group by file
        const byFile = new Map<string, Array<{ line: number; col: number }>>();
        for (const loc of result.locations) {
          const uri = loc.uri.replace('file://', '');
          if (!byFile.has(uri)) byFile.set(uri, []);
          byFile.get(uri)!.push({
            line: loc.range.start.line + 1,
            col: loc.range.start.character + 1,
          });
        }

        for (const [uri, positions] of byFile) {
          lines.push(`  ${uri}:`);
          for (const pos of positions.slice(0, 20)) {
            lines.push(`    Line ${pos.line}:${pos.col}`);
          }
          if (positions.length > 20) {
            lines.push(`    ... and ${positions.length - 20} more`);
          }
        }

        return lines.join('\n');
      },
    },

    hover: {
      description: 'Get type information and documentation for a symbol',
      params: {
        path: { type: 'string', description: 'File path' },
        line: { type: 'number', description: 'Line number (0-indexed)' },
        character: { type: 'number', description: 'Character offset (0-indexed)' },
      },
      required: ['path', 'line', 'character'],
      handler: async (args) => {
        const filePath = String(args.path ?? '');
        const line = Number(args.line ?? 0);
        const character = Number(args.character ?? 0);
        const resolved = await safePath(filePath);
        const mgr = getLspManager();
        const result = await mgr.hover(resolved, line, character);

        if (result.error) {
          return `Hover failed: ${result.error}`;
        }

        if (!result.hover) {
          return `No hover information at ${filePath}:${line + 1}:${character + 1}`;
        }

        const contents = result.hover.contents;
        if (typeof contents === 'string') {
          return `💡 Hover at ${filePath}:${line + 1}:${character + 1}:\n${contents}`;
        }

        // MarkupContent
        return `💡 Hover at ${filePath}:${line + 1}:${character + 1}:\n${contents.value}`;
      },
    },

    rename: {
      description: 'Rename a symbol across the project',
      params: {
        path: { type: 'string', description: 'File path' },
        line: { type: 'number', description: 'Line number (0-indexed)' },
        character: { type: 'number', description: 'Character offset (0-indexed)' },
        newName: { type: 'string', description: 'New name for the symbol' },
      },
      required: ['path', 'line', 'character', 'newName'],
      handler: async (args) => {
        const filePath = String(args.path ?? '');
        const line = Number(args.line ?? 0);
        const character = Number(args.character ?? 0);
        const newName = String(args.newName ?? '');
        if (!newName) return 'Error: newName is required for rename';

        const resolved = await safePath(filePath);
        const mgr = getLspManager();
        const result = await mgr.rename(resolved, line, character, newName);

        if (!result.success) {
          return `Rename failed: ${result.error}`;
        }

        return `✅ Renamed symbol at ${filePath}:${line + 1}:${character + 1} to "${newName}" (${result.editCount} edit(s) applied)`;
      },
    },

    code_actions: {
      description: 'Get available quick-fixes and refactorings for a range',
      params: {
        path: { type: 'string', description: 'File path' },
        line: { type: 'number', description: 'Start line (0-indexed)' },
        character: { type: 'number', description: 'Start character (0-indexed)' },
        endLine: { type: 'number', description: 'End line (0-indexed)' },
        endCharacter: { type: 'number', description: 'End character (0-indexed)' },
      },
      required: ['path', 'line', 'character'],
      handler: async (args) => {
        const filePath = String(args.path ?? '');
        const startLine = Number(args.line ?? 0);
        const startChar = Number(args.character ?? 0);
        const endLine = Number(args.endLine ?? startLine);
        const endChar = Number(args.endCharacter ?? startChar);
        const resolved = await safePath(filePath);
        const mgr = getLspManager();
        const result = await mgr.getCodeActions(resolved, startLine, startChar, endLine, endChar);

        if (result.error && result.actions.length === 0) {
          return `Code actions failed: ${result.error}`;
        }

        if (result.actions.length === 0) {
          return `No code actions available for ${filePath}:${startLine + 1}:${startChar + 1}-${endLine + 1}:${endChar + 1}`;
        }

        const lines: string[] = [`🔧 ${result.actions.length} code action(s) for ${filePath}:`, ''];
        for (let i = 0; i < result.actions.length; i++) {
          const action = result.actions[i];
          const kind = action.kind ? ` [${action.kind}]` : '';
          lines.push(`  ${i + 1}. ${action.title}${kind}`);
        }

        return lines.join('\n');
      },
    },

    format: {
      description: 'Auto-format a document',
      params: {
        path: { type: 'string', description: 'File path' },
      },
      required: ['path'],
      handler: async (args) => {
        const filePath = String(args.path ?? '');
        const resolved = await safePath(filePath);
        const mgr = getLspManager();
        const result = await mgr.formatDocument(resolved);

        if (result.error && result.edits.length === 0) {
          return `Format failed: ${result.error}`;
        }

        if (result.edits.length === 0) {
          return `✅ ${filePath} is already formatted (no changes needed)`;
        }

        return `✅ Formatted ${filePath} (${result.edits.length} edit(s) applied)`;
      },
    },

    status: {
      description: 'List active LSP servers',
      params: {} as Record<string, unknown>,
      handler: async () => {
        const mgr = getLspManager();
        const servers = mgr.getStatus();

        if (servers.length === 0) {
          return 'No active LSP servers.\n\nLSP servers start automatically when you query files with supported extensions.\nSupported languages include: TypeScript, JavaScript, Python, Rust, Go, C/C++, Java, Kotlin, C#, Ruby, PHP, Swift, Lua, Zig, Scala, Dart, Elm, Terraform, Docker, YAML, JSON, HTML, CSS, Markdown, SQL, Shell, GraphQL, Prisma, Vue, Svelte, Astro, TOML, Nix.\n\nInstall the relevant language server for your project to enable code intelligence.';
        }

        const lines: string[] = ['🖥️ Active LSP servers:', ''];
        for (const s of servers) {
          const uptime = Math.round(s.uptime / 1000);
          lines.push(`  ${s.languageId} → ${s.serverName}`);
          lines.push(`    Root: ${s.rootUri}`);
          lines.push(`    Open docs: ${s.openDocuments} | Idle: ${uptime}s`);
        }

        return lines.join('\n');
      },
    },
  };

  // ========================================================================
  // Execute
  // ========================================================================

  async execute(args: Record<string, unknown>): Promise<string> {
    const action = String(args.action ?? '');
    if (!action) {
      return 'Error: action is required. Use one of: diagnostics, definition, references, hover, rename, code_actions, format, status';
    }

    const def = this.actions[action];
    if (!def) {
      return `Error: unknown action "${action}". Use one of: ${Object.keys(this.actions).join(', ')}`;
    }

    // Validate required params
    if (def.required) {
      for (const req of def.required) {
        if (args[req] === undefined || args[req] === null || args[req] === '') {
          return `Error: "${req}" is required for action "${action}"`;
        }
      }
    }

    try {
      return await def.handler(args);
    } catch (err) {
      reportSilentFailure(err, 'lspResourceTool:execute');
      return `LSP error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}
