# Approved Data Boundary

Only strict, versioned JSON fields are accepted. Unknown fields are rejected.
Identifiers are 1–128 printable ASCII characters. A canonical observation is at
most 16 KiB; a manifest is at most 2 MiB and declares 1–10,000 records.

## Signed manifest fields

| Field          | Meaning                                                              |
| -------------- | -------------------------------------------------------------------- |
| `schema`       | `commander.shadow-manifest/v1`                                       |
| `campaignId`   | Customer-approved historical evaluation campaign                     |
| `tenantId`     | Dedicated customer tenant binding                                    |
| `producerId`   | Approved historical-data producer identifier                         |
| `policyId`     | Pinned policy identifier                                             |
| `policyDigest` | Lowercase SHA-256 digest of the pinned policy descriptor             |
| `batchId`      | Bounded manifest batch identifier                                    |
| `closesAt`     | Canonical RFC 3339 UTC close time                                    |
| `records`      | Contiguous records containing `index`, `observationId`, and `digest` |
| `keyId`        | Trusted manifest public-key identifier                               |
| `signature`    | Unpadded base64url Ed25519 signature                                 |

## Observation fields

| Field                                             | Meaning                                               |
| ------------------------------------------------- | ----------------------------------------------------- |
| `schema`                                          | `commander.shadow-observation/v1`                     |
| `campaignId`, `tenantId`, `producerId`, `batchId` | Bind observation to its manifest                      |
| `index`, `observationId`                          | Contiguous position and unique observation identifier |
| `occurredAt`                                      | Canonical RFC 3339 UTC historical timestamp           |
| `workflow`                                        | Fixed value `kubernetes.deployment.rollback`          |
| `effectType`, `tool`, `destination`               | Opaque policy facts; each is a string or `null`       |
| `productionDecision`                              | `allow`, `deny`, `require_approval`, or `unknown`     |
| `productionReasonCode`                            | Optional bounded reason code                          |

`digest` is the lowercase SHA-256 digest of canonical observation JSON. Use
`null` when a policy fact is unavailable; Commander records
`insufficient_evidence` rather than inventing a fact.

Do not include HTTP methods, paths, headers, request or response bodies,
prompts, logs, source code, ticket text, email addresses, names, access data,
or other free-form customer content. Opaque identifiers must still preserve the
policy predicate; otherwise they belong as `null`.
