import { readFileSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { resolve } from 'node:path';
import { createSecureContext, TLSSocket } from 'node:tls';
import { pathToFileURL } from 'node:url';

function port(name, fallback) {
  const raw = process.env[name] ?? String(fallback);
  if (!/^[1-9][0-9]*$/.test(raw) || Number(raw) > 65_535) throw new Error(`${name}_INVALID`);
  return Number(raw);
}

const POSTGRES_SSL_REQUEST = Buffer.from('0000000804d2162f', 'hex');

export function createPostgresSslRequestReader(onAccepted, onRejected) {
  let request = Buffer.alloc(0);
  let finished = false;
  return (chunk) => {
    if (finished) return;
    request = Buffer.concat([request, chunk]);
    if (request.length < POSTGRES_SSL_REQUEST.length) return;
    finished = true;
    if (request.length === POSTGRES_SSL_REQUEST.length && request.equals(POSTGRES_SSL_REQUEST)) {
      onAccepted();
    } else {
      onRejected();
    }
  };
}

async function main() {
  const stateDirectory = process.env.FIXTURE_STATE_DIR;
  if (!stateDirectory) throw new Error('FIXTURE_STATE_DIR_REQUIRED');
  const directPort = port('DIRECT_PORT', 55_432);
  const l4Port = port('L4_PORT', 55_433);
  const terminatingPort = port('TERMINATING_PORT', 55_434);

  const l4Server = createServer((downstream) => {
    const upstream = createConnection({ host: '127.0.0.1', port: directPort });
    downstream.pipe(upstream).pipe(downstream);
    downstream.on('error', () => upstream.destroy());
    upstream.on('error', () => downstream.destroy());
  });

  const secureContext = createSecureContext({
    cert: readFileSync(resolve(stateDirectory, 'terminator.crt')),
    key: readFileSync(resolve(stateDirectory, 'terminator.key')),
    minVersion: 'TLSv1.3',
  });

  const terminatingServer = createServer((socket) => {
    const accept = () => {
      socket.off('data', readRequest);
      socket.write('S', () => {
        const tlsSocket = new TLSSocket(socket, { isServer: true, secureContext });
        tlsSocket.on('error', () => tlsSocket.destroy());
        tlsSocket.on('secure', () => tlsSocket.end());
      });
    };
    const readRequest = createPostgresSslRequestReader(accept, () => socket.destroy());
    socket.on('data', readRequest);
  });

  await Promise.all([
    new Promise((resolveListen, reject) => {
      l4Server.once('error', reject);
      l4Server.listen(l4Port, '127.0.0.1', resolveListen);
    }),
    new Promise((resolveListen, reject) => {
      terminatingServer.once('error', reject);
      terminatingServer.listen(terminatingPort, '127.0.0.1', resolveListen);
    }),
  ]);

  process.stdout.write('READY postgres-tls-fixture-proxies\n');

  function close() {
    l4Server.close();
    terminatingServer.close();
  }

  process.once('SIGINT', close);
  process.once('SIGTERM', close);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
