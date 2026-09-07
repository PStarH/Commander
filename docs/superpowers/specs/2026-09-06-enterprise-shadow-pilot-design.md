# Enterprise Shadow Pilot Design

**Status:** Revised direction; phase acceptance required before activation
**Date:** 2026-09-07
**Owner:** Commander engineering
**Target:** One dedicated, customer-cloud E0-SHADOW deployment

## 1. Goal

Deliver a trustworthy enterprise Shadow Pilot for the governed Kubernetes
deployment rollback workflow. The pilot begins with offline replay and may move
to low-volume live observation after customer approval. It must never replay an
original HTTP request or acquire authority to write to Kubernetes or another
customer system.

This work makes E0-SHADOW deployable. It does not authorize E1 writes, shared
multi-tenant hosting, a production-readiness claim, or a legal/compliance claim.

## 2. Customer Offer

Commander is deployed as one dedicated stack inside the customer's cloud. The
customer retains control of data, network policy, PostgreSQL, encryption, and
deployment credentials. Commander engineering assists with installation and
operation.

The engagement has two independently deliverable phases:

1. **Phase A, historical evaluation:** the customer registers a reviewed manifest
   and imports approved observations with a dedicated CLI inside its environment.
   Deliver import/export/verify/delete commands and an example report. PostgreSQL
   and a report signing key are required; HTTP, Helm, service certificates, and
   production integration are not. Offline means no live-source/provider access,
   not no database connection. This phase is accepted and delivered independently.
2. **Phase B, live observation:** after the customer accepts the offline evidence, an
   approved producer asynchronously submits a small sample of the same records
   to the dedicated Shadow service.

The customer's existing system remains authoritative in both stages. Commander
returns only a hypothetical admission result and drift evidence. It cannot
execute or enqueue the proposed action.

## 3. Non-Negotiable Boundaries

- Support only `kubernetes.deployment.rollback` in the first pilot.
- Accept only a versioned observation envelope over a fixed ingestion route.
- Never forward the original method, path, headers, body, prompt, or response.
- Reject unknown fields and unapproved field classes before persistence.
- Do not load EffectBroker, worker execution, action adapters, tool execution,
  Kubernetes clients, or LLM providers in the Shadow process.
- Do not mount Kubernetes credentials or provider credentials.
- Use PostgreSQL as the only authoritative evidence store. In-memory computation
  is allowed; JSON, SQLite, Redis, and local persistence fallbacks are not.
  Permitted writes are limited to the dedicated Shadow schema and explicit
  owner-only exports. Target-system writes remain forbidden.
- Bind every record to one dedicated tenant and reject cross-tenant reads or
  writes.
- Default to loopback binding outside containers; the Helm deployment must
  explicitly bind its private service interface.
- Fail startup when authentication, tenant, PostgreSQL, retention, or signing
  configuration is absent or invalid.
- Never describe E0-SHADOW evidence as `PROVEN`, live-write evidence, or customer
  acceptance.

## 4. Architecture

### 4.1 Components

**Producer integration**

The customer-owned producer creates a canonical observation envelope after its
own request completes. It submits asynchronously and does not place Commander
in the production response path. The repository will provide an offline NDJSON
validator/replay command and an HTTP submission contract, not a transparent
proxy.

**Shadow ingress**

A small dedicated service exposes only health/readiness and versioned Shadow
endpoints. It authenticates the producer, enforces body and concurrency limits,
validates the strict schema, rejects conflicting replays, and passes the canonical envelope
to the evaluator. Arbitrary method/path forwarding is impossible by design.

**Read-only evaluator**

The evaluator applies a pinned rollback policy and returns `allow`, `deny`,
`require_approval`, or `insufficient_evidence`. Results are hypothetical;
`allow` is not execution authorization. It emits stable reason
codes and cannot construct, authorize, enqueue, or dispatch an external effect.

