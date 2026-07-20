# L3-11：Evidence Bundle v0（可验证执行证据导出）

**状态：HTTP 面 ENFORCED（`GET /v1/runs/:runId/evidence`）；WORM/SIEM 锚定仍非范围**  
**范围：Phase 1 Spec → Phase 2 Build → Phase 3 Review & Audit**  
**关联：L3-03a Effect 垄断、WS2 §audit 双写、WS9 §6 审计链（远期对齐）**

---

## 1. 依据与问题定义

控制平面必须能导出**可验证**的执行证据，供安全、合规与事后对账使用。证据须绑定：

- 工作负载 / 租户身份（capability grant metadata，而非 ambient header）
- 策略决策（`policyDecisionId`、`policySnapshotId`）
- 人工审批（若有 `interactionId`）
- Effect 账本条目（id、state、requestHash、脱敏 response summary）
- 版本锚点（policy snapshot、work graph、bundle schema）

**DLP 硬规则（与 CLAUDE.md §5 一致）：** 默认**不**导出 chain-of-thought、原始 prompt、`gen_ai.prompt` / `gen_ai.completion` / `gen_ai.tool.call.arguments` 等字段。LLM effect 仅保留 `contentHash` 等绑定摘要。

v0 **不**建设通用 trace warehouse；复用 `commander_effects` + `AuditSink` + `CapabilityGrant` 元数据。

---

## 2. Bundle 结构（`l3-11.v0`）

```json
{
  "schemaVersion": "l3-11.v0",
  "bundleId": "uuid",
  "exportedAt": "ISO-8601",
  "scope": { "tenantId": "...", "runId": "...", "effectId": "..." },
  "identity": {
    "intentHash": "...",
    "workGraphHash": "...",
    "capabilityGrant": {
      "jti": "...",
      "issuer": "...",
      "audience": "...",
      "requestHash": "...",
      "policySnapshotId": "..."
    }
  },
  "versions": {
    "policySnapshotId": "...",
    "workGraphVersion": "...",
    "kernelApiVersion": "v2"
  },
  "effects": [
    {
      "effectId": "...",
      "stepId": "...",
      "type": "llm.invoke",
      "state": "COMPLETED",
      "policyDecisionId": "pd_...",
      "requestHash": "sha256...",
      "approvalInteractionId": "int_...",
      "responseSummary": { "contentHash": "...", "status": "ok" },
      "entryHash": "sha256...",
      "prevEntryHash": "0000...00"
    }
  ],
  "auditEvents": [
    {
      "type": "effect.completed",
      "at": "...",
      "severity": "low",
      "details": { "effectId": "...", "policyDecisionId": "..." },
      "entryHash": "sha256...",
      "prevEntryHash": "..."
    }
  ],
  "contentHash": "sha256(canonical body without contentHash)"
}
```

- `effects[]` 与 `auditEvents[]` 各自形成 **prevEntryHash → entryHash** 链（GENESIS = 64 个 `0`）。
- `contentHash` 覆盖 `schemaVersion` 至 `auditEvents` 的 canonical JSON（键排序稳定）。

---

## 3. 导出 API（v0）

| 入口 | 位置 | 说明 |
|------|------|------|
| `buildRunEvidenceBundle()` | `packages/effect-broker/src/evidenceBundle.ts` | 按 run 聚合 effects + audit + identity |
| `buildEffectEvidenceBundle()` | 同上 | 单 effect 窄 bundle |
| `verifyEvidenceBundle()` | 同上 | 校验 entry 链 + contentHash + DLP 字段缺席 |
| `listEffectsForRun()` | `packages/kernel` repository | 读 `commander_effects` |
| `GET /v1/runs/{runId}/evidence` | — | **v0 未接**（nice-to-have） |

输入源：

1. `KernelRun`（intent/workGraph/policySnapshot）
2. `KernelEffect[]`（ledger）
3. `AuditSink` 事件（run 范围，可选）
4. `CapabilityGrant` 摘要（jti/requestHash/policySnapshotId，**不含**私钥或完整 token）
5. `approvalInteractionId`（来自 admit 拒绝路径或 interaction 表，可选）

---

## 4. DLP 排除表（默认）

以下键名在导出时**整键删除**（大小写不敏感，递归）：

| 键模式 | 理由 |
|--------|------|
| `gen_ai.prompt`, `gen_ai.completion`, `gen_ai.tool.call.arguments` | OTel / DLP 默认剥离 |
| `prompt`, `messages`, `chainOfThought`, `chain_of_thought`, `reasoning`, `thinking` | CoT / 原始 LLM 载荷 |
| `completion`, `rawPrompt`, `rawCompletion` | 原始模型 I/O |

保留：`contentHash`、`requestHash`、`policyDecisionId`、effect state、非敏感 response 元数据（status、httpStatus、bytes 等）。

---

## 5. 完整性校验

`verifyEvidenceBundle(bundle)` 必须验证：

1. 每条 `effects[]` / `auditEvents[]` 的 `entryHash` 与 canonical 重算一致。
2. `prevEntryHash` 链连续（首条 = GENESIS）。
3. 根 `contentHash` 与 body 重算一致。
4. 递归扫描不含 §4 禁止键。

篡改任一 effect 字段或删除 audit 行 → `verifyEvidenceBundle` 返回 `{ ok: false, reason: ... }`。

---

## 6. 验收清单

| # | 项 | 状态 | 证据 |
|---|-----|------|------|
| 1 | 库函数导出 run/effect bundle，含 identity + policy + effect + versions | ENFORCED | `evidenceBundle.test.ts` |
| 2 | 默认排除 CoT / gen_ai prompt 字段 | ENFORCED | `evidenceBundle.test.ts` DLP 用例 |
| 3 | `verifyEvidenceBundle` 检测 contentHash / entry 链篡改 | ENFORCED | `evidenceBundle.test.ts` tamper 用例 |
| 4 | Kernel `listEffectsForRun` 读 ledger | ENFORCED | `kernel.test.ts` inMemory 作用域用例；接口 + Postgres 实现存在（无 live DB 测） |
| 5 | Gateway HTTP `GET /v1/runs/:runId/evidence` | ENFORCED | `v1GatewayEndpoints.ts` + `apps/api/test/v1RunEvidence.test.ts`（L3 Wave closeout 2026-07-19） |
| 6 | WORM / KMS 外部锚定 | PARTIAL | 对齐 WS9 §6 远期项；**不在** L3-11 v0 |

**Phase 3 诚实结论（2026-07-19）：** 包级导出/校验 + Gateway HTTP 面 **ENFORCED**；WORM/SIEM 锚定仍 **PARTIAL / 非范围**。

---

## 7. 测试计划

```bash
pnpm --workspace-root exec tsx --test \
  packages/effect-broker/src/evidenceBundle.test.ts \
  packages/kernel/src/kernel.test.ts
```

覆盖：happy path、DLP 剥离、entry 链、contentHash 篡改、字段篡改/audit 删除、缺 approval 字段可选、`listEffectsForRun` 租户/run 作用域。
