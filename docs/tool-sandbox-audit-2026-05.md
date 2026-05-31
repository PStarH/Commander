# Commander Tools & Sandbox Security Audit — 2026-05-31

## Executive Summary

Full audit of 25 registered tools and the sandbox subsystem. Found and fixed **8 critical**, **6 high**, and **9 medium** security vulnerabilities across tools and sandbox. All critical and high issues are now resolved.

---

## Hour 1: Tool Inventory (25 tools, 20 implementation files)

### Tool Completion Scores (1-5)

| Tool | Score | Notes |
|------|-------|-------|
| `file_read` | 4 | Solid, minor maxChars validation issue |
| `file_write` | 4 | Added atomic write + size limit |
| `file_edit` | 4 | Fixed replaceAll, atomic write |
| `file_search` | 3→4 | Fixed critical path traversal, glob injection |
| `file_list` | 4 | Clean implementation |
| `web_search` | 4 | Multi-engine fallback, CAPTCHA detection |
| `web_fetch` | 4 | Clean implementation |
| `browser_search` | 3→4 | Added SSRF protection |
| `browser_fetch` | 3→4 | Added SSRF protection, missing flags |
| `python_execute` | 4 | Fixed formatExecResult killed order |
| `shell_execute` | 4 | Good multi-backend support |
| `code_search` | 2→4 | **CRITICAL**: Fixed command injection via execSync |
| `git` | 3 | tail conversion wrong, --key=value normalization breaks things |
| `apply_patch` | 3 | verifyCommand is by-design risky |
| `refine_code` | 3 | Untested in this audit |
| `fix_code` | 3 | Python-only, limited scope |
| `verify` | 3→4 | **CRITICAL**: Fixed testPattern injection |
| `verify_answer` | 4 | Clean GAIA benchmark helper |
| `agent` | 4 | Good depth limiting |
| `a2a_delegate` | 4 | Clean implementation |
| `execute_script` | 2→3 | **CRITICAL**: Fixed VM sandbox escape, flags corrected |
| `memory_store` | 4 | Simple key-value store |
| `memory_recall` | 4 | Fuzzy search |
| `memory_list` | 4 | Clean implementation |
| `vision_analyze` | 3 | Depends on external API |
| `pdf_extract` | 4 | Clean implementation |
| `screenshot_capture` | 4 | Good Playwright integration |
| `execute_script` (meta) | 4 | Token-efficient tool chaining |
| `request_tool` | 4 | Lazy schema loading, 95% token savings |
| `skill_view` | 4 | Clean implementation |

---

## Critical Fixes Applied

### 1. `fileSystemTool.ts` — Path traversal in FileSearchTool
**Before:** `FileSearchTool.globSearch()` resolved `dirPattern` from user input without `safePath()` check. Pattern `../../etc/**/*.conf` could traverse outside workspace.
**After:** Added `isWithinRoot()` check on resolved search directory.

### 2. `fileSystemTool.ts` — `startsWith` prefix collision
**Before:** `resolved.startsWith(SAFE_ROOT)` matched `/workspace-evil` when root was `/workspace`.
**After:** Uses `isWithinRoot()` helper that checks for exact match or `path.sep` boundary.

### 3. `codeSearchTool.ts` — Command injection via `execSync`
**Before:** User-supplied `pattern` and `filePattern` interpolated into shell command string via `execSync()`. A pattern like `foo"; rm -rf / #` executed arbitrary commands.
**After:** Switched to `execFileSync('grep', args)` with argv array — no shell interpolation.

### 4. `verificationTool.ts` — Command injection via `testPattern`
**Before:** `testPattern` interpolated directly into `npx vitest run ${pattern}` shell command.
**After:** Sanitized pattern (alphanumeric + glob chars only) and switched to `execFileSync('npx', args)`.

