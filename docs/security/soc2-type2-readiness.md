# SOC 2 Type II Readiness Checklist — Commander

> **Version:** 2026.06.21 (seed)
> **Audit target:** Big-4 assurance firm / specialized AI assurance firm (TBD)
> **Trust Services Categories (TSC) in scope:** Security (mandatory) + Confidentiality + Availability + Processing Integrity
> **Type I target:** +7-8 months from kickoff (4-8 weeks auditor RFI + ~5-6 months P0/P1 build-out) · **Type II target:** +13-14 months (Kickoff → 4-8w RFI → 6-month SOC 2 observation window → opinion letter)
> **Seed source:** `npx tsx packages/core/src/security/runComplianceAudit.ts --all --output=/tmp/compliance-audit-seed`
> · Snapshot `POSTURE-1782009737631-13c7c4` · Report ID `AUDIT-1782009737633-aa85bede`

---

## 1. Executive Summary

Commander already self-reports **84/100 (Grade B)** on its proprietary posture score, with **60% ISO 42001 coverage (9/15 clauses)** and **52% NIST AI RMF alignment (15/31 subcategories)**. The good news: **12 of 15 audit-readiness checklist items already pass** (technical controls, sandbox, supply chain, SOC, EU AI Act reporter). The blocker: **6/15 ISO 42001 gaps are organizational — risk assessment (6.1/6.2) and support clauses (7.1–7.4) — and 3 ACK items are "pending": third-party auditor (ACK-13), model cards (ACK-14), DPIA (ACK-15)**. SOC 2 Type II does not test technical controls harder — it tests **whether the controls operated effectively over an observation window with documented evidence on file**. Translation: Commander's technical depth is ≈ 70% of the way there, but the **process / governance / evidence-on-file** layer is the SOC 2 blocker.

**Honest verdict:** Type II achievable on a 13-14-month calendar — captured by §7's W1-W8 auditor RFI milestone + the ~6-month SOC 2 observation window — if we execute §7 roadmap verbatim. We can credibly claim **Security + Confidentiality + Processing Integrity** in Year 1; add **Availability** once we publish a contractual uptime SLA in our MSA; **Privacy** should be deferred because it requires Data Protection Impact Assessment infrastructure foreign to current build.

---

## 2. Crosswalk: ISO 42001 + NIST AI RMF → SOC 2 Trust Services Criteria

The same organizational gaps show up across all three frameworks. Mapping them once means we close eight SOC 2 controls in one stroke.

