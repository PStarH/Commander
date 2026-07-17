# L3-03b：Gateway / localOnly catalog authority

**状态：DONE**
**范围：Phase 1 Spec → Phase 2 Build → Phase 3 Review & Audit**
**分支：** `feat/l3-03b-gateway-localonly`（base `master` @ 869a7a70，L3-03a 已合）

## 0. Done when（来自 L3-03a review residual）

| 条目 | 含义 |
|------|------|
| D1 | Worker 校验 `localOnly` 须对照 **ToolEffectCatalog**（或 Gateway claim），不能仅信 step input |
| D2 | 生产伪造 `localOnly: true` 于外部工具 → 仍走 broker 或拒绝 |
| D3 | 生产 connector `connection` + `localOnly` 不可直调 registry（fail-closed） |
| D4 | 测试证明 bypass 关闭 |
| D5 | 本 spec + loop state 更新 |
| D6 | 诚实 ENFORCED / PARTIAL 标注 |

## 1. 当前差距（Phase 1 审计）

| Done when | 现状（L3-03a 后） | 差距 |
|-----------|-------------------|------|
| D1 | `mustRouteExternalEffectThroughBroker` 见 `localOnly: true` 即豁免 | 无 catalog 校验 |
| D2 | prod 默认 broker，但 forged localOnly 可绕过 | 需 catalog gate |
| D3 | connector 可 `localOnly` + `connection` 直调 registry | 生产须拒或强制 broker |
| D4 | l3-03a 12/12 无 forged-localOnly 套 | 需 l3-03b 专用测 |
| D5 | — | 本文件 |
| D6 | — | Gateway HTTP catalog 可 PARTIAL |

**静态扫描：** `effectGate.ts` 第 39 行 `if (input.localOnly === true) return false` — 纯 step-input 信任。

## 2. 非目标

- 不实现完整 Gateway HTTP tool-catalog 同步（v0 用 package 级 `MapToolEffectCatalog` + bootstrap 注入）
- 不改 LLM / kernel admit 流程
- 不 push / 不 merge master
- 不删除 dev 下无 catalog 的 registry 直调（仅 prod fail-closed）

## 3. 具体文件变更

| 文件 | 变更 |
|------|------|
| `packages/worker-plane/src/toolEffectCatalog.ts` | **新增** — `ToolEffectCatalog` 接口 + `MapToolEffectCatalog` + 默认 allowlist |
| `packages/worker-plane/src/effectGate.ts` | catalog-authoritative `localOnly`；prod `connection` 禁 bypass |
| `packages/worker-plane/src/toolStepExecutor.ts` | 注入 catalog；路由传 `toolName` |
| `packages/worker-plane/src/connectorStepExecutor.ts` | 注入 catalog；路由传 `connectorName` + `hasConnection` |
| `packages/worker-plane/src/bootstrap.ts` | prod bootstrap 注入 `createDefaultWorkerToolEffectCatalog()` |
| `packages/worker-plane/src/l3-03b-gateway-localonly.test.ts` | **新增** — forged localOnly + connection gate |
| `packages/worker-plane/src/l3-03a-effect-tool-monopoly.test.ts` | prod localOnly 测补 catalog |
| `spec/l3-03b-gateway-localonly.md` | 本文件 |
| `.internal/docs/status/2026-07-17-l3a-loop-state.md` | L3-03b DONE + SHAs |

## 4. 验收测试

1. **Forged tool localOnly**：prod + `http.post` + `localOnly: true` + 无 catalog 条目 → broker 路径；handler 未调用
2. **Catalog-authorized**：prod + `echo` + catalog 含 echo + `localOnly: true` → registry
3. **Forged connector localOnly**：prod + `postgres` + `localOnly: true` + 无 catalog → broker
4. **Connector connection gate**：prod + catalog `memory` + `localOnly` + `connection` → broker 或 `LOCALONLY_CONNECTION_FORBIDDEN`
5. **Dev 不变**：非 prod gate + `localOnly: true` 无 catalog 仍可 registry（L3-03a 兼容）
6. **Deny-all catalog default**：executor 无 catalog 注入 → prod 等同 `DENY_ALL`

## 5. 风险

| 风险 | 缓解 |
|------|------|
| bootstrap 默认 catalog 与 Gateway 漂移 | v0 文档化；L3-03b 标 Gateway HTTP 为 PARTIAL |
| 现有 prod echo 需 catalog 条目 | `createDefaultWorkerToolEffectCatalog()` 含 echo/memory |
| l3-03a 测试 3/7c 需补 catalog | 同 PR 更新 |

## 6. Spec audit

**Verdict: APPROVE**

- 聚焦 L3-03a residual（step-input localOnly 信任），无 scope creep
- package 级 catalog 足够 v0；Gateway HTTP 诚实标 PARTIAL
- prod fail-closed + dev 兼容明确
- 文件列表与 L3-03a 格式一致

## 7. ENFORCED / PARTIAL（Phase 3 代码审计 2026-07-17）

| Done when | 标签 | 证据 |
|-----------|------|------|
| D1 | **ENFORCED** | `toolEffectCatalog.ts` + `isCatalogAuthorizedLocalOnly()`；prod 须 catalog 条目 |
| D2 | **ENFORCED** | `l3-03b` 测试 1/2/4 — forged localOnly → broker |
| D3 | **ENFORCED** | `effectGate` `hasConnection` + l3-03b 测试 5/6 |
| D4 | **PROVEN** | `l3-03b-gateway-localonly.test.ts` 9/9；l3-03a 回归 12/12 |
| D5 | **WIRED** | 本 spec + loop state |
| D6 | 见下 | |

**Gateway HTTP catalog 同步：PARTIAL** — v0 用 worker bootstrap `MapToolEffectCatalog`（echo/memory）；无 Gateway HTTP 拉取或 claim 校验。

**Phase 3 代码审计**

- P1/P2：无
- P3 residual：Gateway 侧 step 编排仍可能下发未 catalog 校验的 `localOnly` claim（worker 已 fail-closed 拒 bypass）；HTTP catalog 同步待 follow-up

**最终状态：DONE（worker catalog-authoritative localOnly ENFORCED）**