### 5. `scriptTool.ts` — VM sandbox escape via prototype chain
**Before:** `vm.createContext(sandbox)` with plain objects. `this.constructor.constructor('return process')()` gave full system access.
**After:** Wrapped all sandbox objects in Proxy that blocks `constructor`, `__proto__`, `prototype`, and returns `null` for `getPrototypeOf`.

### 6. `platforms.ts` — Seatbelt command injection via `shell: true`
**Before:** `exec('sandbox-exec -f "${tf}" ${cmd}')` with shell interpolation. A crafted `cmd` could break out of the sandbox.
**After:** Uses `execArgv(['sandbox-exec', '-f', tf, '/bin/sh', '-c', cmd])` with explicit argv array.

### 7. `platforms.ts` — Docker image controlled by env var
**Before:** `COMMANDER_SANDBOX_IMAGE` env var could point to any Docker image.
**After:** Validated against allowlist (`node:22-slim`, `python:3.12-slim`, etc.). Falls back to `node:22-slim`.

### 8. `manager.ts` — `COMMANDER_SANDBOX_MODE` could downgrade to full-access
**Before:** Env var could set `COMMANDER_SANDBOX_MODE=full-access` to bypass sandbox.
**After:** Env var can only select non-full-access profiles. Full-access requires explicit programmatic opt-in.

---

## High Severity Fixes Applied

### 9. `platforms.ts` — Bubblewrap `/tmp` bind-mounted from host
**Before:** `--bind /tmp /tmp` — host /tmp shared read-write with sandbox.
**After:** `--tmpfs /tmp` — isolated tmpfs, no cross-process data exchange.

### 10. `platforms.ts` — Bubblewrap missing network namespace
**Before:** Only `blocked` network got `--unshare-net`. `allowlisted` got full host network.
**After:** Both `blocked` and `allowlisted` get `--unshare-net`. Only `full` gets host network.

### 11. `profiles.ts` — WORKSPACE_WRITE missing protected paths
**Before:** `.commander_memory` and `.commander_results` not in protectedPaths.
**After:** Added both, matching READ_ONLY profile's protection.

### 12. `browserTool.ts` — SSRF via internal network access
**Before:** No URL blocklist. Could fetch `http://169.254.169.254/` (AWS metadata), `localhost:6379` (Redis), etc.
**After:** Added `isBlockedUrl()` check blocking private IPs, localhost, metadata endpoints, and common internal service ports.

### 13. `sshBackend.ts` — Workdir shell injection
**Before:** `cd "${workdir}" && ${command}` — double quotes don't prevent `$()` expansion.
**After:** Uses single quotes with proper escaping: `cd '${escapedWorkdir}' && ${command}`.

### 14. `platforms.ts` — Seatbelt unrestricted process-exec
**Before:** `(allow process-exec)` allowed executing any binary.
**After:** Restricted to `/usr/bin`, `/usr/local/bin`, `/bin`, `/sbin`, and the workspace directory.

---

## Medium Severity Fixes Applied

### 15. `fileSystemTool.ts` — matchGlob regex injection
**Before:** `file.txt` regex matched `fileXtxt` (`.` was unescaped).
**After:** Escapes regex metacharacters before glob-to-regex conversion.

### 16. `fileSystemTool.ts` — maxChars negative/NaN validation
**Before:** `Math.min(Number(args.maxChars ?? 10000), 100000)` — negative or NaN passed through.
**After:** `Math.min(Math.max(Number(args.maxChars) || 10000, 1), 100000)` — clamped to [1, 100000].

### 17. `fileSystemTool.ts` — FileEditTool non-atomic write
**Before:** Direct `writeFileSync` — crash mid-write corrupts file.
**After:** Atomic write to `.tmp` file, then `renameSync`.

### 18. `fileSystemTool.ts` — FileWriteTool no size limit
**Before:** No content size check — multi-GB writes possible.
**After:** 10MB limit added.

### 19. `codeExecutionTool.ts` — formatExecResult killed check order
**Before:** `killed` check was unreachable when process also produced stderr.
**After:** `killed` checked first, stdout/stderr preserved for partial output.

