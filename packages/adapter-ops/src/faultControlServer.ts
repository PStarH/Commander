import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
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

export interface FaultControlServerHandle {
  port: number;
  close(): Promise<void>;
}

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
  if (request.method !== 'POST' || !request.url || request.url.includes('?')) return null;
  const match = /^\/v1\/fault-control\/campaigns\/([A-Za-z0-9._-]+)\/execute$/.exec(request.url);
  return match ? { campaignId: match[1] } : null;
}

export async function startFaultControlServer(options: {
  port: number;
  handler: FaultControlHandlerPort | CampaignFaultControlHandler;
}): Promise<FaultControlServerHandle> {
  const server: Server = createServer((request, response) => {
    void (async () => {
      const target = route(request);
      if (!target) {
        respond(response, 404, { error: 'not_found' });
        return;
      }
      const token = bearerToken(request);
      if (!token) {
        respond(response, 401, { error: 'unauthorized' });
        return;
      }
      const command = await readCommand(request);
      if (!command || command.campaignId !== target.campaignId) {
        respond(response, 400, { error: 'invalid_request' });
        return;
      }
      const result = await options.handler.handle({ token, command });
      if (!result.accepted) {
        respond(response, 403, { accepted: false, code: result.code });
        return;
      }
      respond(response, 200, result);
    })().catch(() => {
      if (!response.headersSent) respond(response, 503, { error: 'fault_control_unavailable' });
      else response.destroy();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.once('listening', resolve);
    server.listen(options.port);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : options.port;
  return {
    port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
