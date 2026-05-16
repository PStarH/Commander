import type { Tool, ToolDefinition } from '../runtime/types';

const DEFINITION: ToolDefinition = {
  name: 'verify_answer',
  description: 'Verify that a final answer matches the required format. GAIA and similar benchmarks require exact-format answers. Use this before returning any final answer to ensure compliance.',
  inputSchema: {
    type: 'object',
    properties: {
      answer: { type: 'string', description: 'The answer to verify' },
      format: { type: 'string', enum: ['exact_string', 'number', 'date', 'url', 'email', 'code', 'list', 'file_path'], description: 'Required answer format' },
      constraints: { type: 'string', description: 'Additional format constraints (e.g., "must be a single line", "no leading zeros")' },
    },
    required: ['answer', 'format'],
  },
  examples: [
    { name: 'verify_answer', arguments: { answer: '42', format: 'number' } },
    { name: 'verify_answer', arguments: { answer: 'https://example.com', format: 'url' } },
    { name: 'verify_answer', arguments: { answer: 'def solve(): pass', format: 'code', constraints: 'must include type hints' } },
  ],
  category: 'development',
};

export class AnswerFormatTool implements Tool {
  readonly definition = DEFINITION;
  isConcurrencySafe = true;
  isReadOnly = true;
  timeout = 5000;
  maxOutputSize = 2000;

  async execute(args: Record<string, unknown>): Promise<string> {
    const answer = String(args.answer ?? '');
    const format = String(args.format ?? 'exact_string');
    let constraints = String(args.constraints ?? '');
    constraints = constraints.toLowerCase();

    if (!answer) return 'Error: No answer provided.';

    const issues: string[] = [];

    switch (format) {
      case 'exact_string':
        if (answer.length === 0) issues.push('Answer is empty');
        if (answer.includes('\n') && !constraints.includes('multiline')) {
          issues.push('Answer contains newlines — expected single line');
        }
        break;

      case 'number':
        if (isNaN(Number(answer))) issues.push(`"${answer}" is not a valid number`);
        if (constraints.includes('integer') && !Number.isInteger(Number(answer))) {
          issues.push(`"${answer}" is not an integer`);
        }
        if (constraints.includes('positive') && Number(answer) <= 0) {
          issues.push(`"${answer}" is not positive`);
        }
        break;

      case 'date':
        const datePatterns = [
          /^\d{4}-\d{2}-\d{2}$/,           // 2024-01-15
          /^\d{2}\/\d{2}\/\d{4}$/,          // 01/15/2024
          /^[A-Z][a-z]+ \d{1,2},? \d{4}$/, // January 15, 2024
        ];
        if (!datePatterns.some(p => p.test(answer.trim()))) {
          issues.push(`"${answer}" does not match a standard date format`);
        }
        break;

      case 'url':
        if (!answer.startsWith('http://') && !answer.startsWith('https://')) {
          issues.push(`"${answer}" is not a valid URL (must start with http:// or https://)`);
        }
        break;

      case 'email':
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(answer.trim())) {
          issues.push(`"${answer}" is not a valid email address`);
        }
        break;

      case 'code':
        if (answer.length < 5) issues.push('Code snippet too short');
        if (constraints.includes('python') && !answer.includes('def ') && !answer.includes('import ')) {
          issues.push('Expected Python code with function definition');
        }
        break;

      case 'list':
        const items = answer.split('\n').filter(l => l.trim().startsWith('-') || l.trim().startsWith('*') || /^\d+[.)]/.test(l.trim()));
        if (items.length === 0 && answer.includes(',')) {
          // Comma-separated list is acceptable
        } else if (items.length < 2 && !answer.includes(',')) {
          issues.push('List must have at least 2 items');
        }
        break;

      case 'file_path':
        if (!answer.startsWith('/') && !answer.match(/^[A-Z]:\\/)) {
          issues.push(`"${answer}" is not an absolute path`);
        }
        break;
    }

    // Length constraints
    if (constraints.includes('max 100') && answer.length > 100) {
      issues.push(`Answer exceeds maximum length (${answer.length} > 100)`);
    }

    if (issues.length === 0) {
      return `✅ Answer format verified (${format}): "${answer.slice(0, 200)}"`;
    }

    return `⚠️ Format issues found:\n${issues.map(i => `  - ${i}`).join('\n')}\n\nOriginal answer: "${answer.slice(0, 500)}"`;
  }
}