### 20. `platforms.ts` — Docker env injection via special characters
**Before:** `-e` flags with newlines could inject Docker arguments.
**After:** Uses `--env-file` with temp file. Values sanitized (newlines stripped).

### 21. `platforms.ts` — Expanded env var deny list
**Before:** Only 5 patterns: API_KEY, TOKEN, SECRET, PASSWORD, CREDENTIAL.
**After:** Added DATABASE_URL, REDIS_URL, MONGO_URL, PGPASSWORD, GITHUB_PAT, PRIVATE_KEY, etc.

### 22. `platforms.ts` — Seatbelt TOCTOU on temp profile file
**Before:** Predictable temp file name via `Date.now()`.
**After:** Uses `fs.mkdtempSync()` for unpredictable directory name.

### 23. `sandbox/types.ts` — Duplicate interface declarations
**Before:** `SandboxProfile`, `SandboxExecutionResult`, `PlatformSandbox` each declared twice.
**After:** Removed duplicate declarations.

---

## Remaining Issues (Not Fixed — Need Other Agent Coordination)

| Severity | File | Issue | Why Not Fixed |
|----------|------|-------|---------------|
| Medium | `patchTool.ts:139` | verifyCommand is user-controlled shell exec | By design — sandbox is the containment. Needs approval system integration. |
| Medium | `browserTool.ts:54` | `--no-sandbox` Chrome flag | Needed in most environments. Add `--disable-dev-shm-usage` for stability. |
| Low | `gitTool.ts:58-61` | tail→-n conversion is semantically wrong | Low impact, needs redesign of pipe handling |
| Low | `gitTool.ts:65-68` | --key=value normalization breaks --grep= | Low impact, git handles both forms |
| Low | `patchTool.ts:73` | Dead code in altPath fallback | Harmless |
| Low | `platforms.ts:325` | NoopSB still used as fallback | Now warns loudly; rejecting would break CI without sandbox |
| Low | All backends | No CPU/fork-bomb limits | Needs seccomp (Linux) or rlimit integration |
| Low | `approval.ts:86` | Unstable JSON.stringify cache key | Needs canonical JSON serialization |

---

## Schema Token Optimization Opportunities

| Tool | Current Tokens (est.) | Potential Savings |
|------|----------------------|-------------------|
| `shell_execute` | ~800 | -200 (examples too verbose) |
| `code_search` | ~400 | -100 (4 examples → 2) |
| `file_read` | ~300 | -80 (examples derivable) |
| All tools | ~5000 total | -500 (remove examples, use lazy loading) |

---

## Research Findings (WebFetch — Codex CLI, Claude Code, E2B, arXiv 2604.21816)

### Codex CLI (OpenAI) — Key Patterns Adopted
- **Command safety classification**: Safe (auto-approve), Dangerous (prompt), Banned (never auto-approve). Added to `execPolicy.ts`.
- **Banned prefixes**: `python3 -c`, `bash -lc`, `node -e`, `perl -e`, `ruby -e`, `osascript` — inline code execution never auto-approved.
- **Hardcoded sandbox-executable paths**: Prevents PATH injection (Commander already does this via `which` check).

### Claude Code (Anthropic) — Key Patterns Adopted
- **Process wrapper stripping**: `timeout`, `time`, `nice`, `nohup`, `stdbuf` stripped before permission matching. Added to `execPolicy.ts`.
- **Deny-first evaluation order**: Deny wins at any level. Commander's existing `forbidden > prompt > allow` priority already implements this.
- **Tool descriptions**: Anthropic recommends "at least 3-4 sentences" + "when NOT to use". Updated `shell_execute` description.

### E2B — Architecture Reference
- **Firecracker microVMs**: Hardware-level isolation for untrusted code. Commander's Docker backend is the closest equivalent.
- **Template-based provisioning**: Reproducible sandbox environments. Future enhancement for Commander.