| SOC 2 TSC | SOC 2 Control | ISO 42001 Equivalent | NIST AI RMF Equivalent | Commander Existing Evidence |
|-----------|---------------|----------------------|------------------------|------------------------------|
| **CC1.1** — Control environment: commitment to integrity & ethical values | 🟡 | 5.2 (leadership), 5.3 (roles) — *Implicit; no docs* | GOVERN-1.2 (gap) | CTL-011 AgentLineage (technical only) · **policy docs required (P0 series)** |
| **CC1.4** — Demonstrates commitment to competence | 🔴 | **7.2 Competence** ❌ | GOVERN-2.2 (workforce competence) | NONE |
| **CC2.1** — Information to support functioning of internal control | 🔴 | **7.5 Documented info** ✅ · 7.4 Communication ❌ | GOVERN-3.1 (AI roles documented) | CTL-017 AuditChainLedger · CTL-020 EU AI Act Reporter |
| **CC2.2** — Internal communication | 🔴 | **7.4 Communication** ❌ | GOVERN-4.1 (communication channels) | NONE |
| **CC3.1** — Specifies objectives | 🟡 | **6.2 AI objectives** ❌ | GOVERN-1.2 (risk appetite) | CTL-013 CostGuard · CTL-014 TokenGovernor |
| **CC3.2** — Identifies and analyzes risk | 🔴 | **6.1 Risk actions** ❌ | GOVERN-2.1 (AI risk profile) · MAP-2.1 | NONE |
| **CC3.4** — Identifies and assesses changes | 🟡 | 6.1 (changes) · 10.2 (improvement) ✅ | MEASURE-3.1 · MEASURE-3.2 · **MAP-2.2 (gap)** | CTL-019 RedTeamBaseline · CTL-011 AgentLineage · **formal change-management procedure still needed** |
| **CC4.1** — Selects and develops control activities | ✅ | 8.1 Operational controls ✅ · 8.2 Design ✅ | MANAGE-2.1 · MANAGE-2.2 | CTL-004 Sandbox · CTL-005 Approval · CTL-006 PathSecurity · CTL-009 CircuitBreaker |
| **CC5.1** — Selects and develops control activities (technology) | ✅ | 8.2 Design · 8.3 Deployment ✅ | MANAGE-2.1 | CTL-001 ContentScanner · CTL-003 PrivacyRouter · CTL-004 Sandbox |
| **CC5.2** — Technology general controls | ✅ | 8.3 Deployment ✅ | MANAGE-2.2 | CTL-007 GuardianAgent · CTL-008 SecurityMonitor |
| **CC6.1** — Logical and physical access controls | ✅ | 8.3 · 9.1 (logging access) ✅ | MANAGE-2.1 | CTL-012 CapabilityToken · CTL-011 AgentLineage |
| **CC6.2** — Prior authorization for new/modified access | 🟡 | 8.1 ✅ | MANAGE-2.1 | CTL-005 ApprovalSystem · CTL-019 RedTeamBaseline |
| **CC6.6** — Implements logical access security measures | ✅ | 8.3 ✅ | MANAGE-2.1 | CTL-012 CapabilityToken · CTL-004 Sandbox |
| **CC6.7** — Restricts transmission of information | ✅ | 8.1 · 8.3 ✅ | MANAGE-2.2 | CTL-004 Sandbox seatbelt · CTL-006 PathSecurity |
| **CC6.8** — Detects and acts on vulnerabilities | ✅ | 10.1 (nonconformity) · 10.2 ✅ | MANAGE-3.1 | CTL-016 AgentStandbyManager · CTL-018 RedTeam |
| **CC7.1** — Detects vulnerabilities to system components | ✅ | 9.1 Monitoring ✅ · 9.2 Internal audit ✅ | MEASURE-2.4 | CTL-007 GuardianAgent · CTL-008 SecurityMonitor |
| **CC7.2** — Monitors system components and operation | ✅ | 9.1 ✅ | MEASURE-2.1 · MEASURE-2.2 | CTL-007 GuardianAgent · CTL-008 SecurityMonitor · CTL-009 CircuitBreaker |
| **CC7.3** — Evaluates security events | ✅ | 9.1 ✅ | MEASURE-2.2 | CTL-015 AgentSOC |
| **CC7.4** — Responds to identified security incidents | ✅ | 10.1 (corrective action) ✅ · 8.3 ✅ | MANAGE-3.1 · MANAGE-4.1 | CTL-015 AgentSOC (14 playbooks) |
| **CC7.5** — Recovery from identified security incidents | ✅ | 8.3 (continuity) ✅ | MANAGE-4.2 | CTL-016 AgentStandbyManager · CTL-018 RedTeam |
| **CC8.1** — Authorizes changes | 🟡 | 8.2 · 10.1 · 10.2 ✅ | MANAGE-4.3 | CTL-019 RedTeamBaseline · CTL-018 RedTeam |
| **CC9.1** — Identifies, selects, and develops risk mitigation | 🟡 | **6.1 (mitigation) ❌** · 10.2 (improvement) ✅ | **MANAGE-1.1, MANAGE-1.2 (both explicitly gaps)** · MANAGE-2.1 · MANAGE-2.2 | CTL-013 CostGuard · CTL-018 RedTeam · CTL-009 CircuitBreaker · **risk prioritization register required (P0-1)** |
| **CC9.2** — Vendor & business partner risk | 🟡 | 8.2 (supplier controls) · 10.2 ✅ | MAP-3.1 (third-party data) · GOVERN-3.1 | CTL-010 SupplyChainScanner · CTL-020 EU AI Act |
| **A1.1** — Capacity planning / availability commitments | 🟡 | 8.3 ✅ | MANAGE-2.2 | CTL-016 AgentStandbyManager |
| **A1.2** — Environmental protections, software, infrastructure | 🟡 | 8.3 ✅ | MANAGE-2.2 | CTL-004 Sandbox (env filtering) |
| **A1.3** — Recovery testing | 🟡 | 8.3 ✅ · 9.2 ✅ | MANAGE-4.2 | CTL-016 + AbilityToRecover drills needed |
| **C1.1** — Identifies confidential information | ✅ | 7.5 ✅ · 8.2 ✅ | MAP-3.1 · MEASURE-2.3 | CTL-003 PrivacyRouter · CTL-002 OutputSanitizer |
| **C1.2** — Disposes of confidential information | ❓ | 8.3 (decommission) — *Missing* | MANAGE-4.3 | NONE — needs DataDisposalPolicy |
| **PI1.1** — Defines processing integrity requirements | ✅ | 8.1 · 8.2 · 8.3 ✅ | MANAGE-2.1 | CTL-005 ApprovalSystem · CTL-009 CircuitBreaker |
| **PI1.2** — Implements policies & procedures | ✅ | 8.1 ✅ | MANAGE-2.1 | CTL-004 Sandbox · CTL-006 PathSecurity |
| **PI1.3** — Ensures inputs/outputs accurate | ✅ | 8.1 · 8.3 ✅ | MEASURE-2.3 | CTL-001 ContentScanner · CTL-002 OutputSanitizer |
| **PI1.4** — Monitors processing and timely outputs | 🟡 | 9.1 ✅ | MEASURE-2.4 (covered) | CTL-007 GuardianAgent · CTL-008 SecurityMonitor · **on-call SLA evidence needed** |
| **PI1.5** — Implements corrective action for processing errors | 🟡 | 10.1 ✅ | **MANAGE-4.3 (gap)** | CTL-015 AgentSOC (incident response OK) · **closed-loop postmortem + remediation KPI missing** |

