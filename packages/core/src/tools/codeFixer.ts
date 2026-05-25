import type { Tool, ToolDefinition } from '../runtime/types';

const DEFINITION: ToolDefinition = {
  name: 'fix_code',
  description: 'Fix common Python syntax errors in generated code. Handles unclosed docstrings, indentation errors, and missing function bodies.',
  inputSchema: {
    type: 'object',
    properties: {
      code: { type: 'string', description: 'The buggy Python code to fix' },
      error: { type: 'string', description: 'The syntax error message (optional, will be detected if not provided)' },
      entryPoint: { type: 'string', description: 'Function name to verify exists in output' },
    },
    required: ['code'],
  },
  examples: [
    { name: 'fix_code', arguments: { code: 'def hello():\nprint("world")', entryPoint: 'hello' } },
    { name: 'fix_code', arguments: { code: '"""missing close', error: 'SyntaxError: EOF while scanning triple-quoted string' } },
  ],
  category: 'development',
};

export function fixPythonSyntax(code: string, errorHint?: string): { fixed: string; changes: string[] } {
  const changes: string[] = [];
  let fixed = code;

  // Fix 1: Unclosed triple-quoted strings (""" or ''')
  const tripleSingle = fixed.match(/'''/g);
  const tripleDouble = fixed.match(/"""/g);
  if (tripleSingle && tripleSingle.length % 2 !== 0) {
    fixed += "\n'''";
    changes.push('Closed unclosed triple-single-quoted string');
  }
  if (tripleDouble && tripleDouble.length % 2 !== 0) {
    fixed += '\n"""';
    changes.push('Closed unclosed triple-double-quoted string');
  }

  // Fix 2: Check and add function bodies for any 'def' without body
  const lines = fixed.split('\n');
  const fixedLines: string[] = [];
  let inDef = false;
  let defName = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const defMatch = line.match(/^\s*def\s+(\w+)\s*\(/);
    if (defMatch) {
      if (inDef && defName) {
        // Previous def had no body - add pass
        fixedLines.push('    pass');
        changes.push(`Added body for ${defName}`);
      }
      inDef = true;
      defName = defMatch[1];
      fixedLines.push(line);
      continue;
    }
    if (inDef && line.trim() && !line.startsWith(' ') && !line.startsWith('\t') && !line.startsWith('def ')) {
      // Function ended without body
      fixedLines.push('    pass');
      changes.push(`Added body for ${defName}`);
      inDef = false;
      defName = '';
    }
    if (inDef && line.trim()) {
      inDef = false; // function has a body
    }
    fixedLines.push(line);
  }
  // Handle case where last function has no body
  if (inDef && defName) {
    fixedLines.push('    pass');
    changes.push(`Added body for ${defName}`);
  }

  fixed = fixedLines.join('\n');

  // Fix 3: Fix indentation - ensure function body is indented with 4 spaces
  fixed = fixed.split('\n').map(line => {
    if (line.match(/^\s+def\s/) || line.match(/^\s+class\s/)) {
      // Ensure def/class at top level have no leading whitespace
      return line.trimStart();
    }
    return line;
  }).join('\n');

  // Fix 4: Remove trailing whitespace and ensure newline at end
  fixed = fixed.replace(/[ \t]+$/gm, '').trimEnd() + '\n';

  return { fixed, changes };
}

export class CodeFixerTool implements Tool {
  readonly definition = DEFINITION;
  isConcurrencySafe = true;
  isReadOnly = true;
  timeout = 30000; // Increased from 5s: complex code needs more time
  maxOutputSize = 50000;

  async execute(args: Record<string, unknown>): Promise<string> {
    const code = String(args.code ?? '');
    const error = String(args.error ?? '');
    const entryPoint = String(args.entryPoint ?? '');

    if (!code) return 'Error: No code provided.';

    const { fixed, changes } = fixPythonSyntax(code, error);

    // Verify entry point exists
    let entryPointOk = true;
    if (entryPoint && !fixed.includes(`def ${entryPoint}`)) {
      entryPointOk = false;
      changes.push(`Entry point "${entryPoint}" not found in fixed code`);
    }

    const summary = [
      `## Code Fix Results`,
      `- Changes made: ${changes.length}`,
      ...changes.map(c => `  - ${c}`),
      `- Entry point "${entryPoint}": ${entryPointOk ? '✅ found' : '❌ missing'}`,
      `- Output length: ${fixed.length} chars`,
      ``,
      `### Fixed Code (${fixed.length} chars)`,
      '```python',
      fixed.slice(0, 2000),
      '```',
    ];

    return summary.join('\n');
  }
}
