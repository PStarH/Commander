import type { IncomingMessage, ServerResponse } from 'node:http';
import type {
  CampaignFaultControlHandler,
  FaultControlCommand,
  FaultControlResult,
} from './faultControl.js';

const MAX_BODY_BYTES = 32 * 1024;
const COMMAND_KEYS = new Set([
  'campaignId',
  'tenantId',
  'provider',
  'destination',
  'destinationHash',
  'effectId',
  'idempotencyKey',
  'faults',
  'audience',
  'sourceCommit',
  'imageDigest',
  'expiresAt',
  'nonce',
  'issuer',
  'keyId',
  'workerId',
  'workerGeneration',
]);

export interface FaultControlHandlerPort {
  handle(input: { token: string; command: FaultControlCommand }): Promise<FaultControlResult>;
}

function respond(response: ServerResponse, status: number, body: Record<string, unknown>): void {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}

function bearerToken(request: IncomingMessage): string | null {
  const value = request.headers.authorization;
  if (typeof value !== 'string') return null;
  const match = /^Bearer ([A-Za-z0-9._-]+)$/.exec(value);
  return match?.[1] ?? null;
}

async function readCommand(request: IncomingMessage): Promise<FaultControlCommand | null> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(bytes);
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== COMMAND_KEYS.size ||
    Object.keys(record).some((key) => !COMMAND_KEYS.has(key))
  ) {
    return null;
  }
  const stringKeys = [
    'campaignId',
    'tenantId',
    'provider',
    'destination',
    'destinationHash',
    'effectId',
    'idempotencyKey',
    'audience',
    'sourceCommit',
    'imageDigest',
    'expiresAt',
    'nonce',
    'issuer',
    'keyId',
    'workerId',
  ] as const;
  if (
    stringKeys.some((key) => typeof record[key] !== 'string') ||
    !Number.isInteger(record.workerGeneration) ||
    !Array.isArray(record.faults) ||
    record.faults.some((fault) => typeof fault !== 'string')
  ) {
    return null;
  }
  return {
    campaignId: record.campaignId as string,
    tenantId: record.tenantId as string,
    provider: record.provider as string,
    destination: record.destination as string,
    destinationHash: record.destinationHash as string,
    effectId: record.effectId as string,
    idempotencyKey: record.idempotencyKey as string,
    faults: record.faults,
    audience: record.audience as string,
    sourceCommit: record.sourceCommit as string,
    imageDigest: record.imageDigest as string,
    expiresAt: record.expiresAt as string,
    nonce: record.nonce as string,
    issuer: record.issuer as string,
    keyId: record.keyId as string,
    workerId: record.workerId as string,
    workerGeneration: record.workerGeneration as number,
  };
}

function route(request: IncomingMessage): { campaignId: string } | null {
  if (request.method !== 'PATCH' || !request.url || request.url.includes('?')) return null;
  const match = /^\/v1\/fault-control\/campaigns\/([A-Za-z0-9._-]+)\/execute$/.exec(request.url);
  return match ? { campaignId: match[1] } : null;
}

export async function handleFaultControlRequest(
  request: IncomingMessage,
  response: ServerResponse,
  handler: FaultControlHandlerPort | CampaignFaultControlHandler,
): Promise<boolean> {
  const target = route(request);
  if (!target) return false;
  try {
    const token = bearerToken(request);
    if (!token) {
      respond(response, 401, { error: 'unauthorized' });
      return true;
    }
    const command = await readCommand(request);
    if (!command || command.campaignId !== target.campaignId) {
      respond(response, 400, { error: 'invalid_request' });
      return true;
    }
    const result = await handler.handle({ token, command });
    if (!result.accepted) {
      respond(response, 403, { accepted: false, code: result.code });
      return true;
    }
    respond(response, 200, result);
    return true;
  } catch {
    if (!response.headersSent) respond(response, 503, { error: 'fault_control_unavailable' });
    else response.destroy();
    return true;
  }
}
