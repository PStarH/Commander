import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export type AuditPolicyDecision = 'fail' | 'known-rsc-exception' | 'transport-unavailable';

const KNOWN_RSC_ADVISORY = 'GHSA-qwww-vcr4-c8h2';
const SOURCE_FILE = /\.(?:[cm]?[jt]sx?)$/;
const RSC_WIRING =
  /\b(?:unstable[_-]?rsc|ServerRouter|RSC(?:Hydrated|Static)?Router|RSCHydration|RSCPayload|createCallServer|create(?:Client|Server)(?:Routes|RequestHandler)|react-router(?:-dom)?\/(?:rsc|unstable-rsc))\b/i;

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function advisoryIds(audit: unknown): string[] | undefined {
  if (!isRecord(audit) || !isRecord(audit.advisories)) return undefined;

  const ids: string[] = [];
  for (const advisory of Object.values(audit.advisories)) {
    if (!isRecord(advisory) || typeof advisory.github_advisory_id !== 'string') {
      return undefined;
    }
    ids.push(advisory.github_advisory_id);
  }
  return ids;
}

function collectSourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(path));
    } else if (entry.isFile() && SOURCE_FILE.test(entry.name)) {
      files.push(path);
    }
  }
  return files;
}

function hasReactRouterRscWiring(sourceRoot: string): boolean {
  return collectSourceFiles(sourceRoot).some((file) => RSC_WIRING.test(readFileSync(file, 'utf8')));
}

function isKnownPnpmTransportFailure(raw: string): boolean {
  const auditEndpointFailure = /^ERR_PNPM_AUDIT_BAD_RESPONSE\b/m.test(raw);
  const pnpmNetworkFailure = /^ERR_PNPM_(?:META_FETCH_FAIL|FETCH_[A-Z_]+)\b/m.test(raw);
  const endpointRetired = /\b410\b|endpoint is being retired/i.test(raw);
  const transientNetworkFailure = /\b(?:ECONNRESET|ETIMEDOUT)\b|fetch failed/i.test(raw);

  return (
    (auditEndpointFailure && endpointRetired) || (pnpmNetworkFailure && transientNetworkFailure)
  );
}

export function evaluateAuditOutput(raw: string, sourceRoot: string): AuditPolicyDecision {
  let audit: unknown;
  try {
    audit = JSON.parse(raw);
  } catch {
    return isKnownPnpmTransportFailure(raw) ? 'transport-unavailable' : 'fail';
  }

  const ids = advisoryIds(audit);
  if (ids?.length !== 1 || ids[0] !== KNOWN_RSC_ADVISORY) return 'fail';

  return hasReactRouterRscWiring(sourceRoot) ? 'fail' : 'known-rsc-exception';
}

function main(): void {
  const auditOutput = process.argv[2];
  if (!auditOutput) {
    console.error('::error::Expected pnpm audit output file path');
    process.exitCode = 1;
    return;
  }

  const decision = evaluateAuditOutput(readFileSync(auditOutput, 'utf8'), 'apps/web/src');
  if (decision === 'transport-unavailable') {
    console.log(
      '::warning::pnpm audit transport/API unavailable (recognized pnpm error). Continuing; audit:wiring + CodeQL remain hard security gates.',
    );
    return;
  }
  if (decision === 'known-rsc-exception') {
    console.log(
      '::warning::GHSA-qwww-vcr4-c8h2 is not applicable: the web SPA has no React Router RSC wiring; keep this exception until react-router >=8.3.0 is published.',
    );
    return;
  }

  console.error(
    '::error::pnpm audit reported high/critical advisories or an unrecognized audit failure',
  );
  process.exitCode = 1;
}

if (process.argv[1]?.endsWith('ci-audit-policy.ts')) {
  main();
}
