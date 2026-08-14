#!/usr/bin/env tsx
import { createHash, createPublicKey, type JsonWebKeyInput } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  verifyEvidenceReceipt,
  type EvidenceVerificationResult,
} from '../packages/effect-broker/src/evidenceReceipt.js';
import type { EvidenceJwks } from '../packages/effect-broker/src/evidenceSigner.js';
import type { SignedEvidenceBundle } from '../packages/effect-broker/src/signedEvidence.js';

const TERMINAL_STATES = new Set(['SUCCEEDED']);

export interface GatewayCampaignOptions {
  gatewayUrl: string;
  submitBearerToken: string;
  approverBearerToken: string;
  tenantId: string;
  source: string;
  packageName: string;
  model: string;
  tool: string;
  destination: string;
  effectType: string;
  args: Record<string, unknown>;
  idempotencyKey: string;
  evidenceJwks: EvidenceJwks;
  sourceSha: string;
  imageDigest: string;
  outputDir: string;
  pollIntervalMs?: number;
  timeoutMs?: number;
}

export interface GatewayCampaignArtifact {
  schemaVersion: 1;
  verdict: 'PASS' | 'FAILED';
  sourceSha: string;
  imageDigest: string;
  gatewayOrigin: string;
  action: {
    runId: string;
    effectId: string;
    actionDigest: string;
    destinationSha256: string;
    states: string[];
  };
  recovery: { observedCompletionUnknown: boolean; terminalState: string };
  receipt: {
    bundleId: string;
    sha256: string;
    terminalDisposition: string;
    verification: EvidenceVerificationResult;
  };
  hashes: { artifactInputSha256: string; receiptSha256: string };
  cleanup: { terminalEvidenceObserved: true; persistedSecrets: false };
}

export interface GatewayCampaignResult {
  verdict: 'PASS';
  artifact: GatewayCampaignArtifact;
  artifactPath: string;
}

