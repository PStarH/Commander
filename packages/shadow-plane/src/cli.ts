#!/usr/bin/env node

import { createPublicKey, type KeyObject } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { atomicExport } from './atomicExport.js';
import { parseShadowManifest, type ShadowManifestV1 } from './contracts.js';
import { buildSignedShadowReport, verifyShadowReport } from './report.js';
import {
  asShadowSqlPool,
  ShadowRepository,
  type ShadowCampaignReportData,
  type ShadowImportResult,
} from './repository.js';
import { loadShadowStartupConfig } from './startupConfig.js';

const MAX_NDJSON_LINE_BYTES = 16 * 1024;
const MAX_IMPORT_RECORDS = 10_000;
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const MAX_REPORT_BYTES = 192 * 1024 * 1024;
const MAX_PUBLIC_KEY_BYTES = 64 * 1024;
const SOURCE_REVISION = /^[\x21-\x7e]{1,128}$/;

export interface ShadowCliRepository {
  registerManifest(tenantId: string, manifest: ShadowManifestV1): Promise<{ idempotent: boolean }>;
  importObservation(
    tenantId: string,
    observation: unknown,
  ): Promise<ShadowImportResult | { idempotent: boolean }>;
  closeDueBatch(tenantId: string, campaignId: string, batchId: string): Promise<void>;
  readReport(tenantId: string, campaignId: string): Promise<ShadowCampaignReportData>;
  withdrawCampaign(tenantId: string, campaignId: string): Promise<void>;
  runRetention(tenantId: string): Promise<number>;
  readiness(
    tenantId: string,
    cleanupFreshnessMinutes: number,
  ): Promise<{ ready: boolean; code: string }>;
}

export interface ShadowCliDependencies {
  repository: ShadowCliRepository;
  tenantId: string;
  cleanupFreshnessMinutes: number;
  reportSigning: { keyId: string; privateKey: KeyObject };
  sourceRevision: string;
  now?: () => Date;
}

export interface ShadowCliResult {
  exitCode: 0 | 1;
  output: Record<string, unknown>;
}

type ParsedCommand =
  | { name: 'manifest-register'; file: string }
  | { name: 'import'; file: string }
  | { name: 'batch-close'; campaign: string; batch: string }
  | { name: 'report-export'; campaign: string; output: string }
  | { name: 'report-verify'; bundle: string; publicKey: string }
  | { name: 'campaign-withdraw'; campaign: string; confirm: string }
  | { name: 'retention-run' }
  | { name: 'status' };

function ok(code: string, fields: Record<string, unknown> = {}): ShadowCliResult {
  return { exitCode: 0, output: { status: 'ok', code, ...fields } };
}

function failure(code: string, fields: Record<string, unknown> = {}): ShadowCliResult {
  return { exitCode: 1, output: { status: 'error', code, ...fields } };
}

function options(argv: string[], names: readonly string[]): Record<string, string> | null {
  if (argv.length !== names.length * 2) return null;
  const allowed = new Set(names);
  const result: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith('--') || !value || value.startsWith('--')) return null;
    const name = flag.slice(2);
    if (!allowed.has(name) || result[name] !== undefined) return null;
    result[name] = value;
  }
  return names.every((name) => result[name] !== undefined) ? result : null;
}

function parseCommand(argv: string[]): ParsedCommand | null {
  const [first, second, ...rest] = argv;
  if (first === 'manifest' && second === 'register') {
    const parsed = options(rest, ['file']);
    return parsed ? { name: 'manifest-register', file: parsed.file! } : null;
  }
  if (first === 'import') {
    const parsed = options(
      [second, ...rest].filter((value): value is string => value !== undefined),
      ['file'],
    );
    return parsed ? { name: 'import', file: parsed.file! } : null;
  }
  if (first === 'batch' && second === 'close') {
    const parsed = options(rest, ['campaign', 'batch']);
    return parsed
      ? { name: 'batch-close', campaign: parsed.campaign!, batch: parsed.batch! }
      : null;
  }
  if (first === 'report' && second === 'export') {
    const parsed = options(rest, ['campaign', 'output']);
    return parsed
      ? { name: 'report-export', campaign: parsed.campaign!, output: parsed.output! }
      : null;
  }
  if (first === 'report' && second === 'verify') {
    const parsed = options(rest, ['bundle', 'public-key']);
    return parsed
      ? { name: 'report-verify', bundle: parsed.bundle!, publicKey: parsed['public-key']! }
      : null;
  }
  if (first === 'campaign' && second === 'withdraw') {
    const parsed = options(rest, ['campaign', 'confirm']);
    return parsed
      ? { name: 'campaign-withdraw', campaign: parsed.campaign!, confirm: parsed.confirm! }
      : null;
  }
  if (first === 'retention' && second === 'run' && rest.length === 0)
    return { name: 'retention-run' };
  if (first === 'status' && second === undefined && rest.length === 0) return { name: 'status' };
  return null;
}

