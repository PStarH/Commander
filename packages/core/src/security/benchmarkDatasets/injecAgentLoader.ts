import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BenchmarkTestCase } from '../securityBenchmarkRunner';

export interface InjecAgentLoaderOptions {
  cacheDir: string;
}

export interface RawInjecAgentCase {
  'User Tool': string;
  'User Instruction': string;
  'Tool Parameters': string | Record<string, unknown>;
  'Tool Response': string;
  'Attacker Tools'?: string[];
  'Attacker Instruction'?: string;
  'Expected Achievements'?: string;
  'Attack Type'?: string;
  'Attack Goal'?: 'direct harm' | 'data stealing';
}

function normalizeToolParameters(
  params: string | Record<string, unknown>,
): Record<string, unknown> {
  if (typeof params !== 'string') {
    return params ?? {};
  }
  const trimmed = params.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      // InjecAgent stores Python-style dicts with single quotes; attempt a safe JSON conversion.
      const jsonLike = trimmed
        .replace(/'/g, '"')
        .replace(/True/g, 'true')
        .replace(/False/g, 'false')
        .replace(/None/g, 'null');
      return JSON.parse(jsonLike) as Record<string, unknown>;
    } catch {
      return { raw: params };
    }
  }
  return { raw: params };
}

function deriveCategory(raw: RawInjecAgentCase): 'direct_harm' | 'data_exfiltration' {
  if (raw['Attack Goal'] === 'data stealing') return 'data_exfiltration';
  if (raw['Attack Goal'] === 'direct harm') return 'direct_harm';
  const attackType = (raw['Attack Type'] ?? '').toLowerCase();
  return attackType.includes('data') ? 'data_exfiltration' : 'direct_harm';
}

function toBenchmarkTestCase(raw: RawInjecAgentCase, idx: number): BenchmarkTestCase {
  const category = deriveCategory(raw);
  return {
    id: `IA-${String(idx + 1).padStart(4, '0')}`,
    benchmark: 'injecagent',
    category,
    subCategory: (raw['Attack Type'] ?? 'unknown').toLowerCase().replace(/\s+/g, '_'),
    prompt: raw['User Instruction'],
    expectedRefusal: true,
    tools: [raw['User Tool']],
    severity: 'critical',
    cvssScore: 9.0,
    owaspMapping: category === 'data_exfiltration' ? 'ASI01' : 'ASI03',
    atlasTechnique: 'AML.T0012',
    injectedToolOutput: raw['Tool Response'],
    expectedToolCall: raw['Attacker Tools']?.[0] ?? raw['User Tool'],
    expectedToolArgs: normalizeToolParameters(raw['Tool Parameters']),
    metadata: {
      expectedAchievements: raw['Expected Achievements'],
      attackerInstruction: raw['Attacker Instruction'],
    },
  };
}

export async function loadInjecAgentCases(
  options: InjecAgentLoaderOptions,
): Promise<BenchmarkTestCase[]> {
  const cases: BenchmarkTestCase[] = [];
  const settings: Array<'base' | 'enhanced'> = ['base', 'enhanced'];
  const intents: Array<'dh' | 'ds'> = ['dh', 'ds'];

  for (const intent of intents) {
    for (const setting of settings) {
      const filePath = path.join(options.cacheDir, `test_cases_${intent}_${setting}.json`);
      if (!fs.existsSync(filePath)) {
        continue;
      }
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as RawInjecAgentCase[];
      for (let i = 0; i < raw.length; i++) {
        cases.push(toBenchmarkTestCase(raw[i], cases.length));
      }
    }
  }

  return cases;
}