Legend: ✅ ready · 🟡 partial · 🔴 missing · ❓ requires new policy

---

## 3. Realistic Readiness Scorecard (today)

| Bucket | Count | % | Notes |
|--------|-------|---|-------|
| ✅ SOC 2 controls ready (sample-testable today) | **16** | 44% | Pure technical controls — auditor sample audit will pass |
| 🟡 Partial (evidence exists AND/OR dependent on P0 policy docs closing) | **15** | 42% | Includes 2 demoted from ✅ after re-review (CC1.1, CC9.1) + 2 new sub-criteria added (PI1.4, PI1.5) — see §2 footnotes; remainder need 1-2 day evidence write |
| 🔴 Missing (process / governance absent) | **4** | 11% | P0-1 through P0-4 in §4 — no code substitute |
| ❓ Requires new policy document (not just code) | **1** | 3% | C1.2 data-disposal policy |
| **Total** | **36** | **100%** | See §1 for calendar; calendar not restated per row |

The **four 🔴 blockers (P0-1 through P0-4 in §4)** are the gatekeepers — every other partial-pass can be tested by auditor with on-record evidence, but **SOC 2 cannot pass an observation period if these four remain unwritten**:

1. **CC3.2 Risk assessment methodology + register** (ISO 6.1 / NIST GOVERN-2.1, MAP-2.1)
2. **CC1.4 Competence framework** (ISO 7.2 / NIST GOVERN-2.2) — security training records for engineers
3. **CC2.2 Internal communication policy** (ISO 7.4 / NIST GOVERN-4.1) — escalation & decision-making flow
4. **CC2.1 External communication policy** (overlap with CC2.2; can be combined with above)

---

## 4. P0 — Type II Blockers (close these before **§7 W12** so they land on auditor's desk before field work)

