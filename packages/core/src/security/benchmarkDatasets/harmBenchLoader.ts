import type { BenchmarkTestCase } from '../securityBenchmarkRunner';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface HarmBenchLoaderOptions {
  csvPath: string;
}

interface RawHarmBenchRow {
  Behavior: string;
  FunctionalCategory: string;
  SemanticCategory: string;
  Tags: string;
  ContextString: string;
  BehaviorID: string;
}

function parseCsv(content: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let current = '';
  let inQuotes = false;
  let i = 0;

  while (i < content.length) {
    const char = content[i];
    const next = content[i + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        current += '"';
        i += 2;
      } else {
        inQuotes = !inQuotes;
        i += 1;
      }
    } else if (char === ',' && !inQuotes) {
      row.push(current);
      current = '';
      i += 1;
    } else if ((char === '\n' || char === '\r') && !inQuotes) {
      if (current !== '' || row.length > 0) {
        row.push(current);
        rows.push(row);
        row = [];
        current = '';
      }
      i += char === '\r' && next === '\n' ? 2 : 1;
    } else {
      current += char;
      i += 1;
    }
  }

  if (current !== '' || row.length > 0) {
    row.push(current);
    rows.push(row);
  }

  return rows;
}

function parseHarmBenchCsv(content: string): RawHarmBenchRow[] {
  const allRows = parseCsv(content);
  if (allRows.length === 0) return [];
  const [headerRow, ...dataRows] = allRows;
  const headers = headerRow;
  const rows: RawHarmBenchRow[] = [];
  for (const values of dataRows) {
    const row: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = values[j] ?? '';
    }
    rows.push({
      Behavior: row.Behavior ?? '',
      FunctionalCategory: row.FunctionalCategory ?? '',
      SemanticCategory: row.SemanticCategory ?? '',
      Tags: row.Tags ?? '',
      ContextString: row.ContextString ?? '',
      BehaviorID: row.BehaviorID ?? '',
    });
  }
  return rows;
}

function rowToBenchmarkCase(raw: RawHarmBenchRow, idx: number): BenchmarkTestCase {
  return {
    id: raw.BehaviorID || `HB-${String(idx + 1).padStart(4, '0')}`,
    benchmark: 'harmbench',
    category: raw.FunctionalCategory,
    subCategory: raw.SemanticCategory,
    prompt: raw.ContextString ? `${raw.ContextString}\n\n${raw.Behavior}` : raw.Behavior,
    expectedRefusal: true,
    severity: 'critical',
    cvssScore: 9.0,
    metadata: {
      tags: raw.Tags,
    },
  };
}

export async function loadHarmBenchCases(
  options: HarmBenchLoaderOptions,
): Promise<BenchmarkTestCase[]> {
  if (!fs.existsSync(options.csvPath)) return [];
  const content = fs.readFileSync(options.csvPath, 'utf-8');
  const rows = parseHarmBenchCsv(content);
  return rows.map((r, i) => rowToBenchmarkCase(r, i));
}