The existing sources are `apps/api/src/actionGatewayEndpoints.ts:evaluateAction`
and `packages/worker-plane/src/bootstrap.ts:evaluateActionGatewayMvpV1` for
`action-gateway-mvp-v1`. Extract their deterministic logic and non-executable
rollback descriptor into a dependency-free shared module. Keep API and worker
decisions unchanged, proven by characterization tests. Do not copy policy rules
into a separate Shadow engine or import the executable adapter registry.
If extraction requires changing execution behavior, report the scope conflict.

Each campaign pins policy ID, module version, descriptor, destination rules, and
digest. Reject unknown versions. Before implementation, enumerate the exact
facts required by the shared evaluator and their schema. Missing facts or
pseudonymization that destroys a predicate yield `insufficient_evidence`.
Producer assertions cannot prove identity, approval authenticity, lease validity,
rollback success, or recovery. E1, G4, G5, and rollback execution remain frozen.

**Evidence store**

PostgreSQL stores the canonical input digest, hypothetical decision, production
decision supplied by the customer, reason codes, latency, comparison status,
and signed evidence metadata. It does not store raw HTTP content. A retention
worker and tenant deletion operation use the same authoritative database.

**Operator interface**

The first release provides bounded commands to validate/replay an offline file,
query aggregate status, export a sanitized report, delete the tenant's pilot
data, and verify exported evidence. It does not add a new general-purpose UI.

### 4.2 Dependency Rule

The Shadow runtime is a separate workspace package with an explicit dependency
allowlist. A static architecture test must fail if its production dependency
closure reaches EffectBroker, action adapters, worker execution, tool execution,
Kubernetes clients, or LLM providers. Shared types must live in the contracts
package or in the Shadow package; importing the general core runtime is not
allowed.

## 5. Observation Contract

The v1 envelope contains only these semantic fields:

- schema version and unique observation ID;
- batch ID, zero-based batch index, and declared batch size;
- occurrence timestamp;
- dedicated tenant ID;
- fixed workflow identifier;
- pseudonymous actor ID and source-system ID;
- target cluster, namespace, deployment, and requested revision identifiers as
  customer-approved opaque values;
- production policy decision: `allow`, `deny`, `require_approval`, or `unknown`;
- approved policy facts expressed as bounded enums and booleans;
- producer-generated content digest.

It must not contain free-form prompts, request/response bodies, headers, tokens,
cookies, source code, ticket text, logs, email addresses, or credentials.
Unknown fields, oversize strings, invalid timestamps, mismatched tenant IDs,
duplicate IDs with different content, and unsupported workflow identifiers are
hard failures. Bound records to 16 KiB, identifiers to 128 ASCII characters, and
batches to 1-10,000 observations. Document transformations in the customer field
worksheet; opaque values must preserve predicates or be marked insufficient.
Regex DLP is a secondary known-pattern check, not a guarantee that every opaque
value is non-sensitive.

Register an immutable signed manifest before ingestion, with campaign, tenant,
producer, policy digest, batch ID, closing time, and expected digest per index.
A trusted operator registers historical manifests; Phase B permits an explicitly
authorized producer to seal bounded batches. Use RFC 8785 canonical JSON and
SHA-256 with signatures/digests outside the object covered. Check existing
dependencies before selecting a maintained canonicalizer.

## 6. Authentication And Replay Protection

Phase B terminates mTLS inside the service using Node TLS. Map verified client
certificates to configured tenant/producer identities; never trust proxy identity
headers or expose an unauthenticated alternate listener. An Ed25519 application
signature covers canonical method, fixed route, request ID, sent-at time, tenant,
producer, and body digest. Require certificate and signature identity agreement
and sent-at within 300 seconds. Historical occurrence time is a separate field.
Pin key IDs; rotation uses explicit overlap and revoked keys fail immediately.
Operator credentials are distinct from producer credentials.

Database uniqueness binds tenant/campaign/batch/index and observation identity.
Identical retries return the existing result without increasing counts; changed
content conflicts. Require matching registered digests. After response loss,
retries use a fresh signed request with the same observation identity. Limit
manifest bodies to 2 MiB, observations to 16 KiB, concurrent requests to 16,
and request duration to 10 seconds. Producers require bounded queues and retries.