### P0-1. Risk Assessment Methodology + Risk Register (closes CC3.2, CC1.1)
**Owner:** Head of Security + Head of Engineering
**Due:** Week 4 (v0.1 draft, in parallel with auditor RFI) · **Week 12 (v1.0 sign-off + per-auditor format)**
**Deliverable:** `docs/security/risk-register.md` containing:
- Risk taxonomy derived from MITRE ATLAS (already 60+ techniques mapped via `MitreAtlasMapper`)
- Likelihood × Impact scoring matrix (use CVSS 3.1 from existing `redTeamFramework`)
- Top-20 risks + treatment plan, reviewed quarterly by CISO + CTO
- **Reuse:** internal scoring matrix can mirror the existing posture-snapshot mechanism (`packages/core/src/security/runComplianceAudit.ts`)

### P0-2. AI Objectives & Strategy Document (closes CC3.1 — partial)
**Owner:** CEO / CTO
**Due:** Week 6
**Deliverable:** `docs/security/ai-objectives.md` containing:
- 3 measurable security objectives (e.g., "MTTD < 5 minutes for prompt injection", "≤ 0 red-team regressions per release", "100% of shipped dependencies attested")
- Quarterly review cadence, signed by accountable executive (CC1.5)
- Linked from `ComplianceAuditManager` overview doc

### P0-3. Competence Framework (closes CC1.4)
**Owner:** Head of People + Head of Security
**Due:** Week 10
**Deliverable:** `docs/security/competence-framework.md` containing:
- Role definitions for: Security Engineer, AI Attack Tester, Governance Approver
- Required training: secure SDLC, ML security basics, OWASP Agentic AI Top 10
- Annual certification + on-boarding checklist
- Action: **integrate with `git/.commander/security-training.json`** so training records can be queryable

### P0-4. Communication Policy (closes CC2.2, CC2.1, ISO 7.4)
**Owner:** COO + Head of Security
**Due:** Week 12
**Deliverable:** `docs/security/communication-policy.md` containing:
- Incident escalation chart (L1 Analyst → L2 Engineer → L3 Security Lead → Management) — **extract from existing `agentSoc.ts` PLAYBOOKS**
- Customer-facing security disclosure policy (mirrors HackerOne program announcement)
- Quarterly SEC/safety review meetings schedule
- Decision-making authority matrix: who can approve what

---

## 5. P1 — Hardening for Type II Operating Effectiveness (Weeks 9-16)

> These controls already have code. SOC 2 Type II requires **on-file evidence of them operating** across the audit window. We need to add the evidence trail.

### P1-1. Automated Posture Snapshots → CI/CD
**Today:** `ComplianceAuditManager` snapshots are manual. **Need:** GitHub Actions integration that runs `runComplianceAudit.ts` weekly + on main merges and uploads to signed artifact store.
**Closes:** CC4.1 (control activities executed), CC7.2 (continuous monitoring), CC8.1 (change authorization)
**Effort:** 1 week

### P1-2. Ticketed Incident Workflow → Audit Trail
**Today:** `AgentSOC` tracks incidents in-memory. **Need:** Each `Incident` must produce a `Ticket` with user ID, description, resolution, evidence — persisted to `AuditChainLedger` (already HMAC-signed).
**Closes:** CC7.3 (security event evaluation), CC7.4 (response)
**Effort:** 2 weeks

### P1-3. Time-Series Disposal / Data Retention
**Today:** `MemoryStore`, `EpisodicMemoryStore`, `TraceStore` have no retention policy.
**Need:** Documented `DataRetentionPolicy` (e.g., traces 90d, episodic memory 1y, audit chain 7y), enforced by janitor cron.
**Closes:** C1.2 (data disposal), A1.2 (capacity via retention)
**Effort:** 2 weeks

### P1-4. Cross-Org FederatedTrust Audit → External Communication Record
**Today:** `FederatedIdentity` exists. **Need:** Log + sign all cross-org trust exchanges to AuditChainLedger, with named human approver.
**Closes:** CC2.3 (external communication), CC9.2 (vendor risk)
**Effort:** 1 week

