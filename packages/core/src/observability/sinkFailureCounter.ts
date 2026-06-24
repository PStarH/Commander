/**
 * sinkFailureCounter — single-source-of-truth helper for the
 * `audit_sink_failures_total{sink="…"}` Prometheus counter.
 *
 * Phase 2.3 introduced this counter at three throw/catch sites:
 *   • capabilityToken.ts `safelyFireAudit` catch (labels: auditLogger | auditChain)
 *   • toolApproval.ts `tokenRejectedLogger` catch (label: tokenRejectedLogger)
 *   • getCapabilityTokenIssuer() audit-chain ledger fallback (label: auditChain)
 *
 * Phase 2.3.5 DRY-extracts the metric call into one shared helper so the
 * metric name, help text, and label schema cannot drift between call sites.
 *
 * Defensive contract: the inner metrics-collector call is wrapped in a
 * try/catch with a last-resort swallow. A metrics-side failure must NEVER
 * propagate back to the underlying audit/observability pipeline it sits
 * inside.
 */
import { reportSilentFailure } from '../silentFailureReporter';
import { getMetricsCollector } from '../runtime/metricsCollector';

/**
 * Canonical metric name, exported so dashboard configs, alerts, and tests
 * can pin to the constant rather than typing the literal at every site.
 * Renaming the metric is a single-line change.
 */
export const AUDIT_SINK_FAILURES_METRIC = 'audit_sink_failures_total';

const SINK_LABEL = 'sink';

/**
 * Increment the `audit_sink_failures_total{sink="<sink>"}` counter by 1.
 * Called from any try/catch branch that swallowed an audit/observability
 * sink throw. Counter monotonic per `{sink="…"}` label combination.
 */
export function recordSinkFailure(sink: string): void {
  try {
    getMetricsCollector().incrementCounter(
      AUDIT_SINK_FAILURES_METRIC,
      'Audit/observability sink failures (silent swallows)',
      1,
      [{ name: SINK_LABEL, value: sink }],
    );
  } catch (err) {
    reportSilentFailure(err, 'sinkFailureCounter:43');
    /* metrics collector unavailable — last-resort swallow */
  }
}