Offline replay uses the same envelope validation and digest rules without a
network listener. It never bypasses tenant or retention validation.

## 7. Deployment Security

The Phase B Helm profile creates a dedicated Shadow Deployment, Service, Secret
references, NetworkPolicy, and PostgreSQL role.

- `automountServiceAccountToken: false` and no RBAC grants.
- Non-root, read-only filesystem, dropped Linux capabilities, seccomp runtime
  default, bounded CPU/memory, and one writable temporary volume only if needed.
- Ingress restricted to customer-selected producer namespace/pod selectors.
- Egress restricted to the authoritative PostgreSQL endpoint and required DNS.
- No route to the Kubernetes API, LLM providers, Commander effect services, or
  arbitrary internet destinations.
- Secrets come only from named existing Secrets. The chart does not create
  customer credentials.
- Readiness fails until PostgreSQL schema/version, tenant binding, signing key,
  retention policy, and authentication configuration are valid.

The profile remains dedicated single-customer. Shared multi-tenant Shadow is out
of scope.

Both phases reuse verified PostgreSQL TLS connections and a dedicated schema.
Separate installation/DDL authority from non-owner ingestion, report-reader, and
retention/withdrawal roles. Runtime roles cannot access other schemas, manage
roles, or execute DDL. Verify denials in real database tests. No runtime migration
endpoint is exposed. Verify CNI enforcement; valid NetworkPolicy YAML alone is
not isolation proof.

## 8. Evidence, Drift, And Retention

At manifest closure, each expected index has one terminal status: `missing`,
`rejected`, `compared`, `uncomparable`, or `failed`. Their sum equals manifest size.
`received` and `evaluated` are intermediate. Late arrivals require a new manifest
and cannot modify a closed report. Only authenticated, digest-bound invalid
records count as rejected; unbound attempts contribute separate ingress counters.
Database outages leave accounting incomplete until reconciliation. Registered
batches that never arrive are missing; unregistered batches and unsampled traffic
are unobservable. Claim declared-sample coverage, never total production coverage.

Drift compares recorded and hypothetical policy decisions, preserving approval
as a distinct result. `unknown` and `insufficient_evidence` are uncomparable.
Customer reason codes use an approved enum; evaluator latency measures only local
computation. Differences need customer adjudication before being called errors.
HTTP status alone is not a decision comparison. Cost remains absent unless a
measured cost source is later approved; it must never be emitted as a hardcoded
zero implying measurement.

Example report: 100 expected records, 5 missing, 3 rejected, 2 failed, 10
uncomparable, 80 compared. Show 20 differences out of 80 compared alongside
coverage 80/100 and a three-decision matrix. Individual differences include
pseudonymous observation ID, both decisions, reason codes, and policy digest.

Retention is explicitly configured between 1 and 30 days. Cleanup runs at least
hourly; overdue cleanup fails readiness and appears in status. Expiry deletes canonical records and
associated evidence in PostgreSQL and writes a minimal deletion audit record
that contains no customer payload. Tenant withdrawal blocks new ingestion first,
then deletes retained pilot data. Exported reports are sanitized and written
atomically with owner-only permissions.

Admission and withdrawal lock the same campaign row transactionally. Withdrawal
closes ingestion before deletion; concurrent requests cannot insert afterward.
Retain a minimal non-payload tombstone to reject old producer credentials, with
customer-agreed retention. Backup expiry and exported copies have separate
documented deletion responsibilities; primary-store deletion does not erase them.

### Evidence Verification

Export a versioned bundle with signed input manifest, policy snapshot, sanitized
decision-relevant facts, terminal statuses, decisions/reasons, counts, evaluator
version, source revision, and file hashes. Rejected raw records are never exported.
Use atomic 0600 exports and an operator-managed Ed25519 signing key. The verifier
requires a public key obtained through a separately trusted customer channel,
checks algorithm/key ID/revocation, hashes, signatures, and count reconciliation.
A public key bundled with the report is not independently trusted.

