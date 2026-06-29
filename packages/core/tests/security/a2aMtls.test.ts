import { describe, it, expect, afterEach, vi } from 'vitest';
import * as selfsigned from 'selfsigned';
import * as https from 'node:https';
import { A2AServer } from '../../src/mcp/a2aServer';
import type { AgentRuntimeInterface } from '../../src/runtime';

// Generate a CA + server cert + client cert pair for mTLS tests.
// selfsigned v5 generate() is async and supports CA-signed cert generation
// via the `ca: { key, cert }` option. We generate a proper CA and sign the
// server and client certs with it so the TLS trust chain is valid.
async function generateTestCerts() {
  // Step 1: self-signed CA with CA:TRUE basic constraint
  const ca = await selfsigned.generate(
    [{ name: 'commonName', value: 'test-ca' }],
    {
      keySize: 2048,
      algorithm: 'sha256',
      extensions: [
        { name: 'basicConstraints', cA: true, critical: true },
        { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
      ],
    },
  );

  // Step 2: server cert signed by the CA (CN + SAN = localhost, EKU = serverAuth)
  const server = await selfsigned.generate(
    [{ name: 'commonName', value: 'localhost' }],
    {
      keySize: 2048,
      algorithm: 'sha256',
      extensions: [
        { name: 'basicConstraints', cA: false },
        { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
        { name: 'extKeyUsage', serverAuth: true },
        { name: 'subjectAltName', altNames: [{ type: 2, value: 'localhost' }] },
      ],
      ca: { key: ca.private, cert: ca.cert },
    },
  );

  // Step 3: client cert signed by the CA (EKU = clientAuth)
  const client = await selfsigned.generate(
    [{ name: 'commonName', value: 'a2a-client' }],
    {
      keySize: 2048,
      algorithm: 'sha256',
      extensions: [
        { name: 'basicConstraints', cA: false },
        { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
        { name: 'extKeyUsage', clientAuth: true },
      ],
      ca: { key: ca.private, cert: ca.cert },
    },
  );

  return {
    ca: ca.cert,
    serverCert: server.cert,
    serverKey: server.private,
    clientCert: client.cert,
    clientKey: client.private,
  };
}

// Minimal stub runtime — A2AServer only calls runtime.execute() during
// JSON-RPC POST dispatch. The agent-card GET endpoint never touches it.
const stubRuntime = {
  execute: vi.fn(),
} as unknown as AgentRuntimeInterface;

const AUTH_TOKEN = 'test-auth-token-0123456789abcdef';

// Fetch the agent card over HTTPS with an mTLS client certificate.
// Uses https.request directly because Node's built-in fetch (undici)
// silently ignores the `agent` option that A2AClient relies on for mTLS.
function fetchAgentCardMtls(
  port: number,
  certs: Awaited<ReturnType<typeof generateTestCerts>>,
): Promise<{ name: string; version: string }> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'localhost',
        port,
        path: '/.well-known/agent-card.json',
        method: 'GET',
        ca: certs.ca,
        cert: certs.clientCert,
        key: certs.clientKey,
        rejectUnauthorized: true,
        servername: 'localhost',
      },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => {
          data += chunk.toString();
        });
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode}: ${data}`));
            return;
          }
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(5000, () => {
      req.destroy(new Error('mTLS request timed out'));
    });
    req.end();
  });
}

describe('A2AServer mTLS', () => {
  let server: A2AServer;

  afterEach(async () => {
    if (server) await server.stop();
  });

  it('starts in plain HTTP mode when tls config is omitted', async () => {
    server = new A2AServer(
      {
        port: 0,
        host: '127.0.0.1',
        agentCard: { name: 'test', version: '1.0', capabilities: {} } as any,
        authToken: AUTH_TOKEN,
      },
      stubRuntime,
    );
    await server.start();
    const port = server.getPort();
    expect(port).toBeGreaterThan(0);
  });

  it('starts in HTTPS mode when tls config is provided', async () => {
    const certs = await generateTestCerts();
    server = new A2AServer(
      {
        port: 0,
        host: '127.0.0.1',
        agentCard: { name: 'test', version: '1.0', capabilities: {} } as any,
        authToken: AUTH_TOKEN,
        tls: {
          cert: certs.serverCert,
          key: certs.serverKey,
          ca: certs.ca,
          requestCert: true,
          rejectUnauthorized: true,
        },
      },
      stubRuntime,
    );
    await server.start();
    const port = server.getPort();
    expect(port).toBeGreaterThan(0);
  });

  it('fails closed when requestCert=true but ca is missing', async () => {
    const certs = await generateTestCerts();
    expect(() => {
      new A2AServer(
        {
          port: 0,
          host: '127.0.0.1',
          agentCard: { name: 'test', version: '1.0', capabilities: {} } as any,
          authToken: AUTH_TOKEN,
          tls: {
            cert: certs.serverCert,
            key: certs.serverKey,
            requestCert: true,
            rejectUnauthorized: true,
            // ca intentionally omitted
          },
        },
        stubRuntime,
      );
    }).not.toThrow(); // constructor doesn't validate; start() does

    server = new A2AServer(
      {
        port: 0,
        host: '127.0.0.1',
        agentCard: { name: 'test', version: '1.0', capabilities: {} } as any,
        authToken: AUTH_TOKEN,
        tls: {
          cert: certs.serverCert,
          key: certs.serverKey,
          requestCert: true,
          rejectUnauthorized: true,
        },
      },
      stubRuntime,
    );
    await expect(server.start()).rejects.toThrow(/ca for client cert verification/);
  });

  it('accepts a client with a valid mTLS certificate', async () => {
    const certs = await generateTestCerts();
    server = new A2AServer(
      {
        port: 0,
        host: '127.0.0.1',
        agentCard: { name: 'test', version: '1.0', capabilities: {} } as any,
        authToken: AUTH_TOKEN,
        tls: {
          cert: certs.serverCert,
          key: certs.serverKey,
          ca: certs.ca,
          requestCert: true,
          rejectUnauthorized: true,
        },
      },
      stubRuntime,
    );
    await server.start();
    const port = server.getPort();

    // Use https.request directly — A2AClient's mTLS agent is silently
    // ignored by Node's built-in fetch (undici), so we bypass it to
    // properly test the server's mTLS handshake.
    const card = await fetchAgentCardMtls(port, certs);
    expect(card.name).toBe('test');
  });
});
