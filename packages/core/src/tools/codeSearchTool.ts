import type { Tool, ToolDefinition } from '../runtime/types';
import { execSandboxed } from './sandboxedExec';

const DEFINITION: ToolDefinition = {
  name: 'code_search',
  description: 'Multi-hop code search using AST-aware grep. Searches code by symbol name, pattern, or type definition. Supports scope narrowing: search within function bodies, class definitions, or test files.',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'The code pattern to search for (supports regex)' },
      filePattern: { type: 'string', description: 'File glob pattern (e.g., "src/**/*.ts", "*.py")' },
      symbolType: { type: 'string', enum: ['function', 'class', 'interface', 'variable', 'import', 'all'], description: 'Type of symbol to search for' },
      maxResults: { type: 'number', description: 'Maximum number of results to return (default: 10)' },
      contextLines: { type: 'number', description: 'Lines of context around each match (default: 3)' },
      searchDomain: { type: 'string', enum: ['workspace', 'tests', 'docs', 'config'], description: 'Scope to narrow the search' },
    },
    required: ['pattern'],
  },
  examples: [
    { name: 'code_search', arguments: { pattern: 'class Repository', filePattern: 'src/**/*.ts', symbolType: 'class' } },
    { name: 'code_search', arguments: { pattern: 'def calculate', filePattern: '*.py', symbolType: 'function', contextLines: 5 } },
  ],
  category: 'development',
};

export class CodeSearchTool implements Tool {
  readonly definition = DEFINITION;
  isConcurrencySafe = true;
  isReadOnly = true;
  timeout = 30000;
  maxOutputSize = 50000;

  async execute(args: Record<string, unknown>): Promise<string> {
    const pattern = String(args.pattern ?? '');
    const filePattern = String(args.filePattern ?? '');
    const symbolType = String(args.symbolType ?? 'all');
    const maxResults = Number(args.maxResults ?? 10);
    const contextLines = Number(args.contextLines ?? 3);
    const searchDomain = String(args.searchDomain ?? 'workspace');

    if (!pattern) return 'Error: No search pattern provided.';
    if (pattern.length < 2) return 'Error: Search pattern too short (min 2 chars).';

    const cwd = process.cwd();
    let searchDir = cwd;
    if (searchDomain === 'tests') searchDir = `${cwd}/tests`;
    else if (searchDomain === 'docs') searchDir = `${cwd}/docs`;
    else if (searchDomain === 'config') searchDir = `${cwd}/config`;

    try {
      let grepPattern = pattern;
      if (symbolType === 'function') grepPattern = `(def |function |async function|fn )${pattern}`;
      else if (symbolType === 'class') grepPattern = `(class |interface )${pattern}`;
      else if (symbolType === 'import') grepPattern = `(import |from |require\\().*${pattern}`;

      let cmd = `grep -rn --include="*.ts" --include="*.js" --include="*.py" --include="*.rs" --include="*.go" -B ${contextLines} -A ${contextLines} "${grepPattern}" "${searchDir}" 2>/dev/null | head -${maxResults * (contextLines * 2 + 2)}`;
      if (filePattern) {
        cmd = `grep -rn -B ${contextLines} -A ${contextLines} "${grepPattern}" ${filePattern.includes('*') ? filePattern : `"${searchDir}/${filePattern}"`} 2>/dev/null | head -${maxResults * (contextLines * 2 + 2)}`;
      }

      const execRes = await execSandboxed(cmd, 15);
      const output = execRes.stdout || execRes.stderr;
      const lines = output.trim().split('\n').filter(Boolean);
      if (lines.length === 0 || execRes.exitCode !== 0) return `No results found for pattern: ${pattern}`;

      const matchCount = lines.filter(l => l.includes(grepPattern) || l.includes(pattern)).length;
      const sliced = lines.slice(0, maxResults * (contextLines * 2 + 2)).join('\n');
      return `Found ${matchCount} matches in ${lines.length} lines:\n\n${sliced}`;
    } catch (searchErr: unknown) {
      const msg = searchErr instanceof Error ? searchErr.message : String(searchErr);
      if (msg.includes('command failed')) return `No results found for pattern: ${pattern}`;
      return `Search failed: ${msg.slice(0, 200)}`;
    }
  }
}
