# Invitation: Historical Rollback Policy Evaluation

Commander invites platform and SRE teams to evaluate a declared historical
sample of Kubernetes deployment rollback decisions in their own cloud. The
first workflow is limited to `kubernetes.deployment.rollback`.

The customer selects the sample, operates the dedicated PostgreSQL evidence
store, and retains control of network policy, encryption, and deployment. The
pilot produces hypothetical policy comparisons; it cannot make a Kubernetes
change or grant authority for one.

## First conversation

The initial contact needs only a company name, a platform/SRE point of contact,
the intended environment, and the candidate rollback workflow. Do not send
system access information, manifests, observations, or customer data before the
charter and data boundary are agreed.

We will jointly identify the customer sponsor, platform owner, security owner,
data-retention owner, deletion owner, and export recipient. Legal/DPA review is
an external review; the customer decides whether and how to begin it.

## Entry criteria

- One dedicated customer-cloud environment and one tenant identifier.
- A named customer owner for the policy digest and declared sample.
- A bounded historical observation window and a retention period from 1 to 30
  days.
- A customer-managed PostgreSQL service with TLS and separate least-privilege
  roles for installation, ingestion, report reading, and retention.
- A customer-approved Ed25519 manifest signing key and report-verification key
  exchange process.

The pilot stops before import when these conditions are not met, when the
proposed data contains prohibited fields, or when the customer cannot assign
owners for mismatch adjudication and withdrawal.
