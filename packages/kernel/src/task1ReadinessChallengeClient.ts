import { createHash, X509Certificate } from 'node:crypto';
import { request } from 'node:https';
import { checkServerIdentity, type PeerCertificate, type TLSSocket } from 'node:tls';
import type { Task1ReadinessChallengeInput } from './task1RolloutProof.js';

const READINESS_PATH = '/ready/tenant-authority/v1';
const SHA256 = /^[0-9a-f]{64}$/;
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const MAX_RESPONSE_BYTES = 8 * 1024;

export interface Task1PinnedReadinessChallengeInput extends Task1ReadinessChallengeInput {
  ca: Buffer | string;
  timeoutMs?: number;
}

function invalid(code: string): never {
  throw new Error(code);
}

function parseTarget(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return invalid('TENANT_CUTOVER_PROOF_URL_INVALID');
  }
  if (
    url.protocol !== 'https:' ||
    !url.hostname ||
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== READINESS_PATH ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    invalid('TENANT_CUTOVER_PROOF_URL_INVALID');
  }
  return url;
}

function verifyIdentity(
  hostname: string,
  certificate: PeerCertificate,
  expectedSpki: string,
): Error | undefined {
  const hostnameError = checkServerIdentity(hostname, certificate);
  if (hostnameError) return hostnameError;
  if (!certificate.raw) return new Error('TENANT_CUTOVER_PROOF_PEER_CERTIFICATE_REQUIRED');
  let observed: string;
  try {
    observed = createHash('sha256')
      .update(
        new X509Certificate(certificate.raw).publicKey.export({ format: 'der', type: 'spki' }),
      )
      .digest('hex');
  } catch {
    return new Error('TENANT_CUTOVER_PROOF_PEER_CERTIFICATE_INVALID');
  }
  return observed === expectedSpki ? undefined : new Error('TENANT_CUTOVER_PROOF_SPKI_MISMATCH');
}

export function requestTask1ReadinessChallenge(
  input: Task1PinnedReadinessChallengeInput,
): Promise<unknown> {
  const url = parseTarget(input.url);
  if (!CHALLENGE.test(input.challenge) || !SHA256.test(input.expectedServerSpkiSha256)) {
    return Promise.reject(new Error('TENANT_CUTOVER_PROOF_CHALLENGE_INVALID'));
  }
  const timeoutMs = input.timeoutMs ?? 2_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_000) {
    return Promise.reject(new Error('TENANT_CUTOVER_PROOF_TIMEOUT_INVALID'));
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, value?: unknown): void => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(value);
    };
    const call = request(
      url,
      {
        method: 'GET',
        agent: false,
        ca: input.ca,
        minVersion: 'TLSv1.3',
        maxVersion: 'TLSv1.3',
        rejectUnauthorized: true,
        servername: url.hostname,
        checkServerIdentity: (hostname, certificate) =>
          verifyIdentity(hostname, certificate, input.expectedServerSpkiSha256),
        headers: {
          Accept: 'application/json',
          'X-Commander-Readiness-Challenge': input.challenge,
        },
      },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          finish(new Error('TENANT_CUTOVER_PROOF_HTTP_STATUS_INVALID'));
          return;
        }
        const chunks: Buffer[] = [];
        let length = 0;
        response.on('data', (chunk: Buffer) => {
          length += chunk.length;
          if (length > MAX_RESPONSE_BYTES) {
            call.destroy(new Error('TENANT_CUTOVER_PROOF_RESPONSE_TOO_LARGE'));
            return;
          }
          chunks.push(chunk);
        });
        response.once('end', () => {
          try {
            const body = Buffer.concat(chunks).toString('utf8');
            if (!body || body.includes('\0')) invalid('TENANT_CUTOVER_PROOF_RESPONSE_INVALID');
            finish(undefined, JSON.parse(body));
          } catch {
            finish(new Error('TENANT_CUTOVER_PROOF_RESPONSE_INVALID'));
          }
        });
      },
    );
    call.once('socket', (socket) => {
      const tlsSocket = socket as TLSSocket;
      tlsSocket.once('secureConnect', () => {
        if (tlsSocket.getProtocol() !== 'TLSv1.3') {
          call.destroy(new Error('TENANT_CUTOVER_PROOF_TLS_VERSION_INVALID'));
        }
      });
    });
    call.setTimeout(timeoutMs, () => call.destroy(new Error('TENANT_CUTOVER_PROOF_TIMEOUT')));
    call.once('error', (error) => finish(error));
    call.end();
  });
}
