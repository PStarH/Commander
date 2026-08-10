# Enterprise Pilot Support Runbook

Use this page for the first dedicated pilot. It complements the deployment and
CI handoff runbooks; it does not replace them.

## Health and ownership

- Gateway owner: receives `/health`, `/ready`, and `/metrics` alerts.
- Kernel-ops owner: maintains Postgres timers/outbox and readiness.
- Worker owner: owns leases and controlled restart.
- Adapter-ops owner: owns reconciliation and compensation drain.
- Customer escalation owner: decides whether to keep an unknown action open,
  compensate, or stop the tenant.

No single process may impersonate another role or bypass the Action Gateway.

## Incident handling

1. Record the run id, effect id, action digest, and current state.
2. If the state is `COMPLETION_UNKNOWN`, query the external system first.
3. Do not call the write adapter manually and do not replay with a new
   idempotency key.
4. If the outcome is applied, complete the existing effect and verify evidence.
5. If it is unprovable, leave the action escalated and use the customer
   escalation owner; no blind retry is allowed.
6. Use compensation only after its own policy and approval checks pass.

## Key and credential removal

Revoke the Gateway API key, provider key, and connector credential when the pilot
ends or the kill criteria trigger. Confirm the process has no retained secret in
logs or evidence, then tear down the dedicated namespace/stack.

## Backup and restore

Run the independent DR procedure in [`dr-backup-restore.md`](../runbooks/dr-backup-restore.md)
and retain its report hash. A restore is not accepted unless evidence receipts,
anchors, identity accounting, and outcome state verify after restore.

## Support record

Record only sanitized metadata: UTC timestamps, component, run/effect id, stable
error code, state transition, receipt hash, and remediation. Never attach the
customer prompt, raw provider response, database URL, token, or request payload.