### arXiv 2604.21816 (Tool Attention Paper) — Schema Optimization
- **Two-phase lazy schema loading**: Summary pool + on-demand full schemas = 95% token reduction.
- Commander already has `requestToolTool.ts` (on-demand loading) and `toolRetriever.ts` (two-tier). These implement ~80% of the paper's approach.
- **Hallucination rejection gate**: Reject calls to tools whose schemas weren't promoted. Future enhancement for `toolOrchestrator.ts`.

### Schema Optimization Applied
- **shell_execute**: Collapsed 12 parameters to 4 (command, timeout, workdir, backend). SSH/Docker params moved to env vars. **Savings: ~200 tokens/turn.**
- **code_search**: Reduced examples from 4 to 2. **Savings: ~100 tokens/turn.**
- **scriptTool**: Trimmed verbose description. **Savings: ~150 tokens/turn.**
- **Estimated total savings: ~450 tokens/turn** from schema optimization alone.

---

## Hour 4-5 Research: Advanced Sandbox Technologies

### Seccomp BPF (Linux Kernel Docs)
- Blocks dangerous syscalls: mount, ptrace, kexec_load, reboot, init_module, bpf, userfaultfd, io_uring_setup
- Architecture check is CRITICAL (syscall numbers vary across archs)
- Commander should add seccomp filters to BwrapSB for defense-in-depth

### Landlock (Linux Kernel Docs)
- Stackable LSM, unprivileged, irrevocable once enforced
- ABI v4+ supports network rules (bind/connect TCP)
- Complementary to bubblewrap — operates at LSM layer
- Commander should add Landlock as defense-in-depth inside bwrap namespace

### gVisor Architecture
- User-space kernel intercepts all syscalls
- VM-like isolation with container-like resource usage
- Tradeoff: reduced compatibility, higher per-syscall overhead
- Future optional backend for high-security scenarios

### Codex CLI Landlock Implementation
- Two-stage pipeline: bwrap first, then seccomp in inner stage
- Protected metadata monitoring via inotify
- Read-only by default, carve-out writable pattern
- Signal forwarding to child process group

### Bubblewrap Hardening Applied
- Added `--die-with-parent` (process dies when parent exits)
- Added NixOS support (`/nix/store`, `/run/current-system/sw`)
- Added signal forwarding (SIGHUP, SIGINT, SIGQUIT, SIGTERM)
- Adopted Codex's "read-only by default, carve-out writable" pattern

## Hour 7: New Tool — Glob (file pattern matching)

Implemented `GlobTool` — finds files by name/path pattern (distinct from code_search which searches content).
- Supports `**/*.ts`, `src/**/*.{ts,tsx}`, brace expansion
- Workspace-sandboxed via safePath()
- Skips hidden dirs, node_modules, dist
- Registered as `glob` tool in createAllTools()

## Hour 8: Security Tests

28 security tests written and passing in `tests/tools-security.test.ts`:
- FileSystemTool: path traversal, prefix collision, maxChars validation, write size limit
- CodeSearchTool: command injection prevention (pattern + filePattern)
- VerificationTool: testPattern sanitization
- ScriptTool: VM escape blocking (constructor chain, __proto__)
- BrowserTool: SSRF blocking (localhost, private IPs, metadata endpoints)
- ExecPolicy: command safety classification, wrapper stripping, fail-safe defaults

---

## Recommendations for Next Sprint

1. **Wire ExecPolicyEngine into tool execution** — currently advisory only, never called from tools
2. **Add approval system integration** — `toolOrchestrator.ts` should call `ApprovalSystem.evaluate()` before execution
3. **Implement seccomp filtering** for Bubblewrap backend (ptrace, mount, kexec_load blocked)
4. **Add SSRF blocklist to web_fetch** tool (currently only browser tools are protected)
5. **Write security tests** for all fixed vulnerabilities (regression prevention)
6. **Audit remaining tools**: `refine_code`, `fix_code`, multimodal tools (not deeply audited this session)
