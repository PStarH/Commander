import { request } from 'node:https';
import type { Task1KubernetesProofApi, Task1KubernetesProofReadRequest, Task1ProjectedTokenIdentity } from './task1KubernetesProofObserver.js';

type JsonRecord = Record<string, unknown>;

const AUDIENCE = 'commander-tenant-cutover-proof/v1';
const SERVICE_ACCOUNT = /^commander-proof-reader-[0-9a-f]{16}$/;
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const DNS_SUBDOMAIN = /^[a-z0-9](?:[-a-z0-9.]{0,251}[a-z0-9])?$/;
const LABEL_KEY = /^(?:[a-z0-9](?:[-a-z0-9.]{0,251}[a-z0-9])?\/)?[A-Za-z0-9](?:[-_.A-Za-z0-9]{0,61}[A-Za-z0-9])?$/;
const LABEL_VALUE = /^(?:[A-Za-z0-9](?:[-_.A-Za-z0-9]{0,61}[A-Za-z0-9])?)?$/;
const MAX_TOKEN_BYTES = 16 * 1024;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const PROOF_TOKEN_MAX_LIFETIME_SECONDS = 10 * 60;

export interface Task1KubernetesProofApiOptions {
  hostname: string;
  port: number;
  readToken(): Promise<string>;
  readCa(): Promise<Buffer>;
  timeoutMs?: number;
}

function fail(code: string): never {
  throw new Error(code);
}

function record(value: unknown, code: string): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code);
  return value as JsonRecord;
}

function nonempty(value: unknown, code: string): string {
  if (typeof value !== 'string' || value.length === 0) fail(code);
  return value;
}

function safeEpochSeconds(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    fail('TENANT_CUTOVER_KUBERNETES_TOKEN_INVALID');
  }
  return Number(value);
}

export function parseTask1ProjectedTokenIdentity(token: string): Task1ProjectedTokenIdentity {
  if (
    typeof token !== 'string' || token.length === 0 ||
    Buffer.byteLength(token, 'utf8') > MAX_TOKEN_BYTES
  ) fail('TENANT_CUTOVER_KUBERNETES_TOKEN_INVALID');
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
    fail('TENANT_CUTOVER_KUBERNETES_TOKEN_INVALID');
  }
  let payload: JsonRecord;
  try {
    payload = record(
      JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as unknown,
      'TENANT_CUTOVER_KUBERNETES_TOKEN_INVALID',
    );
  } catch {
    return fail('TENANT_CUTOVER_KUBERNETES_TOKEN_INVALID');
  }
  if (
    !Array.isArray(payload.aud) || payload.aud.length !== 1 || payload.aud[0] !== AUDIENCE
  ) fail('TENANT_CUTOVER_KUBERNETES_TOKEN_INVALID');
  const expires = safeEpochSeconds(payload.exp);
  const issued = safeEpochSeconds(payload.iat);
  if (expires <= issued || expires - issued > PROOF_TOKEN_MAX_LIFETIME_SECONDS) {
    fail('TENANT_CUTOVER_KUBERNETES_TOKEN_INVALID');
  }
  const kubernetes = record(payload['kubernetes.io'], 'TENANT_CUTOVER_KUBERNETES_TOKEN_INVALID');
  const namespace = nonempty(kubernetes.namespace, 'TENANT_CUTOVER_KUBERNETES_TOKEN_INVALID');
  const pod = record(kubernetes.pod, 'TENANT_CUTOVER_KUBERNETES_TOKEN_INVALID');
  const serviceAccount = record(
    kubernetes.serviceaccount,
    'TENANT_CUTOVER_KUBERNETES_TOKEN_INVALID',
  );
  const serviceAccountName = nonempty(
    serviceAccount.name,
    'TENANT_CUTOVER_KUBERNETES_TOKEN_INVALID',
  );
  const podName = nonempty(pod.name, 'TENANT_CUTOVER_KUBERNETES_TOKEN_INVALID');
  const podUid = nonempty(pod.uid, 'TENANT_CUTOVER_KUBERNETES_TOKEN_INVALID');
  if (
    !DNS_LABEL.test(namespace) || !DNS_SUBDOMAIN.test(podName) ||
    !SERVICE_ACCOUNT.test(serviceAccountName) ||
    payload.sub !== `system:serviceaccount:${namespace}:${serviceAccountName}`
  ) fail('TENANT_CUTOVER_KUBERNETES_TOKEN_INVALID');
  const expiresAt = new Date(expires * 1_000);
  if (!Number.isFinite(expiresAt.getTime())) fail('TENANT_CUTOVER_KUBERNETES_TOKEN_INVALID');
  return {
    audience: AUDIENCE,
    expiresAt: expiresAt.toISOString(),
    namespace,
    serviceAccountName,
    podName,
    podUid,
  };
}