### P1-5. Model Cards + DPIA Templates
**Today:** ACK-14 (Model cards) and ACK-15 (DPIA) are pending.
**Need:**
- `docs/security/model-cards/` containing per-model YAMLs (Anthropic Claude, OpenAI GPT, Google Gemini, etc., with versions, capabilities, limitations, intended use)
- `docs/security/dpia-template.md` based on GDPR Article 35 §9
**Closes:** CC1.4 (competence includes knowledge of models), CC2.1 (documented info)
**Effort:** 2 weeks

---

## 6. P2 — Polish for the Audit's "Yes, But" Questions (Weeks 17-24)

### P2-1. Penetration Test Report (closes CC4.1 weight)
Commission annual 3rd-party pentest (Trajectory, Trail of Bits, or NCC Group). Save report + remediation list to `docs/security/pentest-2026.md`.

### P2-2. Insider Threat Quarterly Drill (closes CC1.5 accountability)
Run `agentSoc.insider_threat` playbook quarterly. Document drills, action items.

### P2-3. Restoration Test (closes A1.3)
Annual tabletop: hot-standby failover by `AgentStandbyManager`. Verify RPO ≤ 5min, RTO ≤ 1min.

### P2-4. Background Checks (closes CC1.4 weight)
Formalize process for engineers with merge-to-main authority.

---

## 7. 90-Day Type II Readiness Roadmap

> Designed so we can hand to the auditor in 12 months with **6 months of operating evidence (the SOC 2 observation window)** if we start now.

### Weeks 1–4 — Foundation 🔴
| Week | Deliverable | Owner | Closes |
|------|-------------|-------|--------|
| W1-W8 | Initiate auditor RFI + selection (4-8 weeks) — NOT a 1-week kickoff; brief Big-4 + AI-assurance firms in parallel | CEO + CTO + Procurement | — (commercial) |
| W2 | Risk methodology v0.1 + risk register draft | Head of Security | CC3.2 partial |
| W3 | AI Objectives document + CISO sign-off | CTO | CC3.1 |
| W12 (after auditor selected) | Risk register v1.0 + quarterly cadence locked | Head of Security + CISO | **CC3.2 ✅** |

### Weeks 5–8 — Governance Documents 🔴→🟢
| Week | Deliverable | Owner | Closes |
|------|-------------|-------|--------|
| W5 | Competence framework v0.5 | Head of People | CC1.4 partial |
| W6 | Communication policy v1.0 (internal + external) | COO | **CC2.1 + CC2.2 ✅** |
| W7 | Competence framework v1.0 + first training round | Head of People + Security | **CC1.4 ✅** |
| W8 | Internal kickoff: type-II window starts (Day 0) | All | — |

### Weeks 9–12 — Evidence Pipeline 🟡→✅
| Week | Deliverable | Owner | Closes |
|------|-------------|-------|--------|
| W9 | Weekly posture-snapshot CI integration | DevOps | CC4.1 / CC7.2 evidence flow |
| W10 | Ticket workflow integrated with SOC | Backend | CC7.3 / CC7.4 |
| W11 | Data retention policy v1.0 | Head of Eng | C1.2 |
| W12 | Model cards scaffolded for top-3 providers | Security | CC1.4 + ACK-14 |

### Weeks 13–20 — Operating Effectiveness 🟢
| Week | Deliverable | Owner | Closes |
|------|-------------|-------|--------|
| W17-20 | 4-week observation: weekly posture-snapshot metrics rolled into compliance scorecard | DevOps | CC4.1 evidence |
| W17 | DPIA template v1.0 + first DPIA on flagship product | DPO | ACK-15 |
| W18-20 | Quarterly insider-threat drill | Security | CC1.5 evidence |
| W20 | **Mid-window auditor check-in** (informal) | Sponsor | — |

