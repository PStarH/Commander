# Historical Evaluation Workflow

Phase A is limited to historical Kubernetes deployment rollback policy
evaluation. The customer creates and signs a manifest, imports only declared
observations, closes the batch, exports a signed report, and verifies that
report independently.

## Steps

1. The policy owner records the `policyId` and `policyDigest` in the charter.
2. The sample owner prepares a signed manifest with immutable `records` and
   `closesAt`, then uses `manifest register --file`.
3. The sample owner imports bounded NDJSON observations with `import --file`.
   A retry with identical content is idempotent; changed content for an existing
   identity is a conflict.
4. After the observation window, the operator runs `batch close --campaign
--batch`. Every manifest index becomes exactly one terminal state:
   `missing`, `rejected`, `failed`, `uncomparable`, or `compared`.
5. The export owner runs `report export --campaign --output`, then the intended
   reader uses `report verify --bundle --public-key` outside the database path.
6. The mismatch-adjudication owner reviews differences. `allow`, `deny`, and
   `require_approval` remain distinct. `unknown` production decisions and
   `insufficient_evidence` hypothetical decisions are uncomparable.

The report contains `generatedAt`, `sourceRevision`, `evaluatorVersion`,
`campaignId`, `policySnapshot`, `manifests`, `records`, `counts`,
`decisionMatrix`, `differences`, `hashes`, `keyId`, and `signature`. It has no
cost field and cannot show whether any rollback succeeded.

## What signatures establish

The detached Ed25519 report signature binds the canonical report body to the
identified report key. Verification also recomputes the manifests, records, and
policy hashes; checks the pinned policy snapshot; and deterministically
re-evaluates observed facts. Signatures do not establish that the declared
sample is complete, that an opaque identifier is truthful, that an approval was
authentic, or that a rollback was performed.

See [the 100-record example](example-report.json). Its 100 expected records are
split into 80 compared, 10 uncomparable, 5 missing, 3 rejected, and 2 failed.