function selectorQuery(selector: Readonly<Record<string, string>> | undefined): string {
  if (!selector || Object.keys(selector).length === 0) {
    fail('TENANT_CUTOVER_KUBERNETES_REQUEST_INVALID');
  }
  const entries = Object.entries(selector).sort(([left], [right]) => left.localeCompare(right));
  if (entries.some(([key, value]) => !LABEL_KEY.test(key) || !LABEL_VALUE.test(value))) {
    fail('TENANT_CUTOVER_KUBERNETES_REQUEST_INVALID');
  }
  return encodeURIComponent(entries.map(([key, value]) => `${key}=${value}`).join(','));
}

function requestPath(input: Task1KubernetesProofReadRequest): string {
  if (!DNS_LABEL.test(input.namespace) || input.audience !== AUDIENCE) {
    fail('TENANT_CUTOVER_KUBERNETES_REQUEST_INVALID');
  }
  const namespace = encodeURIComponent(input.namespace);
  if (input.resource === 'service' || input.resource === 'deployment') {
    if (!input.name || !DNS_SUBDOMAIN.test(input.name) || input.selector !== undefined) {
      fail('TENANT_CUTOVER_KUBERNETES_REQUEST_INVALID');
    }
    const name = encodeURIComponent(input.name);
    return input.resource === 'service'
      ? `/api/v1/namespaces/${namespace}/services/${name}`
      : `/apis/apps/v1/namespaces/${namespace}/deployments/${name}`;
  }
  if (input.name !== undefined) fail('TENANT_CUTOVER_KUBERNETES_REQUEST_INVALID');
  const resource = input.resource === 'replicaSets' ? 'replicasets' : 'pods';
  const prefix = input.resource === 'replicaSets' ? '/apis/apps/v1' : '/api/v1';
  return `${prefix}/namespaces/${namespace}/${resource}?labelSelector=${selectorQuery(input.selector)}`;
}

export function createTask1KubernetesProofApi(
  options: Task1KubernetesProofApiOptions,
): Task1KubernetesProofApi {
  if (
    !DNS_SUBDOMAIN.test(options.hostname) || !Number.isInteger(options.port) ||
    options.port <= 0 || options.port > 65535
  ) fail('TENANT_CUTOVER_KUBERNETES_CONFIGURATION_INVALID');
  const timeoutMs = options.timeoutMs ?? 2_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_000) {
    fail('TENANT_CUTOVER_KUBERNETES_CONFIGURATION_INVALID');
  }
  return {
    async read(input) {
      const [token, ca] = await Promise.all([options.readToken(), options.readCa()]);
      parseTask1ProjectedTokenIdentity(token);
      if (!Buffer.isBuffer(ca) || ca.length === 0) {
        fail('TENANT_CUTOVER_KUBERNETES_CONFIGURATION_INVALID');
      }
      const path = requestPath(input);
      return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (error?: Error, value?: unknown): void => {
          if (settled) return;
          settled = true;
          if (error) reject(error);
          else resolve(value);
        };
        const call = request({
          hostname: options.hostname,
          port: options.port,
          path,
          method: 'GET',
          agent: false,
          ca,
          rejectUnauthorized: true,
          minVersion: 'TLSv1.2',
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${token}`,
          },
        }, (response) => {
          if (response.statusCode !== 200) {
            response.resume();
            finish(new Error('TENANT_CUTOVER_KUBERNETES_API_REJECTED'));
            return;
          }
          const chunks: Buffer[] = [];
          let bytes = 0;
          response.on('data', (chunk: Buffer) => {
            bytes += chunk.byteLength;
            if (bytes > MAX_RESPONSE_BYTES) {
              call.destroy(new Error('TENANT_CUTOVER_KUBERNETES_RESPONSE_INVALID'));
              return;
            }
            chunks.push(chunk);
          });
          response.once('end', () => {
            try {
              const body = Buffer.concat(chunks).toString('utf8');
              if (!body || body.includes('\0')) {
                finish(new Error('TENANT_CUTOVER_KUBERNETES_RESPONSE_INVALID'));
                return;
              }
              finish(undefined, JSON.parse(body) as unknown);
            } catch {
              finish(new Error('TENANT_CUTOVER_KUBERNETES_RESPONSE_INVALID'));
            }
          });
        });
        call.setTimeout(timeoutMs, () => call.destroy(new Error('TENANT_CUTOVER_KUBERNETES_TIMEOUT')));
        call.once('error', (error) => finish(error));
        call.end();
      });
    },
  };
}
