# External Red Team Scope

This document defines the scope, rules of engagement, and report format for
external security researchers participating in Commander's red team program.

Commander runs a tiered defense strategy:

1. **In-tree automated red team** (`runRedTeamBattery.ts`) — 54+ scenarios
   covering prompt injection, jailbreak, data exfiltration, agent jacking,
   tool abuse, memory poisoning, denial of wallet, supply chain, multi-tenant
   isolation, and plugin supply chain attacks.
2. **Adversarial corpus generation** (`AdversarialLLMAttacker`) — weekly
   generation of novel attack variants using a dedicated LLM-as-attacker
   model, with hard budget caps (`maxTokensPerRun`, `weeklyBudgetUsd`).
3. **Postmortem-driven scenarios** (`postmortemLink.ts`) — every incident
   postmortem with a `red_team_scenario:` frontmatter is auto-converted into
   a new test scenario.
4. **External researchers** (this document) — the human-in-the-loop tier
   that catches attacks the automated tiers miss.

## In Scope

| Attack class               | Target surface                              | Bounty tier |
|----------------------------|---------------------------------------------|-------------|
| Cross-tenant data leak     | Memory, MCP, audit log, billing, plugin     | Critical    |
| Sandbox escape (plugin)    | `buildSandboxedLoadContext`, prototype chain | Critical   |
| Prompt injection in tool output | Any MCP tool returning external content | High        |
| Capability drift in plugin | Manifest vs runtime calls                   | High        |
| Memory poisoning           | HNSW index, episodic memory write path      | High        |
| Supply chain               | `pluginDependencies` resolution path        | High        |
| Audit log bypass           | `auditMiddleware`, `auditChainLedger`       | High        |
| Cost authority bypass      | `unifiedCostAuthority`, `BillExplosionGuard` | High        |
| New attack class           | Novel category not in the automated battery | Triage      |

## Out of Scope

- Denial-of-service against the demo deployment
- Social engineering of Commander maintainers
- Physical attacks against infrastructure
- Attacks requiring attacker-controlled LLM-as-judge (use the automated
  adversarial corpus instead)
- Findings in dependencies that already have a CVE with a published fix
  released within 30 days

## Rules of Engagement

1. **Use the staging tenant**: Researchers receive a dedicated tenant
   namespace (`redteam-<handle>`). All attacks must operate within that
   tenant's data. Cross-tenant access from a staging tenant is itself an
   in-scope finding.
2. **Stop at exfiltration**: When demonstrating a data exfiltration finding,
   do not exfiltrate real customer data. A 1-byte sample with the victim
   tenant name redacted is sufficient.
3. **No destructive actions**: Do not run commands that would cause
   unrecoverable state corruption. Compensating transactions exist for a
   reason; do not break them.
4. **Coordination window**: Critical-class findings must be reported within
   24 hours of discovery and must include a 90-day disclosure window
   agreement.
5. **Coordinated disclosure**: We follow a 90-day disclosure window. Do not
   publish before the agreed-upon date.

## Report Format

All reports must be filed as GitHub issues with the `red-team` label and
include:

```yaml
finding_id: <researcher-chosen unique id, e.g., RT-2026-001>
title: <one-line summary>
severity: critical | high | medium | low
cvss_score: <0.0-10.0>
attack_class: <see table above>
target_surface: <specific module / file / endpoint>
reproduction_steps: |
  1. ...
  2. ...
  3. ...
impact: <what the attacker gains>
evidence: <log excerpts, screenshot, hash>
disclosure_window: <days, default 90>
researcher: <handle or email>
```

The auto-issue creator (`IssueAutoCreate`) will de-duplicate by title.
Researchers should pick unique titles.

## Validation

External findings are validated by:

1. Reproducing the finding against `main` in an isolated tenant
2. Writing a corresponding test scenario in the appropriate battery
   (`tenancyScenarios.ts`, `pluginSupplyChainScenarios.ts`, etc.)
3. Confirming the scenario is blocked by the defense layer named in
   `expectedDefense`
4. Linking the postmortem (`red_team_scenario: <id>`) so future regressions
   are caught

A finding is considered **triaged** when step 2-3 are complete and
**closed** when the postmortem is filed.

## See Also

- `SECURITY.md` — coordinated disclosure process and PGP key
- `docs/superpowers/specs/2026-06-30-red-team-evaluation-design.md` —
  design rationale
- `docs/runbooks/chaos.md` — internal chaos test suite
- `docs/runbooks/shadow.md` — shadow traffic capture
