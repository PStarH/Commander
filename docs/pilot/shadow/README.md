# Commander Shadow Pilot: Phase A

This pack supports a customer-cloud, historical evaluation of one workflow:
`kubernetes.deployment.rollback`. It compares a declared historical sample with
Commander’s pinned policy result. It does not place Commander in the request
path and it does not execute, queue, authorize, or recover a rollback.

Phase A uses the customer-operated PostgreSQL evidence store. Results are
historical policy evidence for the declared sample, not a statement about
unsampled activity or rollback outcomes.

## Operator commands

Run commands inside the dedicated customer environment after its database,
tenant configuration, trusted manifest key, and report signing key have been
set by the named deployment owner. Command output is JSON and does not print
database connection strings or key material.

```text
commander-shadow manifest register --file manifest.json
commander-shadow import --file observations.ndjson
commander-shadow batch close --campaign campaign-2026q4 --batch batch-001
commander-shadow report export --campaign campaign-2026q4 --output report.json
commander-shadow report verify --bundle report.json --public-key report-trust.json
commander-shadow campaign withdraw --campaign campaign-2026q4 --confirm campaign-2026q4
commander-shadow retention run
commander-shadow status
```

The command forms are:

- `manifest register --file`
- `import --file`
- `batch close --campaign --batch`
- `report export --campaign --output`
- `report verify --bundle --public-key`
- `campaign withdraw --campaign --confirm`
- `retention run`
- `status`

Set `COMMANDER_SHADOW_DATABASE_URL` per invocation to the least-privileged role:
use ingestion for manifest registration, import, batch close, and status; reader
for report export; and retention for campaign withdrawal and retention cleanup.
Do not use the installer or database administrator credential for routine CLI
commands. `report verify` does not connect to PostgreSQL.

`report verify` is an offline verification step: it reads the report bundle and
a strict public-key trust record, rather than contacting PostgreSQL. The JSON
record binds the Ed25519 public key to its trusted `keyId` and its `active` or
`revoked` status. It is distributed through the customer’s agreed key-management
process separately from the report; a record supplied with the report is not
independently trusted.

Read these materials in order:

1. [Invitation](invitation.md) for the engagement boundary.
2. [Pilot charter](pilot-charter.md) to establish named owners and acceptance
   criteria before importing a sample.
3. [Data boundary](data-boundary.md) for the only permitted fields.
4. [Historical evaluation](historical-evaluation.md) for the import and report
   workflow.
5. [Security architecture](security-architecture.md) and
   [retention, withdrawal, and teardown](retention-withdrawal-teardown.md) for
   operator review.

Legal/DPA review is an external review owned by the customer and its counsel;
this repository does not supply a DPA or legal advice.
