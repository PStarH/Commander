# Security Architecture

The Phase A process has no HTTP listener, Kubernetes client, Helm lifecycle,
provider client, action adapter, worker execution path, effect broker, or local
database fallback. It accepts no live source connection. Its only authoritative
store is the dedicated customer PostgreSQL schema.

PostgreSQL access uses verified TLS and distinct fixed roles for installation,
ingestion, report reading, and retention/withdrawal. Runtime startup verifies
the installed schema version, tenant binding, trusted manifest keys, report
signing configuration, retention range, and cleanup freshness. It does not run
migrations.

The ingestion role can update only retention, batch-closure, and expected-record
attempt/status columns used by repository transactions; it cannot rewrite a
stored manifest, policy identity, digest, canonical observation, or decision.
The retention role can update only withdrawal fields and cleanup freshness, and
can delete pilot data for its explicit retention and withdrawal duties.

Manifest signatures are verified before persistence. Observations are bound to
the registered digest, campaign, tenant, batch, and index. Import and withdrawal
take a transaction and campaign row lock. An identical retry returns the stored
decision; a changed retry is rejected. Withdrawal removes payload while retaining
a minimal tombstone and hashed deletion audit.

Offline report verification consumes a separately distributed JSON trust record
that binds the expected `keyId`, the `Ed25519` algorithm, current revocation
status, and the public key. The report's signed `keyId` must match that trusted
record.

The evaluator is deterministic and read-only. An `allow` is a hypothetical
policy result, not execution permission. Missing `effectType`, `tool`, or
`destination` facts return `insufficient_evidence`; malformed or unsupported
facts are rejected. This limited boundary should be reviewed by the customer
security owner before the import begins.
