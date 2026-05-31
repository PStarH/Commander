# Commander Security Architecture

## Overview

Commander implements a **defense-in-depth** security model with multiple independent layers. No single layer is trusted; each assumes the others may fail.

```
┌─────────────────────────────────────────────────────────────────┐
│                    User / LLM Input                             │
├─────────────────────────────────────────────────────────────────┤
│  Layer 0: Security Audit & Monitoring                           │
│  ┌─────────────────────┐ ┌────────────────────────────────────┐ │
│  │ SecurityAuditLogger  │ │ SecurityMonitor                   │ │
│  │ (17 event types,     │ │ (burst detection, failure         │ │
│  │  JSON Lines,         │ │  patterns, severity escalation,   │ │
│  │  MessageBus alerts)  │ │  health status)                   │ │
│  └─────────────────────┘ └────────────────────────────────────┘ │
├─────────────────────────────────────────────────────────────────┤
│  Layer 1: Input Validation & Repair                             │
│  ┌─────────────┐ ┌──────────────┐ ┌──────────────────────────┐ │
│  │ Tool Call    │ │ Tool Call    │ │ Content Scanner          │ │
│  │ Validator    │ │ Repair       │ │ (prompt injection,       │ │
│  │ (schema)     │ │ (JSON fix)   │ │  hidden HTML, Unicode)   │ │
│  └─────────────┘ └──────────────┘ └──────────────────────────┘ │
├─────────────────────────────────────────────────────────────────┤
│  Layer 2: Authorization & Approval                              │
│  ┌─────────────┐ ┌──────────────┐ ┌──────────────────────────┐ │
│  │ AuthManager  │ │ Approval     │ │ ExecPolicy Engine        │ │
│  │ (RBAC, API   │ │ System       │ │ (command allowlist,      │ │
│  │  keys, rate  │ │ (modes,      │ │  default-prompt)         │ │
│  │  limiting)   │ │  callbacks)  │ │                          │ │
│  └─────────────┘ └──────────────┘ └──────────────────────────┘ │
├─────────────────────────────────────────────────────────────────┤
│  Layer 3: Execution Sandboxing                                  │
│  ┌─────────────┐ ┌──────────────┐ ┌──────────────────────────┐ │
│  │ macOS        │ │ Linux        │ │ Docker                   │ │
│  │ Seatbelt     │ │ Bubblewrap   │ │ (--cap-drop ALL,         │ │
│  │ (SBPL        │ │ (user/pid/   │ │  --no-new-privileges,    │ │
│  │  profiles)   │ │  ipc ns)     │ │  --read-only)            │ │
│  └─────────────┘ └──────────────┘ └──────────────────────────┘ │
├─────────────────────────────────────────────────────────────────┤
│  Layer 4: Execution Routing & Isolation                         │
│  ┌─────────────────────┐ ┌────────────────────────────────────┐ │
│  │ ExecutionRouter      │ │ Lane Manager                      │ │
│  │ (local/ssh/docker    │ │ (concurrency isolation,           │ │
│  │  backend selection)  │ │  tenant isolation, priority)      │ │
│  └─────────────────────┘ └────────────────────────────────────┘ │
├─────────────────────────────────────────────────────────────────┤
│  Layer 5: Credential & Secret Management                        │
│  ┌─────────────────────┐ ┌────────────────────────────────────┐ │
│  │ CredentialManager    │ │ Env Filtering                     │ │
│  │ (centralized,        │ │ (deny-list for Docker/SSH,        │ │
│  │  masked logging)     │ │  prefix blocking)                 │ │
│  └─────────────────────┘ └────────────────────────────────────┘ │
├─────────────────────────────────────────────────────────────────┤
│  Layer 6: Memory & Skill Security                               │
│  ┌─────────────────────┐ ┌────────────────────────────────────┐ │
│  │ Memory Poisoning     │ │ Skill Security Scanner            │ │
│  │ Detector             │ │ (shell injection, path traversal, │ │
│  │ (embedding anomaly,  │ │  credential exposure, dangerous   │ │
│  │  contradiction)      │ │  API detection)                   │ │
│  └─────────────────────┘ └────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

## Threat Model

### Assets Protected
1. **User credentials** — API keys, tokens, SSH keys
2. **Filesystem** — Workspace files, system files, configuration
3. **System integrity** — Prevention of arbitrary code execution
4. **Memory/knowledge base** — Prevention of poisoning attacks
5. **User trust** — Prevention of prompt injection hijacking

### Attack Vectors

| Vector | Example | Defense Layer |
|--------|---------|---------------|
| Prompt injection | "Ignore previous instructions" | Content Scanner (multilingual) |
| Command injection | `workdir="/tmp"; rm -rf /` | Input validation, shell metachar detection |
| Path traversal | `../../../etc/passwd` | Path validation, protected paths |
| Credential leakage | Exfiltrating API keys via env | Env filtering, CredentialManager masking |
| Sandbox escape | Exploiting container misconfig | Docker hardening, Seatbelt/Bubblewrap |
| Memory poisoning | Injecting false memories | Embedding anomaly detection |
| Shell metachar bypass | Unicode/encoding tricks | Extended character class detection |
| Timing attacks | Measuring auth response times | crypto.timingSafeEqual |
| Brute force auth | Repeated API key attempts | Rate limiting |

## Layer Details

### Layer 0: Security Audit & Monitoring (NEW)

**Files:** `security/securityAuditLogger.ts`, `security/securityMonitor.ts`

- **SecurityAuditLogger**: Centralized audit trail for all security events
  - 17 event types: sandbox_violation, auth_failure, auth_success, auth_rate_limit, approval_denied, content_threat, exec_policy_violation, credential_access, input_validation_failure, path_traversal_attempt, command_injection_attempt, memory_poisoning_detected, etc.
  - Append-only JSON Lines persistence (.commander_security/)
  - In-memory ring buffer (10K events) for fast querying
  - Metrics integration (counters per event type/severity)
  - MessageBus integration for real-time alerting

- **SecurityMonitor**: Continuous health monitoring and anomaly detection
  - Burst detection (20+ events in 1 minute window)
  - Repeated failure detection (10+ failures from same source in 5 minutes)
  - Severity escalation detection (high→critical chain)
  - Health status: healthy/elevated/critical
  - Auto-dismisses old alerts (1 hour TTL)

### Layer 1: Input Validation & Repair

**Files:** `runtime/toolCallValidator.ts`, `runtime/toolCallRepair.ts`, `contentScanner.ts`

- **Tool Call Validator**: JSON Schema validation with 5-step pipeline (defaults, required, types, enums, ranges)
- **Tool Call Repair**: Multi-strategy malformed JSON recovery (never invents data)
- **Content Scanner**: Detects prompt injection (6 languages), hidden HTML/CSS, Unicode obfuscation, metadata injection

**Design principle**: Validate early, repair if safe, reject if dangerous.

### Layer 2: Authorization & Approval

**Files:** `runtime/authManager.ts`, `sandbox/approval.ts`, `sandbox/execPolicy.ts`

- **AuthManager**: RBAC (admin/operator/viewer), API key lifecycle, SHA-256 hashed storage, timing-safe comparison, rate limiting
- **Approval System**: Mode-based (read-only, suggest, auto-edit, full-auto, plan), session caching, callback-based user approval
- **ExecPolicy Engine**: Command allowlist with priority-based rules, **default-prompt** for unknown commands

**Design principle**: Fail-safe defaults. Unknown = prompt, not allow.

### Layer 3: Execution Sandboxing

**Files:** `sandbox/platforms.ts`, `sandbox/profiles.ts`

#### macOS Seatbelt
- Closed-by-default SBPL policy
- Filesystem: read/write/protected path lists
- Network: blocked/allowlisted/proxy/full
- Process: same-sandbox only
- Mach IPC: allowlisted services only
- Sensitive dotfiles (.ssh, .gnupg) denied

#### Linux Bubblewrap
- User/PID/IPC namespace isolation
- Read-only system binds (/usr, /lib, /bin, /etc)
- Network namespace when blocked
- Protected paths as read-only binds

#### Docker
- `--cap-drop ALL` — drop all Linux capabilities
- `--security-opt no-new-privileges` — prevent privilege escalation
- `--read-only` — read-only root filesystem
- `--tmpfs /tmp:rw,noexec,nosuid,size=64m` — limited temp space
- `--network none` when network blocked
- `--memory` limit when specified

**Design principle**: Each sandbox assumes the command IS malicious.

### Layer 4: Execution Routing & Isolation

**Files:** `sandbox/executionRouter.ts`, `sandbox/lane.ts`

- **ExecutionRouter**: Routes to local/ssh/docker backends based on tool args
- **Lane Manager**: Concurrency isolation per tenant/task type/priority
- **Backend validation**: SSH host, container name, workdir all validated before use

### Layer 5: Credential Management

**Files:** `runtime/credentialManager.ts`, `sandbox/backends/dockerExecBackend.ts`

- **CredentialManager**: Centralized loading, masked logging (`sk-...AB12`), `clear()` for cleanup
- **Docker env filtering**: Blocks keys with sensitive prefixes (AWS_, GCP_, NPM_) and patterns (KEY, SECRET, TOKEN, PASSWORD, CREDENTIAL, AUTH, PRIVATE, SIGNATURE)

### Layer 6: Memory & Skill Security

**Files:** `apps/api/src/memoryPoisoningDetector.ts`, `skills/skillSecurityScanner.ts`

- **Memory Poisoning Detector**: Embedding distribution anomaly (>2σ), contradiction detection, source credibility scoring
- **Skill Security Scanner**: Shell injection, path traversal, credential exposure, dangerous API detection

## Security Test Suite

**Files:** `tests/security-hardening.test.ts`, `tests/sandbox-security.test.ts`

26 tests covering:
- SSH workdir command injection
- Docker container name validation
- Shell metacharacter detection
- ExecPolicy fail-safe defaults
- Full-access profile hardening
- LocalBackend workdir validation
- Docker credential filtering
- Path traversal detection
- Prompt injection patterns

Run with:
```bash
npx tsx --test packages/core/tests/security-hardening.test.ts
npx tsx --test packages/core/tests/sandbox-security.test.ts
```

## Known Limitations

1. **ExecPolicy pattern matching**: Sophisticated obfuscation (hex encoding, base64) can bypass pattern matching. Mitigation: sandbox containment.
2. **Prompt injection detection**: Pattern-based detection can be bypassed by novel phrasing. Mitigation: content scanner runs on both input and output.
3. **Docker escape**: Container escapes via kernel vulnerabilities are outside our control. Mitigation: `--cap-drop ALL`, `--no-new-privileges`.
4. **Side-channel attacks**: Timing, power analysis, etc. are not addressed. Mitigation: rate limiting on auth.

## Security Checklist for New Features

- [ ] Does it handle user input? → Validate with ToolCallValidator
- [ ] Does it execute commands? → Route through ExecutionRouter with sandbox
- [ ] Does it access credentials? → Use CredentialManager, never log raw keys
- [ ] Does it read/write files? → Use SandboxProfile path lists
- [ ] Does it accept external content? → Scan with ContentScanner
- [ ] Does it modify memory? → Check with MemoryPoisoningDetector
- [ ] Does it add new tools? → Define schema, add to ExecPolicy if needed
- [ ] Does it add new backends? → Validate all inputs (host, container, workdir)

## References

- [OWASP Top 10 for LLM Applications v1.1](https://owasp.org/www-project-top-10-for-large-language-model-applications/)
- [SandboxEscapeBench (arXiv:2603.02277)](https://arxiv.org/abs/2603.02277)
- [OpenClaw Security Analysis (arXiv:2603.10387)](https://arxiv.org/abs/2603.10387)
- [OpenAI Codex Seatbelt Policy](https://github.com/openai/codex/blob/9a8730f3/codex-rs/sandboxing/src/seatbelt_base_policy.sbpl)
- [Chromium Sandbox Policy](https://source.chromium.org/chromium/chromium/src/+/main:sandbox/policy/mac/common.sb)
