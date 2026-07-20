# Architecture Boundary Note — 2026-07-20 (security store durability)

## Fixed (small, isolated)

**Boundary:** Storage durability helper vs security-sensitive Gateway JSON stores.

**Violation:** Multiple `apps/api` modules persisted auth/config state with either:

- in-place `fs.writeFileSync` (truncating, crash-corruptible), or
- tmp+rename without fsync (rename-atomic on POSIX but not durable across power loss),
- **and** load paths that treated corrupt **or wrong-shape** JSON as `[]` / empty, so the next
  legitimate write permanently wiped recoverable auth material (REL-4 class).

Affected surfaces: `userStore` (password hashes), `apiKeyStore`, `refreshTokenStore`,
`webhookEndpoints`, `approvalConfigEndpoints`, `oidcAuthEndpoints`, `settingsStore`,
`workflowEndpoints`, `actionRationale`, `onboardingEndpoints`.

**Why it existed:** Local/single-node Gateway grew file-backed stores before
`atomicWrite.ts` was extracted as the shared REL-3/REL-4 helper for `WarRoomStore` /
`AgentStateStore`. Partial upgrades left security stores on weaker write **and**
silent-empty / silent-wrong-shape read paths.

**Fix:** Route all listed write paths through `atomicWriteFileSync` (fsync + rename).
Route all listed load paths through `readJsonFileSafe` with an explicit top-level shape
guard (`Array.isArray` / `isPlainObjectJson` / signed-or-array). Corrupt **and** legal
wrong-shape JSON (e.g. `{"users":[...]}`, `{"keys":[...]}`) quarantine to
`<file>.corrupt-<ts>` — same fail-closed path as parse failure. Enforced by
`claimHonesty` (REL-3 **and** REL-4 + shape). Behavioral coverage:
`apps/api/test/securityStoreCorruptLoad.test.ts` (corrupt + wrong-shape wipe class).

**Not fixed (by design):** These remain file-backed local SKU stores — not multi-replica
authorities. Enterprise multi-node identity should eventually move to a real IdP / DB
authority; this PR only closes the crash-corruption + corrupt/wrong-shape-load-wipe hole
on the existing design.

## 信心缺口（诚实声明 — 勿当 REL-4 满分）

- `readJsonFileSafe` **隔离损坏/错形字节**，不恢复内容；运维需从 `.corrupt-*` 人工抢救。
- 静态 `claimHonesty` 证明源码引用了 helper **与** shape guard，**不**证明每个运行时分支
  都走隔离路径（`refreshTokenStore` 完整性失败 / signed `records` 非数组另有显式 quarantine）。
- 单机 JSON SKU：无跨进程锁、无多副本权威；HMAC 密钥轮换可能导致 refresh ledger 误隔离。
- 仅禁 `fs.writeFileSync` 曾给出假 REL-4 自信；现已强制 `readJsonFileSafe` + shape，但仍非 IdP。

## Residual related debt

- Dual PEP: V1 `SideEffectGate` + ATR `scheduleAction` (local) vs V2 `effect-broker`
  (capability token + kernel admit). Intended strangler split; do not merge naively.
- `scimUserStore` / `knowledgeStore` already have private atomic helpers — candidates
  to converge on shared `atomicWrite` later.
