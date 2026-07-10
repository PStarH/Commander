import { OutputSanitizer } from '../../../security/outputSanitizer';
import type { BenchmarkModule, Task } from '../types';

interface SanitizerImplementation {
  sanitize(text: string): string;
}

const rawOutputs: Record<string, string> = {
  'ssn':
    'User record: John Doe, SSN 123-45-6789, lives in NY.',
  'api-key':
    'API key is sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890abc, call endpoint.',
  'email':
    'Contact alice.smith@example.com for details.',
  'phone':
    'Reach me at 555-123-4567 anytime.',
  'mixed':
    'Profile: bob@example.com, SSN 987-65-4321, token sk-ant-api03-abcdefghijklmnopqrstuvwxyz12, complete.',
};

const taskSuite: Task[] = [
  {
    id: 'ssn',
    prompt: 'Sanitize an output containing a US Social Security number.',
    expected: (output: string) =>
      !output.includes('123-45-6789') &&
      output.includes('John Doe') &&
      output.includes('lives in NY'),
  },
  {
    id: 'api-key',
    prompt: 'Sanitize an output containing an API key.',
    expected: (output: string) =>
      !output.includes('sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890abc') &&
      output.includes('API key is') &&
      output.includes('call endpoint'),
  },
  {
    id: 'email',
    prompt: 'Sanitize an output containing an email address.',
    expected: (output: string) =>
      !output.includes('alice.smith@example.com') &&
      output.includes('Contact') &&
      output.includes('for details'),
  },
  {
    id: 'phone',
    prompt: 'Sanitize an output containing a phone number.',
    expected: (output: string) =>
      !output.includes('555-123-4567') &&
      output.includes('Reach me at') &&
      output.includes('anytime'),
  },
  {
    id: 'mixed',
    prompt: 'Sanitize an output containing multiple sensitive values.',
    expected: (output: string) =>
      !output.includes('bob@example.com') &&
      !output.includes('987-65-4321') &&
      !output.includes('sk-ant-api03-abcdefghijklmnopqrstuvwxyz12') &&
      output.includes('Profile:') &&
      output.includes('complete.'),
  },
];

function tokenUsageFor(text: string) {
  const total = Math.max(1, Math.ceil(text.length / 4));
  return { input: 0, output: total, total, cached: 0, reasoning: 0 };
}

export const outputSanitizerModule: BenchmarkModule = {
  id: 'outputSanitizer',
  name: 'Output Sanitizer',
  description:
    'Validates that OutputSanitizer detects and redacts PII, secrets, and credentials while preserving useful context.',
  path: 'security/outputSanitizer.ts',
  baselineFactory: () => ({
    // Baseline passes output through unchanged, leaking any sensitive data.
    sanitize: (text: string) => text,
  }),
  treatmentFactory: () => {
    const sanitizer = new OutputSanitizer();
    return {
      sanitize: (text: string) => sanitizer.sanitize(text).sanitized,
    };
  },
  runTrial: async ({ implementation, task }) => {
    const impl = implementation as SanitizerImplementation;
    const raw = rawOutputs[task.id];
    const output = impl.sanitize(raw);
    return {
      output,
      tokenUsage: tokenUsageFor(output),
      latencyMs: 1,
    };
  },
  taskSuite,
  metrics: ['successRate'],
};