async function readBoundedFile(path: string, maximumBytes: number): Promise<Buffer> {
  const handle = await open(path, 'r');
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size > maximumBytes) throw new Error('SHADOW_INPUT_TOO_LARGE');
    const contents = await handle.readFile();
    if (contents.length > maximumBytes) throw new Error('SHADOW_INPUT_TOO_LARGE');
    return contents;
  } finally {
    await handle.close();
  }
}

async function readJson(path: string, maximumBytes: number): Promise<unknown> {
  return JSON.parse((await readBoundedFile(path, maximumBytes)).toString('utf8')) as unknown;
}

async function* ndjsonLines(
  path: string,
): AsyncGenerator<{ line?: Buffer; rejected: boolean }, void, undefined> {
  const stream = createReadStream(path);
  let pieces: Buffer[] = [];
  let pendingBytes = 0;
  let overflow = false;

  for await (const value of stream) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    let start = 0;
    for (let index = 0; index < chunk.length; index += 1) {
      if (chunk[index] !== 0x0a) continue;
      const piece = chunk.subarray(start, index);
      if (!overflow && pendingBytes + piece.length <= MAX_NDJSON_LINE_BYTES) {
        pieces.push(piece);
        pendingBytes += piece.length;
      } else {
        overflow = true;
      }
      yield overflow
        ? { rejected: true }
        : { line: Buffer.concat(pieces, pendingBytes), rejected: false };
      pieces = [];
      pendingBytes = 0;
      overflow = false;
      start = index + 1;
    }
    const tail = chunk.subarray(start);
    if (overflow) continue;
    if (pendingBytes + tail.length <= MAX_NDJSON_LINE_BYTES) {
      pieces.push(tail);
      pendingBytes += tail.length;
    } else {
      pieces = [];
      pendingBytes = 0;
      overflow = true;
    }
  }
  if (overflow) yield { rejected: true };
  else if (pendingBytes > 0) yield { line: Buffer.concat(pieces, pendingBytes), rejected: false };
}

async function verifyReport(command: Extract<ParsedCommand, { name: 'report-verify' }>) {
  const bundle = await readJson(command.bundle, MAX_REPORT_BYTES);
  const publicKey = createPublicKey(await readBoundedFile(command.publicKey, MAX_PUBLIC_KEY_BYTES));
  if (publicKey.asymmetricKeyType !== 'ed25519') return failure('SHADOW_REPORT_KEY_INVALID');
  const verification = verifyShadowReport(bundle, { publicKey });
  return verification.valid ? ok(verification.code) : failure(verification.code);
}

async function importObservations(
  file: string,
  dependencies: ShadowCliDependencies,
): Promise<ShadowCliResult> {
  let imported = 0;
  let rejected = 0;
  let seen = 0;
  for await (const item of ndjsonLines(file)) {
    seen += 1;
    if (seen > MAX_IMPORT_RECORDS || item.rejected || !item.line || item.line.length === 0) {
      rejected += 1;
      continue;
    }
    let observation: unknown;
    try {
      observation = JSON.parse(item.line.toString('utf8')) as unknown;
    } catch {
      rejected += 1;
      continue;
    }
    try {
      await dependencies.repository.importObservation(dependencies.tenantId, observation);
      imported += 1;
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      if (
        /^(?:SHADOW_(?:INVALID|UNKNOWN|MISSING|SIZE|UNSUPPORTED)|SHADOW_DIGEST_MISMATCH|SHADOW_EVALUATION_FAILED)/.test(
          code,
        )
      ) {
        rejected += 1;
        continue;
      }
      throw error;
    }
  }
  return rejected === 0
    ? ok('SHADOW_IMPORT_COMPLETE', { imported, rejected })
    : failure('SHADOW_IMPORT_PARTIAL', { imported, rejected });
}