type GatewayAction = {
  runId: string;
  effectId?: string;
  actionDigest: string;
  policySnapshotId?: string;
  simulation?: { simulationId?: string };
  state?: string;
};

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function nonEmpty(name: string, value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${name}_REQUIRED`);
  return trimmed;
}

function gatewayOrigin(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('G3_GATEWAY_URL_INVALID');
  }
  const loopback =
    url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('G3_GATEWAY_HTTPS_REQUIRED');
  }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('G3_GATEWAY_URL_INVALID');
  }
  return url.origin;
}

function hasUsableEvidenceJwk(jwks: EvidenceJwks): boolean {
  return jwks.keys.some((candidate) => {
    if (
      candidate.kty !== 'OKP' ||
      candidate.crv !== 'Ed25519' ||
      typeof candidate.kid !== 'string' ||
      !candidate.kid ||
      typeof candidate.x !== 'string' ||
      !candidate.x
    ) {
      return false;
    }
    try {
      createPublicKey({ key: candidate, format: 'jwk' } as JsonWebKeyInput);
      return true;
    } catch {
      return false;
    }
  });
}

function assertOptions(options: GatewayCampaignOptions): string {
  const origin = gatewayOrigin(nonEmpty('G3_GATEWAY_URL', options.gatewayUrl));
  nonEmpty('G3_SUBMIT_BEARER_TOKEN', options.submitBearerToken);
  nonEmpty('G3_APPROVER_BEARER_TOKEN', options.approverBearerToken);
  nonEmpty('G3_TENANT_ID', options.tenantId);
  nonEmpty('G3_SOURCE', options.source);
  nonEmpty('G3_PACKAGE', options.packageName);
  nonEmpty('G3_MODEL', options.model);
  nonEmpty('G3_TOOL', options.tool);
  nonEmpty('G3_DESTINATION', options.destination);
  nonEmpty('G3_EFFECT_TYPE', options.effectType);
  nonEmpty('G3_IDEMPOTENCY_KEY', options.idempotencyKey);
  nonEmpty('G3_OUTPUT_DIR', options.outputDir);
  if (!/^[a-f0-9]{40}$/i.test(options.sourceSha)) throw new Error('G3_SOURCE_SHA_INVALID');
  if (!/^sha256:[a-f0-9]{64}$/.test(options.imageDigest))
    throw new Error('G3_IMAGE_DIGEST_INVALID');
  if (
    !options.evidenceJwks ||
    !Array.isArray(options.evidenceJwks.keys) ||
    !hasUsableEvidenceJwk(options.evidenceJwks)
  ) {
    throw new Error('G3_EVIDENCE_JWKS_INVALID');
  }
  return origin;
}

async function requestJson<T>(
  method: string,
  url: string,
  token: string,
  body?: unknown,
): Promise<T> {
  const response = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`G3_GATEWAY_HTTP_${response.status}`);
  try {
    return (await response.json()) as T;
  } catch {
    throw new Error('G3_GATEWAY_RESPONSE_INVALID');
  }
}

function actionFrom(value: unknown): GatewayAction {
  const action = (value as { action?: unknown })?.action;
  if (!action || typeof action !== 'object') throw new Error('G3_GATEWAY_ACTION_INVALID');
  const record = action as Record<string, unknown>;
  if (typeof record.runId !== 'string' || typeof record.actionDigest !== 'string') {
    throw new Error('G3_GATEWAY_ACTION_INVALID');
  }
  return record as GatewayAction;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitizeReceipt(
  receipt: SignedEvidenceBundle,
  verification: EvidenceVerificationResult,
): GatewayCampaignArtifact['receipt'] {
  return {
    bundleId: receipt.bundleId,
    sha256: sha256(receipt),
    terminalDisposition: receipt.terminalDisposition,
    verification,
  };
}

export async function runGatewayCampaign(
  options: GatewayCampaignOptions,
): Promise<GatewayCampaignResult> {
  const origin = assertOptions(options);
  const submitted = actionFrom(
    await requestJson('POST', `${origin}/v1/actions`, options.submitBearerToken, {
      source: options.source,
      package: options.packageName,
      model: options.model,
      tool: options.tool,
      destination: options.destination,
      effectType: options.effectType,
      args: options.args,
      idempotencyKey: options.idempotencyKey,
    }),
  );
  if (!submitted.simulation?.simulationId || !submitted.policySnapshotId) {
    throw new Error('G3_GATEWAY_APPROVAL_BINDING_MISSING');
  }
  await requestJson(
    'POST',
    `${origin}/v1/actions/${encodeURIComponent(submitted.runId)}/approve`,
    options.approverBearerToken,
    {
      actionDigest: submitted.actionDigest,
      simulationId: submitted.simulation.simulationId,
      policySnapshotId: submitted.policySnapshotId,
    },
  );

  const states: string[] = [];
  let observedCompletionUnknown = false;
  let observed: GatewayAction | undefined;
  const timeoutAt = Date.now() + (options.timeoutMs ?? 5 * 60_000);
  while (Date.now() < timeoutAt) {
    observed = actionFrom(
      await requestJson(
        'GET',
        `${origin}/v1/actions/${encodeURIComponent(submitted.runId)}`,
        options.submitBearerToken,
      ),
    );
    const state = typeof observed.state === 'string' ? observed.state : '';
    if (!state) throw new Error('G3_GATEWAY_ACTION_STATE_INVALID');
    states.push(state);
    observedCompletionUnknown ||= state === 'COMPLETION_UNKNOWN';
    if (state === 'COMPLETION_UNKNOWN') {
      await requestJson(
        'POST',
        `${origin}/v1/actions/${encodeURIComponent(submitted.runId)}/reconcile`,
        options.submitBearerToken,
      );
    }
    if (observedCompletionUnknown && TERMINAL_STATES.has(state)) break;
    await sleep(options.pollIntervalMs ?? 1_000);
  }
  if (!observedCompletionUnknown || !observed?.state || !TERMINAL_STATES.has(observed.state)) {
    throw new Error('G3_GATEWAY_RECOVERY_NOT_OBSERVED');
  }
  if (!observed.effectId || observed.actionDigest !== submitted.actionDigest) {
    throw new Error('G3_GATEWAY_EFFECT_BINDING_INVALID');
  }

  const evidence = await requestJson<{ receipt?: unknown; verification?: unknown }>(
    'GET',
    `${origin}/v1/actions/${encodeURIComponent(submitted.runId)}/evidence`,
    options.submitBearerToken,
  );
  const receipt = evidence.receipt as SignedEvidenceBundle;
  const verification = verifyEvidenceReceipt(receipt, options.evidenceJwks);
  if (
    !verification.ok ||
    receipt.scope.tenantId !== options.tenantId ||
    receipt.scope.runId !== submitted.runId ||
    receipt.scope.effectId !== observed.effectId ||
    receipt.actionDigest !== submitted.actionDigest
  ) {
    throw new Error(`G3_EVIDENCE_INVALID${verification.reason ? `_${verification.reason}` : ''}`);
  }

  const sanitizedReceipt = sanitizeReceipt(receipt, verification);
  const artifact: GatewayCampaignArtifact = {
    schemaVersion: 1,
    verdict: 'PASS',
    sourceSha: options.sourceSha,
    imageDigest: options.imageDigest,
    gatewayOrigin: origin,
    action: {
      runId: submitted.runId,
      effectId: observed.effectId,
      actionDigest: submitted.actionDigest,
      destinationSha256: sha256(options.destination),
      states,
    },
    recovery: { observedCompletionUnknown, terminalState: observed.state },
    receipt: sanitizedReceipt,
    hashes: {
      artifactInputSha256: sha256({
        sourceSha: options.sourceSha,
        imageDigest: options.imageDigest,
        tenantId: options.tenantId,
        destination: options.destination,
        runId: submitted.runId,
        effectId: observed.effectId,
        actionDigest: submitted.actionDigest,
      }),
      receiptSha256: sanitizedReceipt.sha256,
    },
    cleanup: { terminalEvidenceObserved: true, persistedSecrets: false },
  };
  await mkdir(options.outputDir, { recursive: true });
  const artifactPath = resolve(options.outputDir, `g3-gateway-campaign-${submitted.runId}.json`);
  await writeFile(artifactPath, `${stableJson(artifact)}\n`, 'utf8');
  return { verdict: 'PASS', artifact, artifactPath };
}

function requiredEnv(name: string): string {
  return nonEmpty(name, process.env[name] ?? '');
}

export function optionsFromEnv(env: NodeJS.ProcessEnv = process.env): GatewayCampaignOptions {
  const required = (name: string) => nonEmpty(name, env[name] ?? '');
  return {
    gatewayUrl: required('COMMANDER_G3_GATEWAY_URL'),
    submitBearerToken: required('COMMANDER_G3_SUBMIT_BEARER_TOKEN'),
    approverBearerToken: required('COMMANDER_G3_APPROVER_BEARER_TOKEN'),
    tenantId: required('COMMANDER_G3_TENANT_ID'),
    source: required('COMMANDER_G3_SOURCE'),
    packageName: required('COMMANDER_G3_PACKAGE'),
    model: required('COMMANDER_G3_MODEL'),
    tool: required('COMMANDER_G3_TOOL'),
    destination: required('COMMANDER_G3_DESTINATION'),
    effectType: required('COMMANDER_G3_EFFECT_TYPE'),
    args: (() => {
      try {
        const value: unknown = JSON.parse(required('COMMANDER_G3_ARGS_JSON'));
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
        return value as Record<string, unknown>;
      } catch {
        throw new Error('COMMANDER_G3_ARGS_JSON_INVALID');
      }
    })(),
    idempotencyKey: required('COMMANDER_G3_IDEMPOTENCY_KEY'),
    evidenceJwks: (() => {
      try {
        const value: unknown = JSON.parse(required('COMMANDER_G3_EVIDENCE_JWKS_JSON'));
        if (
          !value ||
          typeof value !== 'object' ||
          !Array.isArray((value as { keys?: unknown }).keys)
        )
          throw new Error();
        return value as EvidenceJwks;
      } catch {
        throw new Error('COMMANDER_G3_EVIDENCE_JWKS_JSON_INVALID');
      }
    })(),
    sourceSha: required('COMMANDER_G3_SOURCE_SHA'),
    imageDigest: required('COMMANDER_G3_IMAGE_DIGEST'),
    outputDir: required('COMMANDER_G3_OUTPUT_DIR'),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runGatewayCampaign(optionsFromEnv())
    .then((result) =>
      process.stdout.write(
        `${JSON.stringify({ verdict: result.verdict, artifactPath: result.artifactPath })}\n`,
      ),
    )
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : 'G3_CAMPAIGN_FAILED'}\n`);
      process.exitCode = 1;
    });
}
