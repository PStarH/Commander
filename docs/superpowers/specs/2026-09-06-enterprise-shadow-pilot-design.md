# Enterprise Shadow Pilot Design

**Status:** Approved for implementation
**Date:** 2026-09-06
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

The engagement has two activation stages:

1. **Offline replay:** the customer exports approved observation records, runs
   local validation, and submits only records that satisfy the pilot schema.
2. **Live observation:** after the customer accepts the offline evidence, an
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
- Use PostgreSQL as the only evidence store. No memory, JSON, SQLite, Redis, or
  local-file fallback is permitted.
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
validates the strict schema, rejects replays, and passes the canonical envelope
to the evaluator. Arbitrary method/path forwarding is impossible by design.

**Read-only evaluator**

The evaluator applies the fixed rollback admission policy and returns one of:
`would_allow`, `would_deny`, or `insufficient_evidence`. It emits stable reason
codes and cannot construct, authorize, enqueue, or dispatch an external effect.

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
- production decision: `allowed`, `denied`, or `unknown`;
- approved policy facts expressed as bounded enums and booleans;
- producer-generated content digest.

It must not contain free-form prompts, request/response bodies, headers, tokens,
cookies, source code, ticket text, logs, email addresses, or credentials.
Unknown fields, oversize strings, invalid timestamps, mismatched tenant IDs,
duplicate IDs with different content, and unsupported workflow identifiers are
hard failures. A batch index may appear only once, every record in a batch must
declare the same bounded batch size, and an expired incomplete batch contributes
its absent indexes to the `missing` count. Regex DLP runs after schema validation
as an additional rejection layer, never as the primary data boundary.

## 6. Authentication And Replay Protection

The live endpoint requires a dedicated producer identity. The deployment uses
customer-managed mTLS at the service boundary and a tenant-scoped application
signature inside the request. The signature covers method, fixed path,
timestamp, observation ID, tenant ID, and body digest. Timestamps have a bounded
acceptance window, and observation IDs are inserted atomically so a replay is
idempotent only when its digest is identical.

Offline replay uses the same envelope validation and digest rules without a
network listener. It never bypasses tenant or retention validation.

## 7. Deployment Security

The Helm profile creates a dedicated Shadow Deployment, Service, Secret
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

## 8. Evidence, Drift, And Retention

Each declared batch index is counted in exactly one terminal state: `missing`,
`rejected`, `compared`, or `failed`. `received` and `evaluated` are intermediate
states only. Reports expose the declared batch size and exact terminal counts so
missing and rejected samples cannot disappear from the denominator.

Drift compares the customer's production decision with Commander's hypothetical
decision and includes stable reason-code differences and evaluation latency.
HTTP status alone is not a decision comparison. Cost remains absent unless a
measured cost source is later approved; it must never be emitted as a hardcoded
zero implying measurement.

Retention is mandatory and bounded in days. Expiry deletes canonical records and
associated evidence in PostgreSQL and writes a minimal deletion audit record
that contains no customer payload. Tenant withdrawal blocks new ingestion first,
then deletes retained pilot data. Exported reports are sanitized and written
atomically with owner-only permissions.

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

The repository will include:

- a two-page pilot overview and customer invitation text;
- a data-boundary worksheet naming every accepted field;
- security and architecture notes for customer review;
- offline replay and dedicated Helm deployment instructions;
- retention, deletion, withdrawal, export, and teardown procedures;
- a pilot charter template with one workflow, one namespace, named approvers,
  escalation owner, observation period, success metrics, and kill criteria;
- a limitations page stating that E0 has no write authority and is not a shared
  SaaS or production-readiness claim.

The charter is an operational template, not a DPA or legal agreement. A paid or
regulated pilot still requires customer-approved legal terms outside this
repository.

## 11. Acceptance Evidence

Implementation is accepted only when fresh tests prove:

- original POST/PUT/PATCH/DELETE requests cannot be replayed;
- the only ingestion route accepts the canonical envelope and rejects all extra
  fields and unsupported workflows;
- Shadow evaluation cannot import or invoke an effect-producing dependency;
- no Kubernetes credential is mounted and the ServiceAccount has no RBAC;
- ingress identity, signature, tenant binding, timestamp, and replay checks fail
  closed;
- DLP rejects secrets and free-form customer content after allowlist validation;
- PostgreSQL is authoritative across restart, with no fallback;
- drift denominators include rejected, missing, failed, and compared records;
- retention and withdrawal deletion remove tenant data without cross-tenant
  effects;
- evidence exports verify independently and contain no prohibited data;
- Helm static checks pass and the natural CI Kind lifecycle passes in the
  supported environment;
- a clean-room operator completes offline replay, report export, deletion, and
  teardown using only the customer documentation.

No real customer traffic is used during repository verification. A customer
pilot begins only after its data boundary, consent, retention, withdrawal, and
security review are signed off.

## 12. Migration And Removal

There is no backward compatibility requirement for the current Shadow proxy.
The transparent request replay, unused environment toggle, and non-functional
CLI path are removed rather than retained behind compatibility flags. Existing
`.commander/shadow-*` local files are not migrated into the enterprise evidence
store and must not be presented as pilot evidence.