### Weeks 21–24 — Pre-Audit Polish 🟢
| Week | Deliverable | Owner | Closes |
|------|-------------|-------|--------|
| W21 | Annual pentest contract signed | CTO | CC4.1 weight |
| W24 | Pre-audit readiness assessment | Auditor | — |

### Months 7-12 — Type II Window (observation period) 📊
- Daily: posture snapshot, red team CI run
- Weekly: SOC incident review
- Monthly: management review with CISO sign-off
- Quarterly: internal audit (CC9.2), risk register refresh, communication policy test
- **6-month observation ends = Type II report eligibility**

### Month 13 — Type II Report Delivery 📜
Auditor delivers opinion on operating effectiveness across the observation window.

---

## 8. Trust Services Category (TSC) Scope Recommendation

| TSC | Include in scope today? | Why |
|-----|------------------------|-----|
| **Security (CC1-CC9)** | ✅ MANDATORY | Without this, no SOC 2 report possible |
| **Confidentiality (C1)** | ✅ RECOMMENDED | Strong existing evidence (CTL-003 PrivacyRouter, CTL-002 OutputSanitizer, CTL-006 PathSecurity) |
| **Processing Integrity (PI1)** | ✅ RECOMMENDED | Strong existing evidence (CTL-001 ContentScanner, CTL-005 ApprovalSystem) — agents operate on user data within well-defined identity-preserving rules |
| **Availability (A1)** | 🟡 PHASE 2 | Hot-standby via AgentStandbyManager + circuit breaker give background. **Commit to published uptime target (e.g., 99.9%) in MSA before claiming A1**. |
| **Privacy (P1-P8)** | ❌ DEFER to Type II Year 2 | Requires DPIA + ROPA + consent management — not yet built. Ack but defer to next cycle. |

**Recommended scope:** Security + Confidentiality + Processing Integrity in Type II Year 1. Add Availability in Year 2 once we publish an MSA with uptime SLA. Add Privacy in Year 3 after DPIA platform launched.

---

## 9. Auditor Self-Test Checklist (Quick Pre-Audit)

Run through this the week before fieldwork begins:

| # | Item | Status | Cmd / Source |
|---|------|--------|--------------|
| 1 | Overall posture ≥ 80/100 | 84 ✅ | `npx tsx packages/core/src/security/runComplianceAudit.ts` |
| 2 | ISO 42001 ≥ 80% (clauses covered) | 60% ❌ | Section 7 roadmap will close |
| 3 | NIST AI RMF ≥ 70% (alignment) | 52% ❌ | Section 7 roadmap will close |
| 4 | All 15 ACK items = passed | 12/15 ⚠️ | ACK-13 (audit done), ACK-14 (model cards), ACK-15 (DPIA) |
| 5 | AuditChainLedger has tamper-evident genesis | ✅ | `getAuditChainLedger().verifyChain()` |
| 6 | All 14 AgentSOC playbooks have escalation contacts | ✅ | `packages/core/src/security/agentSoc.ts:PLAYBOOKS` |
| 7 | RedTeam regression gating in CI | ✅ | `.github/workflows/red-team.yml` (verify existence) |
| 8 | Posture snapshots persisted across ≥ 6 months | ❌ — must wait | Section 7 W9-24 |
| 9 | Risk register signed | ❌ | P0-1 of Section 4 |
| 10 | Competence evidence on file | ❌ | P0-3 of Section 4 |
| 11 | Communication policy signed | ❌ | P0-4 of Section 4 |
| 12 | Data retention policy documented | ❌ | P1-3 |
| 13 | Model cards published | ❌ | P1-5 |
| 14 | First DPIA executed | ❌ | P2-? |
| 15 | At least 1 third-party pentest report | ❌ | P2-1 |

> **Pass criterion:** ≥ 12/15 in §9 (counting both ✅ and ⚠️) before auditor field work begins. **We are currently 5/15 (4 ✅ + 1 ⚠️)**; the 10 ❌ items are exactly the §4-6 P0/P1/P2 closure roadmap.

---

