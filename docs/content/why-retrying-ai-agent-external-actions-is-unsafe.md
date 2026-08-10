# Why Retrying an AI Agent's External Action Is Unsafe

_A practical failure model for agents that can change real systems_

> **Status:** This is an engineering hypothesis and a pre-launch experiment
> plan, not a benchmark report. The prototype behind this essay has alpha
> building blocks; the campaign described below has not yet been run.

An AI agent can make a reasonable decision and still be unsafe when the network
stops cooperating.

Consider a simple request:

> Roll back the `api` Kubernetes Deployment to the previous revision.

The agent selects the right tool. The tool sends the request to the Kubernetes
API. The API applies the rollback. Then the connection drops before the client
receives the response.

From the caller's point of view, the operation timed out. From the cluster's
point of view, the operation may already be complete.

That difference is where ordinary retry logic becomes dangerous.

## A timeout is not a failure state

After a lost response, there are at least three possible realities:

| Reality                                | What the caller knows         | What a blind retry can do                     |
| -------------------------------------- | ----------------------------- | --------------------------------------------- |
| The request was never received         | Nothing was changed           | Apply the intended change once                |
| The request was received and committed | The change is already present | Apply it again or create a second side effect |
| The outcome cannot yet be observed     | The system is ambiguous       | Create a duplicate while trying to recover    |

The error message is the same in all three cases: timeout.

An SDK that turns every timeout into `retry()` has silently made a distributed
systems decision. It has decided that the external operation is either
idempotent, reversible, or unimportant enough to repeat. For a deployment
rollback, a payment, a ticket mutation, or a permission change, that assumption
is often wrong.

The problem becomes more subtle when an AI agent is involved. An agent can
re-plan after an error, change its arguments, call a different tool, or continue
from a partial observation. The system is no longer retrying a function call. It
is retrying a decision that may already have changed the world.

## The control path needs more state than a tool call

A safe recovery path needs to distinguish the proposed action from each attempt
to carry it out. At minimum, it needs:

1. **A stable action identity.** The destination, arguments, policy, approval,
   and intent are bound to one immutable action digest.
2. **Durable intent before the side effect.** The system records what it is
   authorized to do before asking an external system to do it.
3. **A fenced effect lease.** A stale worker must not regain the right to write
   after a restart, timeout, or failover.
4. **Outcome-first recovery.** After an ambiguous response, query the external
   system before deciding whether another write is allowed.
5. **Explicit terminal dispositions.** The result is not just success or error;
   it may be completed, confirmed-not-applied, compensated, or escalated.
6. **Independently verifiable evidence.** An operator needs to verify what was
   authorized, what was attempted, what the external system reported, and who
   signed the final receipt.

This is not an argument for making every agent workflow slow or bureaucratic.
It is an argument for putting the extra control around actions whose failure has
external consequences, while leaving read-only reasoning cheap.

## A narrower control-plane problem

Agent orchestration projects often start broad. That scope is too wide to make a
credible reliability claim. The focused question is narrower:

> Can an AI agent propose a consequential Kubernetes action while a durable
> control plane preserves the binding between authorization, execution, recovery,
> and evidence when processes and networks fail?

A prototype control plane for that experiment currently contains:

- a PostgreSQL-backed execution kernel for runs, steps, leases, events, and
  outbox state;
- an EffectBroker boundary for external effects;
- capability and approval checks before an adapter runs;
- a Kubernetes deployment rollback adapter;
- compensation and reconciliation paths;
- signed terminal evidence and key-rotation verification;
- a fault matrix covering the failure modes that matter for an ambiguous write.

These are alpha implementation building blocks, not production proof. The point
of the next phase is to make the proof reproducible. The list is a design
hypothesis, not a claim that every external API provides stable identity or a
reliable outcome query.

## A bounded experiment

The concrete test case is one approval-gated rollback in a dedicated sandbox
namespace. There is no autonomous production access in this campaign.

The planned benchmark runs the same workflow through a real Kubernetes API, a
real PostgreSQL instance, separate Gateway/worker/operations processes, and an
external fault driver. It covers 15 scenarios:

