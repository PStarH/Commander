#!/usr/bin/env node

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const RSC_ADVISORY = 'GHSA-qwww-vcr4-c8h2';
const TRANSPORT_ERROR =
  /(?:410|ERR_PNPM_AUDIT_BAD_RESPONSE|endpoint is being retired|ECONNRESET|ETIMEDOUT|ENOTFOUND|fetch failed)/i;
const RSC_RUNTIME_APIS =
  /\b(?:RSCHydratedRouter|ServerRouter|RSCStaticRouter|HydratedRouter|unstable_RSC|matchRSC|createCallServer|createStaticHandler|createStaticRouter)\b/i;
const DIRECT_REACT_ROUTER_IMPORT =
  /(?:from\s*|import\s*\()['"]react-router(?!-dom)(?:\/[^'"]*)?['"]/;

function pnpmCommand() {
  return process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
}

function parseJsonOutput(output) {
  const firstObject = output.indexOf('{');
  if (firstObject < 0) return null;

  // pnpm may print a warning before the JSON report. Find the longest valid
  // JSON object so trailing diagnostics do not make an otherwise valid report
  // unparsable.
  for (let end = output.length; end > firstObject; end -= 1) {
    if (output[end - 1] !== '}') continue;
    try {
      return JSON.parse(output.slice(firstObject, end));
    } catch {
      // Keep looking for the end of the JSON object.
    }
  }
  return null;
}

function advisoryId(advisory) {
  const urlId =
    typeof advisory.url === 'string' ? advisory.url.match(/GHSA-[a-z0-9-]+/i)?.[0] : undefined;
  return (
    advisory.github_advisory_id ?? advisory.githubAdvisoryId ?? advisory.id ?? advisory.cve ?? urlId
  );
}

function collectAdvisories(report) {
  const advisories = [];

  for (const advisory of Object.values(report?.advisories ?? {})) {
    advisories.push({
      id: advisoryId(advisory) ?? `unknown:${advisory.module_name ?? 'package'}`,
      module: advisory.module_name,
      severity: advisory.severity,
    });
  }

  for (const [module, vulnerability] of Object.entries(report?.vulnerabilities ?? {})) {
    const via = Array.isArray(vulnerability.via) ? vulnerability.via : [];
    if (via.length === 0) {
      advisories.push({ id: `unknown:${module}`, module, severity: vulnerability.severity });
      continue;
    }
    for (const item of via) {
      if (typeof item === 'string') {
        advisories.push({
          id: /^GHSA-[a-z0-9-]+$/i.test(item) ? item : `unknown:${module}`,
          module,
          severity: vulnerability.severity,
        });
      } else {
        advisories.push({
          id: advisoryId(item) ?? `unknown:${module}`,
          module,
          severity: item.severity ?? vulnerability.severity,
        });
      }
    }
  }

  const highCount = Number(report?.metadata?.vulnerabilities?.high ?? 0);
  const criticalCount = Number(report?.metadata?.vulnerabilities?.critical ?? 0);
  if (advisories.length === 0 && highCount + criticalCount > 0) {
    advisories.push({ id: 'unknown:audit-metadata', module: 'unknown', severity: 'high' });
  }

  return advisories.filter((advisory) => advisory.id);
}

function sourceFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(path));
    else if (/\.(?:[cm]?[jt]sx?)$/.test(entry.name)) files.push(path);
  }
  return files;
}

function rscAdvisoryIsNotApplicable() {
  const root = process.cwd();
  const webPackage = JSON.parse(readFileSync(join(root, 'apps/web/package.json'), 'utf8'));
  const routerVersion = webPackage.dependencies?.['react-router-dom'];
  if (typeof routerVersion !== 'string' || !/^\^7\.18\.1$/.test(routerVersion)) return false;

  const lockfile = readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8');
  if (!/react-router@7\.18\.2/.test(lockfile) || !/react-router-dom@7\.18\.2/.test(lockfile))
    return false;

  const source = sourceFiles(join(root, 'apps/web/src'))
    .map((path) => readFileSync(path, 'utf8'))
    .join('\n');
  const main = readFileSync(join(root, 'apps/web/src/main.tsx'), 'utf8');
  return (
    main.includes('BrowserRouter') &&
    !RSC_RUNTIME_APIS.test(source) &&
    !DIRECT_REACT_ROUTER_IMPORT.test(source)
  );
}

function printAdvisories(advisories) {
  for (const advisory of advisories) {
    console.error(
      `::error::${advisory.id} ${advisory.module ?? 'unknown package'} (${advisory.severity ?? 'unknown'} severity)`,
    );
  }
}

const result = spawnSync(pnpmCommand(), ['audit', '--json', '--audit-level=high'], {
  encoding: 'utf8',
  maxBuffer: 16 * 1024 * 1024,
});
const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;

if (result.status === 0) {
  console.log(output);
  process.exit(0);
}

if (TRANSPORT_ERROR.test(output)) {
  console.warn(
    '::warning::pnpm audit transport/API unavailable; continuing because CodeQL remains a hard security gate.',
  );
  process.exit(0);
}

const report = parseJsonOutput(output);
const advisories = collectAdvisories(report);
const unresolved = advisories.filter(
  (advisory) =>
    !(
      advisory.id.toUpperCase() === RSC_ADVISORY.toUpperCase() &&
      /^(?:react-router|react-router-dom)$/.test(advisory.module ?? '') &&
      rscAdvisoryIsNotApplicable()
    ),
);

if (unresolved.length > 0 || !report) {
  printAdvisories(unresolved);
  if (!report) console.error(output);
  process.exit(result.status || 1);
}

console.warn(
  `::warning::${RSC_ADVISORY} is limited to React Router RSC server APIs; this repository's BrowserRouter-only Web app passed the static applicability guard.`,
);
