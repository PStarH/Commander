#!/usr/bin/env node
/**
 * bench-failover-worker.js — primary worker used by failover RTO drills.
 *
 * Binds a TCP port and notifies the parent when ready. The parent then SIGKILLs
 * this process and measures how long it takes for a secondary server to reclaim
 * the same port — a proxy for real failover RTO.
 *
 * Protocol:
 *   parent -> child: { type: 'work', payload: any }
 *   child  -> parent: { type: 'work_done', pid, leaseId, workDone }
 *   child  -> parent: { type: 'ready', port, pid, leaseId }   (on startup)
 */
const net = require('net');

const port = Number.parseInt(process.argv[2], 10);
if (!Number.isFinite(port)) {
  console.error('Usage: bench-failover-worker.js <port> [leaseId]');
  process.exit(1);
}

const leaseId = process.argv[3] || `lease-${process.pid}`;
let workDone = 0;

const server = net.createServer((socket) => {
  // Minimal heartbeat/ack so the socket is actually exercised.
  socket.write(`ok pid=${process.pid} lease=${leaseId} work=${workDone}`);
  socket.end();
});

server.listen(port, '127.0.0.1', () => {
  if (process.send) {
    process.send({ type: 'ready', port, pid: process.pid, leaseId });
  }
});

process.on('message', (msg) => {
  if (msg?.type === 'work') {
    workDone++;
    if (process.send) {
      process.send({ type: 'work_done', pid: process.pid, leaseId, workDone });
    }
  }
});

// Hold the port until the process is killed; do not gracefully close on SIGTERM
// because the benchmark intentionally exercises abrupt failure.
process.on('SIGTERM', () => {
  // Intentional no-op to keep the port held.
});
