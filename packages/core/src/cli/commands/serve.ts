/**
 * `commander serve` — Start the Commander HTTP API Server.
 *
 * Starts CommanderHttpServer on the configured port (default 3001),
 * providing the full `/api/v1/*` REST API that the Python SDK and
 * other external clients connect to.
 *
 * On startup, the server activates:
 * - SecurityAnomalyDetector (7 anomaly types, auto-revokes capabilities)
 * - OutboundNetworkPolicy (egress firewall + SSRF defense)
 * - RecoveryBootstrapper (zombie run recovery)
 * - DataRetentionJanitor (GDPR/SOC2 compliance)
 *
 * Usage:
 *   commander serve                    Start on port 3001
 *   commander serve --port=4000        Start on custom port
 *   commander serve --host=0.0.0.0     Bind to all interfaces
 *   commander serve --api-key=secret   Set API key for authentication
 */

import { $, section } from './_shared';
import { createHttpServer } from '../../runtime/httpServer';
import {
  startSecurityAnomalyDetector,
  resetSecurityAnomalyDetector,
} from '../../security/securityAnomalyDetector';
import {
  installOutboundNetworkPolicy,
  resetOutboundNetworkPolicy,
} from '../../security/outboundNetworkPolicy';
import { getAuditChainLedger } from '../../security/auditChainLedger';
import {
  installAuditChainIntegrity,
  resetAuditChainIntegrity,
} from '../../security/auditChainIntegrity';

function tryStartComponent(label: string, start: () => void, reset: () => void): boolean {
  try {
    reset();
    start();
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(`  ${$.yellow}!${$.reset} ${label} failed to start: ${message}`);
    return false;
  }
}

export async function cmdServe(args: string[]): Promise<void> {
  const { flags } = parseServeFlags(args);

  const port = parseInt(flags.port || process.env.COMMANDER_PORT || '3001', 10);
  const host = flags.host || process.env.HOST || '127.0.0.1';
  const apiKey = flags['api-key'] || process.env.COMMANDER_API_KEY || '';

  section('COMMANDER API SERVER');

  console.log(`  ${$.dim}Starting Commander HTTP API Server...${$.reset}`);
  console.log(`  ${$.dim}Host:${$.reset}     ${host}`);
  console.log(`  ${$.dim}Port:${$.reset}     ${port}`);
  console.log(
    `  ${$.dim}Auth:${$.reset}     ${apiKey ? 'enabled (Bearer token)' : 'auto-generated key'}`,
  );
  console.log();

  try {
    const server = createHttpServer({
      port,
      host,
      apiKey: apiKey || undefined,
    });

    await server.start();

    const anomalyDetectorStarted = tryStartComponent(
      'SecurityAnomalyDetector',
      () => startSecurityAnomalyDetector(),
      () => resetSecurityAnomalyDetector(),
    );
    const outboundPolicyInstalled = tryStartComponent(
      'OutboundNetworkPolicy',
      () => installOutboundNetworkPolicy(),
      () => resetOutboundNetworkPolicy(),
    );
    const auditIntegrityInstalled = tryStartComponent(
      'AuditChainIntegrity',
      () => {
        // Opt-in via COMMANDER_AUDIT_MANIFEST_DIR (WS9 compose sets this).
        if (!process.env.COMMANDER_AUDIT_MANIFEST_DIR) return;
        installAuditChainIntegrity(getAuditChainLedger());
      },
      () => resetAuditChainIntegrity(),
    );

    console.log(
      `  ${$.green}✓${$.reset} Server listening on ${$.cyan}http://${host}:${port}${$.reset}`,
    );
    console.log(`  ${$.green}✓${$.reset} API endpoints:`);
    console.log(`    ${$.dim}POST /api/v1/execute   — Execute agent task${$.reset}`);
    console.log(`    ${$.dim}POST /api/v1/plan      — Zero-cost deliberation${$.reset}`);
    console.log(`    ${$.dim}POST /api/v1/memory    — Memory operations${$.reset}`);
    console.log(`    ${$.dim}GET  /api/v1/status    — System status${$.reset}`);
    console.log(`    ${$.dim}GET  /stream?id=...    — SSE event stream${$.reset}`);
    console.log(`    ${$.dim}GET  /health           — Health check${$.reset}`);
    console.log(`    ${$.dim}GET  /metrics          — Prometheus metrics${$.reset}`);
    console.log(`    ${$.dim}GET  /openapi.json     — OpenAPI 3.0 spec${$.reset}`);
    console.log();
    console.log(`  ${$.green}✓${$.reset} Security components activated:`);
    console.log(
      `    ${$.dim}SecurityAnomalyDetector — ${anomalyDetectorStarted ? '7 anomaly types monitored' : 'not started'}${$.reset}`,
    );
    console.log(
      `    ${$.dim}OutboundNetworkPolicy   — ${outboundPolicyInstalled ? 'egress firewall + SSRF defense' : 'not installed'}${$.reset}`,
    );
    console.log(
      `    ${$.dim}AuditChainIntegrity     — ${auditIntegrityInstalled && process.env.COMMANDER_AUDIT_MANIFEST_DIR ? 'manifest + verify timer' : 'not installed (set COMMANDER_AUDIT_MANIFEST_DIR)'}${$.reset}`,
    );
    console.log(`    ${$.dim}RecoveryBootstrapper    — zombie run recovery${$.reset}`);
    console.log();
    console.log(`  ${$.dim}Press Ctrl+C to stop${$.reset}`);
    console.log();

    // Keep the process alive
    const shutdown = () => {
      console.log(`\n  ${$.yellow}Shutting down...${$.reset}`);
      server
        .stop()
        .then(() => process.exit(0))
        .catch(() => process.exit(1));
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    await new Promise(() => {});
  } catch (err) {
    console.error(
      `\n  ${$.red}✗ Failed to start server: ${err instanceof Error ? err.message : String(err)}${$.reset}\n`,
    );
    process.exit(1);
  }
}

function parseServeFlags(args: string[]): { flags: Record<string, string> } {
  const flags: Record<string, string> = {};
  for (const arg of args) {
    if (arg.startsWith('--')) {
      const [key, ...valParts] = arg.slice(2).split('=');
      const val = valParts.join('=') || 'true';
      flags[key] = val;
    }
  }
  return { flags };
}
