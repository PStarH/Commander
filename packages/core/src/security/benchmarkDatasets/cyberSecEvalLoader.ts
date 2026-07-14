import type { BenchmarkTestCase } from '../securityBenchmarkRunner';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface CyberSecEvalLoaderOptions {
  cacheDir: string;
}

interface RawMitreCase {
  base_prompt: string;
  mutated_prompt: string;
  mitre_category: string;
  ttp_id_name_mapping?: {
    TTP_ID?: string;
    TTP_Name?: string;
  };
}

interface RawPromptInjectionCase {
  prompt_id: string;
  test_case_prompt: string;
  user_input: string;
  judge_question?: string;
  injection_variant: string;
  injection_type: 'direct' | 'indirect';
  risk_category: string;
  speaking_language: string;
}

interface RawInterpreterCase {
  base_prompt: string;
  mutated_prompt: string;
  attack_type: string[];
  attack_complexity?: string;
}

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value ?? '');
}

function loadJsonFile<T>(filePath: string): T[] {
  if (!fs.existsSync(filePath)) return [];
  return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T[];
}

function mitreToBenchmarkCase(raw: RawMitreCase, idx: number): BenchmarkTestCase {
  return {
    id: `CE-MITRE-${String(idx + 1).padStart(4, '0')}`,
    benchmark: 'cyberseceval',
    category: 'mitre',
    subCategory: raw.mitre_category,
    prompt: normalizeText(raw.mutated_prompt || raw.base_prompt),
    expectedRefusal: true,
    severity: 'critical',
    cvssScore: 9.0,
    metadata: {
      ttpId: raw.ttp_id_name_mapping?.TTP_ID,
      ttpName: raw.ttp_id_name_mapping?.TTP_Name,
    },
  };
}

function promptInjectionToBenchmarkCase(
  raw: RawPromptInjectionCase,
  idx: number,
): BenchmarkTestCase {
  return {
    id: `CE-PI-${String(idx + 1).padStart(4, '0')}`,
    benchmark: 'cyberseceval',
    category: 'prompt_injection',
    subCategory: raw.risk_category,
    prompt: normalizeText(raw.user_input),
    expectedRefusal: true,
    severity: 'high',
    cvssScore: 7.5,
    metadata: {
      promptId: raw.prompt_id,
      injectionVariant: raw.injection_variant,
      injectionType: raw.injection_type,
      language: raw.speaking_language,
    },
  };
}

function interpreterToBenchmarkCase(raw: RawInterpreterCase, idx: number): BenchmarkTestCase {
  return {
    id: `CE-INT-${String(idx + 1).padStart(4, '0')}`,
    benchmark: 'cyberseceval',
    category: 'interpreter_abuse',
    subCategory: raw.attack_type?.[0] ?? 'unknown',
    prompt: normalizeText(raw.mutated_prompt || raw.base_prompt),
    expectedRefusal: true,
    severity: 'critical',
    cvssScore: 9.0,
    metadata: {
      attackComplexity: raw.attack_complexity,
    },
  };
}

export async function loadCyberSecEvalCases(
  options: CyberSecEvalLoaderOptions,
): Promise<BenchmarkTestCase[]> {
  const cases: BenchmarkTestCase[] = [];

  const mitrePath = path.join(
    options.cacheDir,
    'mitre_benchmark_100_per_category_with_augmentation.json',
  );
  const piPath = path.join(options.cacheDir, 'prompt_injection.json');
  const interpreterPath = path.join(options.cacheDir, 'interpreter.json');

  const mitreRaw = loadJsonFile<RawMitreCase>(mitrePath);
  for (let i = 0; i < mitreRaw.length; i++) {
    cases.push(mitreToBenchmarkCase(mitreRaw[i], cases.length));
  }

  const piRaw = loadJsonFile<RawPromptInjectionCase>(piPath);
  for (let i = 0; i < piRaw.length; i++) {
    cases.push(promptInjectionToBenchmarkCase(piRaw[i], cases.length));
  }

  const intRaw = loadJsonFile<RawInterpreterCase>(interpreterPath);
  for (let i = 0; i < intRaw.length; i++) {
    cases.push(interpreterToBenchmarkCase(intRaw[i], cases.length));
  }

  return cases;
}
