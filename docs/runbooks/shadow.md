# Shadow Pilot Runbook

Commander Shadow Pilot Phase A performs an offline, historical policy
evaluation of declared Kubernetes deployment rollback observations. It does not
join a customer request path and cannot execute, queue, authorize, or recover
a Kubernetes rollback.

Use the customer-facing operating materials in
[`docs/pilot/shadow/README.md`](../pilot/shadow/README.md). The required flow
is to register a signed manifest, import its bounded historical observations,
close the batch, export a signed report, and verify that report independently.

Phase B runtime evaluation is unavailable. Do not configure a proxy, traffic
mirror, replay runner, endpoint, or environment toggle for this pilot. Any
future runtime capability requires its own approved architecture, security
review, and release gate.

## Incident and stop handling

Stop imports and follow the charter's withdrawal process when validation,
tenant binding, policy pinning, TLS readiness, cleanup freshness, or the data
boundary fails. Preserve the signed report and deletion audit supplied by the
customer-operated PostgreSQL evidence store; do not treat a local log or cache
as authoritative evidence.
