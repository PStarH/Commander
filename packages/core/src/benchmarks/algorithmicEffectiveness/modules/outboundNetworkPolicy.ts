import type { BenchmarkModule, Task } from '../types';
import { OutboundNetworkPolicy } from '../../../security/outboundNetworkPolicy';

interface OutboundPolicyTask extends Task {
  url: string;
  expected: (output: string) => boolean;
}

const taskSuite: OutboundPolicyTask[] = [
  {
    id: 'openai-allowed',
    prompt: 'Allowlisted OpenAI',
    url: 'https://api.openai.com/v1/chat/completions',
    expected: (out) => out === 'allowed',
  },
  {
    id: 'anthropic-allowed',
    prompt: 'Allowlisted Anthropic',
    url: 'https://api.anthropic.com/v1/messages',
    expected: (out) => out === 'allowed',
  },
  {
    id: 'blocklisted',
    prompt: 'Blocklisted domain',
    url: 'https://evil.example.com/exfil',
    expected: (out) => out === 'blocked',
  },
  {
    id: 'private-rfc1918-192',
    prompt: 'Private IP 192.168.x.x',
    url: 'http://192.168.1.1/secrets',
    expected: (out) => out === 'blocked',
  },
  {
    id: 'private-rfc1918-10',
    prompt: 'Private IP 10.x.x.x',
    url: 'http://10.0.0.5/metadata',
    expected: (out) => out === 'blocked',
  },
  {
    id: 'unknown-public',
    prompt: 'Unknown public domain',
    url: 'https://unknown-service.com/api',
    expected: (out) => out === 'blocked',
  },
  {
    id: 'malformed-url',
    prompt: 'Malformed URL',
    url: 'not a url',
    expected: (out) => out === 'blocked',
  },
];

const noUsage = { input: 0, output: 0, total: 0, cached: 0, reasoning: 0 };

export const outboundNetworkPolicyModule: BenchmarkModule = {
  id: 'outboundNetworkPolicy',
  name: 'Outbound Network Policy',
  description:
    'Validates that the OutboundNetworkPolicy blocks private IPs, blocklisted domains, and unknown public endpoints while allowing trusted LLM provider domains.',
  path: 'security/outboundNetworkPolicy.ts',
  baselineFactory: () => ({
    check: () => ({ allowed: true }),
  }),
  treatmentFactory: () => {
    const policy = new OutboundNetworkPolicy({
      allowlist: ['api.openai.com', 'api.anthropic.com'],
      blocklist: ['evil.example.com'],
      blockPrivateIPs: true,
    });
    return {
      check: (task: OutboundPolicyTask) => policy.check(task.url),
    };
  },
  runTrial: async ({ implementation, task }) => {
    const impl = implementation as { check: (t: OutboundPolicyTask) => { allowed: boolean } };
    const result = impl.check(task as OutboundPolicyTask);
    return { output: result.allowed ? 'allowed' : 'blocked', tokenUsage: noUsage, latencyMs: 1 };
  },
  taskSuite: taskSuite as unknown as Task[],
  metrics: ['successRate'],
};