- identity, policy, approval, tenant, and mutation denial;
- lease fencing and idempotency;
- response loss after a remote commit;
- confirmed-not-applied and irreducible unknown outcomes;
- separately authorized compensation;
- kill-switch enforcement;
- evidence persistence;
- process recovery;
- backup and restore.

Each scenario run is exercised at six lifecycle fault points:

- before the remote request;
- after the remote commit;
- before local completion;
- during outcome query;
- during compensation;
- during evidence persistence.

The hardest case is the combination of the last two facts: the Kubernetes API
accepts the write, then the control plane crashes while persisting the terminal
evidence. A lease by itself is not enough to answer that case. The safe sequence
is: keep the effect non-terminal when the evidence transaction fails, then park
it as `COMPLETION_UNKNOWN` when recovery regains control (or when lease reclaim
handles a process that died before parking it). `COMPLETION_UNKNOWN` means “the
control plane cannot yet prove whether the external side effect happened.” A
query-only reconciler then inspects the external system. If the action marker,
target revision, template hash, and rollout state prove `APPLIED`, the
reconciler records completion without invoking the write path. If they prove
`NOT_APPLIED`, it records that disposition. If neither can be proved, it stays
unknown and escalates. Fencing prevents a stale worker from submitting a new
admitted write or committing a terminal local state; it cannot cancel an HTTP
request that was already in flight, which is why the outcome query remains
necessary. For this adapter, “one write” means one logical rollback: one marker
patch plus one rollback patch, with no second invocation of that logical action.

That is the design property this experiment must prove end to end. The current
tests cover the evidence-failure parking and the Kubernetes query-without-a-
second-write behaviors separately; they are not a substitute for the combined
fault campaign.

The initial scored campaign is 100 full scenario runs per scenario, split across
at least three fresh environment rebuilds. That is 1,500 scenario runs. The six
fault points are assertions inside each run; if each point is counted separately,
the report will also disclose up to 9,000 fault-point observations. The
acceptance threshold is intentionally about invariants, not a flattering
average:

| Invariant                               |              Threshold |
| --------------------------------------- | ---------------------: |
| Consequential duplicate logical actions |                      0 |
| Denied-scenario external writes         |                      0 |
| Stale-lease writes                      |                      0 |
| Kill-switch bypasses                    |                      0 |
| Unverified terminal receipts            |                      0 |
| Terminal cases missing evidence         |                      0 |
| Ambiguous cases without outcome query   |                      0 |
| Unknown outcomes resolved or escalated  |  100% within 5 minutes |
| Terminal evidence available             | 100% within 60 seconds |

The five-minute and 60-second limits are pilot operating budgets for escalation
and evidence retrieval, not universal service-level guarantees.

The report will say exactly what happened: for example, “0 duplicate logical
actions in 1,500 scenario runs,” alongside the fault-point observation count. It
will not say “the system cannot fail.” A zero observed failure count is evidence
about the tested matrix, not a proof of perfection.

## Scope boundary

This experiment does not prove:

- factual correctness for arbitrary model output;
- safety for external systems that lack stable action identity or a reliable
  outcome query;
- a zero-failure guarantee outside the tested matrix.

That boundary is intentional. It lets the experiment answer one hard question
with real evidence instead of using a large feature list to hide untested paths.

## Why this matters beyond Kubernetes

Kubernetes rollback is only the first concrete adapter. The underlying failure
model also appears when an agent:

- creates or closes a support ticket;
- changes a cloud resource;
- rotates a credential;
- sends a consequential message;
- updates a customer record;
- executes a payment or refund workflow.

The common requirement is not “more agents.” It is a trustworthy boundary between
an agent's decision and an external side effect.

If an agent can change a real system, “it timed out, so we retried” is not a
recovery strategy. It is an unreviewed decision about a side effect. The goal is
to make that decision explicit, durable, and verifiable.

_Tags: AI Agents, Kubernetes, Distributed Systems, Reliability Engineering,
LLMOps_