async function execute(command: ParsedCommand, dependencies: ShadowCliDependencies) {
  switch (command.name) {
    case 'manifest-register': {
      const manifest = parseShadowManifest(await readJson(command.file, MAX_MANIFEST_BYTES));
      const result = await dependencies.repository.registerManifest(
        dependencies.tenantId,
        manifest,
      );
      return ok(
        result.idempotent ? 'SHADOW_MANIFEST_ALREADY_REGISTERED' : 'SHADOW_MANIFEST_REGISTERED',
      );
    }
    case 'import':
      return importObservations(command.file, dependencies);
    case 'batch-close':
      await dependencies.repository.closeDueBatch(
        dependencies.tenantId,
        command.campaign,
        command.batch,
      );
      return ok('SHADOW_BATCH_CLOSED');
    case 'report-export': {
      const data = await dependencies.repository.readReport(
        dependencies.tenantId,
        command.campaign,
      );
      const report = buildSignedShadowReport(data, {
        keyId: dependencies.reportSigning.keyId,
        privateKey: dependencies.reportSigning.privateKey,
        generatedAt: (dependencies.now ?? (() => new Date()))().toISOString(),
        sourceRevision: dependencies.sourceRevision,
      });
      atomicExport(command.output, `${JSON.stringify(report)}\n`);
      return ok('SHADOW_REPORT_EXPORTED');
    }
    case 'campaign-withdraw':
      if (command.confirm !== command.campaign)
        return failure('SHADOW_WITHDRAW_CONFIRMATION_REQUIRED');
      await dependencies.repository.withdrawCampaign(dependencies.tenantId, command.campaign);
      return ok('SHADOW_CAMPAIGN_WITHDRAWN');
    case 'retention-run': {
      const deleted = await dependencies.repository.runRetention(dependencies.tenantId);
      return ok('SHADOW_RETENTION_COMPLETE', { deleted });
    }
    case 'status': {
      const readiness = await dependencies.repository.readiness(
        dependencies.tenantId,
        dependencies.cleanupFreshnessMinutes,
      );
      return readiness.ready ? ok(readiness.code) : failure(readiness.code);
    }
    case 'report-verify':
      return verifyReport(command);
  }
}

async function productionDependencies(): Promise<{
  dependencies: ShadowCliDependencies;
  close: () => Promise<void>;
}> {
  const config = loadShadowStartupConfig();
  const sourceRevision = process.env.COMMANDER_SHADOW_SOURCE_REVISION?.trim();
  if (!sourceRevision || !SOURCE_REVISION.test(sourceRevision)) {
    throw new Error('COMMANDER_SHADOW_SOURCE_REVISION_INVALID');
  }
  const pool = new Pool(config.poolConfig);
  return {
    dependencies: {
      repository: new ShadowRepository(asShadowSqlPool(pool), {
        retentionDays: config.retentionDays,
        trustedManifestPublicKeys: config.trustedManifestPublicKeys,
      }),
      tenantId: config.tenantId,
      cleanupFreshnessMinutes: config.cleanupFreshnessMinutes,
      reportSigning: {
        keyId: config.reportSigningKeyId,
        privateKey: config.reportSigningPrivateKey,
      },
      sourceRevision,
    },
    close: () => pool.end(),
  };
}

export async function runShadowCli(
  argv: string[],
  injectedDependencies?: ShadowCliDependencies,
): Promise<ShadowCliResult> {
  const command = parseCommand(argv);
  if (!command) return failure('SHADOW_USAGE_INVALID');
  try {
    if (command.name === 'report-verify') return await verifyReport(command);
    if (injectedDependencies) return await execute(command, injectedDependencies);
    const production = await productionDependencies();
    try {
      return await execute(command, production.dependencies);
    } finally {
      await production.close();
    }
  } catch {
    return failure('SHADOW_COMMAND_FAILED');
  }
}

async function main(): Promise<void> {
  const result = await runShadowCli(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(result.output)}\n`);
  process.exitCode = result.exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
