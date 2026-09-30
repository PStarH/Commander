# Security Architecture

The Phase A process has no HTTP listener, Kubernetes client, Helm lifecycle,
provider client, action adapter, worker execution path, effect broker, or local
database fallback. It accepts no live source connection. Its only authoritative
store is the dedicated customer PostgreSQL schema.

PostgreSQL access uses verified TLS, a separate installer, non-login capability
roles, and tenant-scoped runtime login roles for ingestion, report reading, and
retention/withdrawal. Every tenant table uses forced row-level security. Access
requires both an installer-owned login-role binding and the transaction-local
tenant set by the repository; an absent or mismatched binding exposes no rows.
Runtime startup verifies the installed schema version, tenant binding, trusted
manifest keys, report signing configuration, retention range, and cleanup
freshness. It does not run migrations.

The ingestion role has no direct table mutation. Four installer-owned,
fixed-search-path functions validate manifest registration, attempt recording,
observation persistence, and due-batch closure before changing report-authoritative
state. The role cannot clear attempt evidence, suppress an observation, close a
batch early, or rewrite campaign state with arbitrary SQL. The retention role
can update only withdrawal fields and cleanup freshness, and can delete pilot
data for its explicit retention and withdrawal duties within its bound tenant.

Manifest signatures are verified before persistence. Observations are bound to
the registered digest, campaign, tenant, batch, and index. Import and withdrawal
take a transaction and campaign row lock. An identical retry returns the stored
decision; a changed retry is rejected. Withdrawal removes payload while retaining
a minimal tombstone and hashed deletion audit.

Offline report verification consumes a separately distributed report trust
record and manifest trust set. Every record binds the expected `keyId`, the
`Ed25519` algorithm, current active or revoked status, and the public key. The
report key cannot establish manifest trust; every embedded manifest signature
is checked against its own active manifest-key record.

The evaluator is deterministic and read-only. An `allow` is a hypothetical
policy result, not execution permission. Missing `effectType`, `tool`, or
`destination` facts return `insufficient_evidence`; malformed or unsupported
facts are rejected. This limited boundary should be reviewed by the customer
security owner before the import begins.
