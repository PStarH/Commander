import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BenchmarkTestCase } from '../securityBenchmarkRunner';

export interface AssEBenchLoaderOptions {
  cacheDir: string;
}

export interface RawAssEBenchRecord {
  record_id?: string;
  scenario_id?: string;
  risk_type?: string;
  risk_category?: string;
  application_scenario?: string;
  agent_actions?: string | string[];
  tool_calls?: Array<{
    name?: string;
    args?: Record<string, unknown>;
  }>;
  observation?: string;
  expected_refusal?: boolean;
  strict_label?: string;
  lenient_label?: string;
  gold_safety_label?: 'safe' | 'unsafe' | 'review';
  severity?: 'low' | 'medium' | 'high' | 'critical';
  cvss_score?: number;
  owasp_mapping?: string;
  atlas_technique?: string;
  metadata?: Record<string, unknown>;
}

function normalizeToolCalls(
  raw: RawAssEBenchRecord,
): BenchmarkTestCase['expectedToolCall'] | undefined {
  const toolCalls = raw.tool_calls;
  if (!toolCalls || toolCalls.length === 0) return undefined;
  const first = toolCalls[0];
  return first.name;
}

function normalizeToolArgs(
  raw: RawAssEBenchRecord,
): BenchmarkTestCase['expectedToolArgs'] | undefined {
  const toolCalls = raw.tool_calls;
  if (!toolCalls || toolCalls.length === 0) return undefined;
  const first = toolCalls[0];
  return first.args;
}

function derivePrompt(raw: RawAssEBenchRecord): string {
  if (typeof raw.agent_actions === 'string') {
    return raw.agent_actions;
  }
  if (Array.isArray(raw.agent_actions)) {
    return raw.agent_actions.join('\n');
  }
  return raw.observation ?? '';
}

function deriveCategory(raw: RawAssEBenchRecord): string {
  return (raw.risk_category ?? raw.risk_type ?? raw.application_scenario ?? 'unknown')
    .toLowerCase()
    .replace(/\s+/g, '_');
}

function deriveSubCategory(raw: RawAssEBenchRecord): string {
  return (raw.application_scenario ?? raw.risk_type ?? 'unknown')
    .toLowerCase()
    .replace(/\s+/g, '_');
}

function toBenchmarkTestCase(raw: RawAssEBenchRecord, idx: number): BenchmarkTestCase {
  const category = deriveCategory(raw);
  return {
    id: raw.record_id ?? raw.scenario_id ?? `AA-${String(idx + 1).padStart(4, '0')}`,
    benchmark: 'assebench',
    category,
    subCategory: deriveSubCategory(raw),
    prompt: derivePrompt(raw),
    expectedRefusal: raw.expected_refusal ?? raw.gold_safety_label !== 'safe',
    tools: raw.tool_calls?.map((t) => t.name ?? 'unknown'),
    severity: raw.severity ?? 'medium',
    cvssScore: raw.cvss_score ?? 5.0,
    owaspMapping: raw.owasp_mapping,
    atlasTechnique: raw.atlas_technique,
    expectedToolCall: normalizeToolCalls(raw),
    expectedToolArgs: normalizeToolArgs(raw),
    metadata: {
      ...raw.metadata,
      strictLabel: raw.strict_label,
      lenientLabel: raw.lenient_label,
      goldSafetyLabel: raw.gold_safety_label,
      applicationScenario: raw.application_scenario,
      observation: raw.observation,
    },
  };
}

export async function loadAssEBenchCases(
  options: AssEBenchLoaderOptions,
): Promise<BenchmarkTestCase[]> {
  const cases: BenchmarkTestCase[] = [];
  const candidates = [
    'assebench_records.json',
    'assebench.json',
    'assessments.json',
    'records.json',
  ];

  const existing = candidates.find((file) => fs.existsSync(path.join(options.cacheDir, file)));
  if (!existing) {
    return cases;
  }

  const raw = JSON.parse(fs.readFileSync(path.join(options.cacheDir, existing), 'utf-8')) as
    RawAssEBenchRecord[] | { records?: RawAssEBenchRecord[] };

  const records = Array.isArray(raw) ? raw : (raw.records ?? []);
  for (let i = 0; i < records.length; i++) {
    cases.push(toBenchmarkTestCase(records[i], cases.length));
  }

  return cases;
}
