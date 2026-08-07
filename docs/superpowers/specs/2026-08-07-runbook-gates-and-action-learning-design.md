# Runbook Gates and Governed Action Learning Data

**Date:** 2026-08-07  
**Status:** Approved design  
**Scope:** Internal runbook authority, customer-discovery gates, and privacy-safe action-learning data

## Problem

Commander currently has two overlapping execution documents:

- `.internal/docs/plans/2026-07-30-abcde-execution-runbook.md` defines ownership, sequencing, and evidence authority for Modules A-E.
- `docs/runbooks/design-partner-launch-readiness.md` defines G0-G8 technical release and design-partner readiness gates.

The documents overlap substantially but produce an unsafe interpretation: the G1-G8 six-to-eight-week release sequence can be read as a prerequisite for first customer contact, while the A-E strategy correctly requires E0 interviews and read-only discovery to start immediately. The repository also has valuable governed-action outcomes, but no explicit boundary between operational telemetry and data permitted for model training or RL.

## Goals

1. Make A-E the single internal authority for ownership and sequencing.
2. Reframe G0-G8 as a technical readiness checklist used for `PROVEN`, E1, and public technical claims.
3. Add explicit E0 contact and E0 shadow gates that do not require production credentials or `PROVEN`.
4. Define a privacy-safe, opt-in action-learning record derived from governed transactions.
5. Preserve evidence-level honesty and prevent customer discovery from becoming a production-write pilot by implication.

## Non-goals

- Implementing an RL trainer, reward model, or online learning loop.
- Collecting prompts, raw arguments, model responses, credentials, or customer payloads by default.
- Replacing the Product Proof Standard.
- Adding a second action, approval, policy, evidence, or audit authority.
- Enabling production writes before the existing A-D and customer acceptance gates pass.

## Authority model

`A-E execution runbook` is authoritative for module ownership, start gates, handoffs, and sequencing. `Product Proof Standard` remains authoritative for evidence levels and claim ceilings. `design-partner-launch-readiness.md` becomes a referenced technical readiness checklist, not an independent recruitment sequence.

The G gates are mapped as follows:

| G gate | Owning A-E module | Use |
| --- | --- | --- |
| G0 claim integrity | B / integration owner | Public wording and artifact traceability |
| G1 branch trust | D | Release candidate reliability |
| G2 install/distribution | B + D | Dedicated deployment onboarding |
| G3 durable authority | A + B + C + D | Canonical governed path |
| G4 evidence/recovery | A + D | Receipts, DR, rotation, unknown handling |
| G5 rollback benchmark | C + D | Technical proof for the selected adapter |
| G6 security floor | A + D | E1 and dedicated-pilot security gate |
| G7 partner experience | E + D | Shadow/pilot onboarding and operations |
| G8 release evidence bundle | D + E | `PROVEN`/E1 evidence package |

G1-G8 do not block E0 contact. G3-G8, as applicable to the selected action, do block E1 governed writes and any `PROVEN` or production-readiness claim.

## Customer gates

### E0-CONTACT

Permits founder-led interviews, public incident follow-up, and problem validation. The operator may collect role, workflow, concrete incident, workaround, consequence, urgency, buyer, and objections. No credentials, unredacted payloads, or product guarantee may be requested or implied.

### E0-SHADOW

Permits read-only or side-channel observation of a bounded workflow. Commander receives a minimized action envelope, preferably hashes and enums, and cannot execute the external write. The customer controls retention and may withdraw. Shadow evidence can show missing action identity, duplicate candidates, unknown-outcome gaps, or evidence incompleteness; it cannot show that Commander blocked or prevented a write.

### E1-WRITE

Requires the selected action to be `PROVEN`, applicable A-D gates to pass, a paid pilot or clear LOI, named buyer/approver/escalator/evidence reviewer, a signed acceptance matrix and SLO, a shadow rehearsal through the same path, scoped credentials, and a kill/credential-removal procedure. Only customer acceptance after the observation window can produce `FIELD-PROVEN`.

## Action-learning data

Commander may derive a separate `ActionLearningRecord` from a governed action and its evidence. It is an offline decision dataset, not an online RL control loop.

The record contains only normalized metadata and outcome labels:

- action class, source runtime, model family, tool class, and resource-scope class;
- policy and approval outcome, policy/contract versions, and action digest;
- remote outcome (`applied`, `not_applied`, `unknown`, or `escalated`);
- query/reconciliation path, retry and compensation counts, operator intervention, and recovery latency;
- evidence-verification verdict and schema/version identifiers;
- tenant-scoped consent identifier, purpose, retention expiry, and deletion status.

Raw prompts, raw arguments, full responses, credentials, tokens, PII, customer content, and internal URLs are forbidden. An action digest or canonical request hash may be retained; secret-bearing values may not.

Operational telemetry and model-training consent are separate controls. Telemetry required to operate the deployment is not automatically licensed for training. Training use requires explicit tenant-level opt-in, purpose limitation, retention and deletion support, exportability, and a documented withdrawal path. No training dataset is exported by default.

The first useful learning tasks are risk classification, approval prediction, action/outcome prediction, and recovery/compensation policy evaluation. Dataset quality is measured by label correctness, external-outcome coverage, and independent receipt verification, not by raw event volume.

## Documentation changes

The implementation phase should:

1. Update the A-E runbook to name itself the internal authority and link to the G checklist.
2. Update the G checklist title and introduction to state that it gates E1/technical claims, not E0 contact.
3. Replace the G checklist's six-to-eight-week recruitment wording with separate E0-CONTACT, E0-SHADOW, and E1-WRITE outcomes.
4. Remove or clearly mark `benchmark:governed-rollback` as planned until an executable command exists.
5. Correct `PRIVACY.md` so evaluation is not treated as implied training consent; add the explicit opt-in and deletion boundary.
6. Add a schema and validation tests for `ActionLearningRecord` without persisting raw customer content.

## Verification

- Document scans show no statement that G1-G8 must pass before E0 contact.
- Existing A-E, Product Proof Standard, and G checklist references agree on `EXISTS`/`WIRED`/`ENFORCED`/`PROVEN`/`FIELD-PROVEN`.
- Privacy tests reject prompt, raw-argument, response, credential, PII, and customer-payload fields in learning records.
- Consent tests reject training export without explicit tenant opt-in and verify deletion/withdrawal handling.
- Existing contract, architecture, and claim gates remain green.

## Rollout order

1. Documentation and claim corrections.
2. Privacy-safe record schema and validation only.
3. Emit records behind explicit opt-in; keep operational telemetry separate.
4. Run E0 contact and shadow discovery immediately.
5. Apply E1-WRITE only after technical proof and commercial commitment.