Signature verification proves integrity and signer attribution. Re-evaluation
with pinned policy and sanitized facts separately proves deterministic results
for complete records. Neither proves producer facts true or an action executed.

## 9. Failure Behavior

- Invalid configuration prevents startup.
- Authentication, schema, tenant, signature, DLP, replay, or size failure rejects
  the record before evaluation.
- PostgreSQL unavailability returns a bounded failure and records nothing in an
  alternate store.
- Evidence persistence failure means the observation is not reported as
  evaluated.
- The producer must treat Shadow failures as non-authoritative and must not retry
  indefinitely or affect the production response.
- Export and deletion commands fail closed on incomplete database operations.
- Logs contain only stable codes, request IDs, and hashed identifiers; no raw
  envelope, credential, or database URL is logged.

## 10. Customer Delivery Pack

Phase A delivers the following historical-evaluation materials; Phase B adds
live producer, TLS/key operation, sampling, network validation, and Helm guides:

- a two-page pilot overview and customer invitation text;
- a data-boundary worksheet naming every accepted field;
- security and architecture notes for customer review;
- historical import instructions in Phase A and dedicated Helm instructions in Phase B;
- retention, deletion, withdrawal, export, and teardown procedures;
- a pilot charter template with one workflow, one namespace, named approvers,
  escalation owner, observation period, success metrics, and kill criteria;
- a limitations page stating that E0 has no write authority and is not a shared
  SaaS or production-readiness claim.

The charter is an operational template, not a DPA or legal agreement. A paid or
regulated pilot still requires customer-approved legal terms outside this
repository.

## 11. Acceptance Evidence

Each phase is accepted when its applicable checks pass: ingress, certificates,
ServiceAccount, and Helm checks apply to Phase B; policy, data, database, CLI,
retention, and evidence checks apply to both. Fresh tests must prove:

- original POST/PUT/PATCH/DELETE requests cannot be replayed;
- the only ingestion route accepts the canonical envelope and rejects all extra
  fields and unsupported workflows;
- Shadow evaluation cannot import or invoke an effect-producing dependency;
- no Kubernetes credential is mounted and the ServiceAccount has no RBAC;
- ingress identity, signature, tenant binding, timestamp, and replay checks fail
  closed;
- DLP rejects secrets and free-form customer content after allowlist validation;
- PostgreSQL is authoritative across restart, with no fallback;
- drift denominators include rejected, missing, failed, uncomparable, and compared
  records, including wholly absent registered batches and late/conflicting retries;
- retention and withdrawal deletion remove tenant data without cross-tenant
  effects;
- evidence exports verify independently and contain no prohibited data;
- Phase B Helm static and scoped Shadow runtime checks pass in natural CI;
  generic lifecycle success alone is not evidence of Shadow isolation;
- a clean-room operator completes offline replay, report export, deletion, and
  teardown using only the customer documentation.

Implement and accept in order: shared policy parity; strict manifests and
comparison; PostgreSQL roles/transactions/withdrawal; Phase A CLI, evidence and
customer report; then Phase B transport and deployment. Phase A has no Helm or
network-listener acceptance dependency. Test database and network boundaries in
approved CI; do not start local Docker, Kind, or PostgreSQL. Do not manually
rerun CI or inspect raw CI logs. No external customer communication is authorized
by this implementation specification.

The charter sets a declared-sample coverage target and usefulness criteria before
sampling. Any unexpected target-system write or prohibited data field stops
ingestion. Customer acceptance is a separate recorded decision, not inferred
from CI or from a mismatch percentage.

No real customer traffic is used during repository verification. A customer
pilot begins only after its data boundary, consent, retention, withdrawal, and
security review are signed off.

## 12. Migration And Removal

There is no backward compatibility requirement for the current Shadow proxy.
The transparent request replay, unused environment toggle, and non-functional
CLI path are removed rather than retained behind compatibility flags. Existing
`.commander/shadow-*` local files are not migrated into the enterprise evidence
store and must not be presented as pilot evidence.