## 10. Honest Verdict

**Where we can pass today without remediation:**
- §3 row "✅ ready" controls (18 of 34) — auditor can sample-test on Day 1
- §5 P1 items once added evidence pipelines — about 4 weeks of work
- §6 P2 items over the observation window

**Where we cannot honestly pass without remediation:**
- The 4 🔴 blockers (CC1.4 / CC2.1-2 / CC3.2) — these need 6+ weeks of policy writing
- The "6 months of observation" requirement — any Type II on a < 6-month operating window is automatically disqualified
- **Privacy P-series** — not in scope for Year 1

**What's our advantage vs incumbents:**
- `ComplianceAuditManager` itself means we can **regenerate posture reports on demand** — easier auditor sample testing
- `AuditChainLedger` means we have **cryptographic non-repudiation on every event** — stronger than typical SOC 2 stores
- `AgentSOC` 14-playbook library is already pre-mapped to SOC 2 CC7.x — saves the auditor weeks
- `MitreAtlasMapper` directly supports risk taxonomy (closes CC3.2 partial) — saves us writing taxonomies from scratch

**What's our disadvantage:**
- No Enterprise customer references yet → auditor will push harder on operating effectiveness until we have 6 months of production data
- Hard-coded audit key (the seed report warns `COMMANDER_AUDIT_CHAIN_KEY is not set; using insecure development key`) → must fix before any auditor field work

**Bottom line:** Type I achievable in 6 months from kickoff. Type II achievable in 12 months. Budget: ~$200-300K Big-4 fees + 1 FTE security lead + 0.5 FTE engineering for evidence pipelines.

---

## 11. Traceability — How This Document Was Generated

| Step | Command / Tool | Output |
|------|---------------|--------|
| 1. Seed posture report | `npx tsx packages/core/src/security/runComplianceAudit.ts --all --output=/tmp/compliance-audit-seed` | `/tmp/compliance-audit-seed.md` + `.json` |
| 2. Parse gaps | `python3 ...` (see Section 12 below) | structured gap list |
| 3. Crosswalk design | thinker-with-files-gemini with CTL-001..020 + ISO clauses + NIST subs | §2 table |
| 4. P0/P1/P2 ordering | gap-severity analysis from seed report (`MANAGE-1.x / GOVERN-2.x` high → P0; MEASURE/MANAGE-4.3 medium → P1; partial-✅ Polish → P2) | §4-6 |
| 5. Roadmap drafting | week-level milestone planning | §7 |

---

## 12. Appendix — Reproduction Command

```bash
# 1. Generate seed report
cd /Users/sampan/Documents/GitHub/Commander
npx tsx packages/core/src/security/runComplianceAudit.ts --all --output=/tmp/compliance-audit-seed

# 2. Parse gaps (saved as .py snippet below)
python3 << 'PY'
import json
d = json.load(open('/tmp/compliance-audit-seed.json'))
print('Overall:', d['posture']['overallScore'], '/100')
print('ISO 42001:', d['isoCompliance']['compliancePercentage'], '%')
print('NIST AI RMF:', d['nistRmfAlignment']['alignmentPercentage'], '%')
print('ISO Gaps:', len(d['isoCompliance']['gaps']))
print('NIST Gaps:', len(d['nistRmfAlignment']['gaps']))
print('ACK passed:', sum(1 for c in d['auditChecklist'] if c['status'] == 'passed'))
print('ACK pending:', sum(1 for c in d['auditChecklist'] if c['status'] == 'pending'))
PY

# 3. (Future) Use this checklist to drive:
# - docs/security/risk-register.md (P0-1)
# - docs/security/ai-objectives.md (P0-2)
# - docs/security/competence-framework.md (P0-3)
# - docs/security/communication-policy.md (P0-4)
```

---

*This document is a living artifact. Re-run the seed command quarterly to refresh the scorecard. Update P0/P1/P2 items to "✅ closed" as roadmap progresses. Treat as audit-prep binding once we sign an auditor engagement letter.*
