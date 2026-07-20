#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const ROOT = process.cwd();
const JSON_PATH = join(ROOT, 'config/deprecated-authorities.json');
const MD_PATH = join(ROOT, 'docs/architecture/deprecated-authorities.md');
const CHECK = process.argv.includes('--check');

interface Authority {
  id: string;
  paths: string[];
  routes: string[];
  owner: string;
  replacement: string;
  status: string;
  deprecatedAt: string;
  sunsetAt: string;
  deleteAfter: string;
  metric: string;
  zeroTrafficWindowDays: number;
}

function generateMd(authorities: Authority[]): string {
  const lines = [
    '# Deprecated Authorities',
    '',
    '> Auto-generated from `config/deprecated-authorities.json`. Do not edit manually.',
    '',
    '| ID | Status | Sunset | Delete After | Replacement | Metric |',
    '|----|--------|--------|--------------|-------------|--------|',
  ];
  for (const a of authorities) {
    lines.push(
      `| ${a.id} | ${a.status} | ${a.sunsetAt} | ${a.deleteAfter} | ${a.replacement} | \`${a.metric}\` |`,
    );
  }
  lines.push('');
  return lines.join('\n');
}

function main(): void {
  const config = JSON.parse(readFileSync(JSON_PATH, 'utf-8')) as { authorities: Authority[] };
  for (const a of config.authorities) {
    const expected = `commander_deprecated_path_requests_total{surface="${a.id}"}`;
    if (a.metric !== expected) {
      console.error(`[deprecated-doc] metric mismatch for ${a.id}: expected ${expected}`);
      process.exit(1);
    }
  }
  const md = generateMd(config.authorities);
  if (CHECK) {
    if (!existsSync(MD_PATH)) {
      console.error(`[deprecated-doc] Missing ${MD_PATH}`);
      process.exit(1);
    }
    const existing = readFileSync(MD_PATH, 'utf-8');
    if (existing !== md) {
      console.error('[deprecated-doc] Generated doc differs from committed copy. Run without --check.');
      process.exit(1);
    }
    console.log('[deprecated-doc] OK');
    return;
  }
  mkdirSync(dirname(MD_PATH), { recursive: true });
  writeFileSync(MD_PATH, md);
  console.log(`[deprecated-doc] Wrote ${MD_PATH}`);
}

main();
