# L3-03a：Effect 垄断（tool / connector 全路径）

**状态：DONE**
**范围：Phase 1 Spec → Phase 2 Build → Phase 3 Review & Audit**
**分支：** `feat/l3-03a-effect-monopoly`（base `master` @ a9d2cf9a）

## 0. Done when（来自分层计划）

| 条目 | 含义 |
|------|------|
| D1 | 主 **tool** / **connector** 路径仅经 `EffectBroker.admit()` → `executeAdmitted()`（或等价 `execute()`） |
| D2 | tools/connectors **deny-default**；`llm.*` 保持 allowlisted（不回归） |
| D3 | quota / allowlist 在 `admit()` **ENFORCED**（非仅 EXISTS） |
| D4 | 生产无 `permit-all` / `permit-default` / `COMMANDER_WORKER_EFFECT_POLICY=permit` 旁路 |
| D5 | 测试证明 fail-closed 旁路尝试失败 |
| D6 | `spec/ws2-effect-monopoly.md` §1 tool 路径状态诚实更新 |

## 1. 当前差距（Phase 1 审计）

| Done when | 现状 | 差距 |
|-----------|------|------|
| D1 | `hasExternalEffects: true` 时走 broker；否则直接 registry handler | 生产可省略 `hasExternalEffects` 绕过 broker |
| D2 | `createWorkerPolicyEvaluator()` deny-default 非 llm | **无差距**（policy 层） |
| D3 | `EffectBroker.admit()` 已调 `isActionAllowed` / `incrementQuota` | worker tool 路径缺 **端到端 ENFORCED** 验收 |
| D4 | bootstrap 忽略 `COMMANDER_WORKER_EFFECT_POLICY=permit` | **无差距** |
| D5 | m3 有 broker 路由单测；无 prod fail-closed 旁路套 | 需 L3-03a 专用集成测 |
| D6 | ws2 §1 tool 标 PARTIAL | 需实施后更新 |

**静态扫描（executors）：** `toolStepExecutor.ts` / `connectorStepExecutor.ts` grep `fetch|execSync|spawn|child_process` → **0 命中**（无直接外部 IO）。

## 2. 非目标

- 不扩展 LLM provider / topology / memory / console
- 不改 Gateway API 发 token 流程（worker 仍消费 step input 中的 capability 字段）
- 不删除 dev 下 `localOnly` 工具的 registry 直调（仅生产 fail-closed）
- 不 push / 不 merge master
- L3-03b 跟进项：Gateway 侧 tool catalog 强制 `hasExternalEffects` 与 token 颁发

## 3. 具体文件变更

| 文件 | 变更 |
|------|------|
| `packages/worker-plane/src/effectGate.ts` | **新增** — 共享 prod gate + 路由判定 |
| `packages/worker-plane/src/toolStepExecutor.ts` | prod 拒无 broker；prod 默认 broker 路径；`localOnly` 豁免 |
| `packages/worker-plane/src/connectorStepExecutor.ts` | 同上 |
| `packages/worker-plane/src/workerRuntimeAdapter.ts` | 复用 `effectGate`（DRY） |
| `packages/worker-plane/src/l3-03a-effect-tool-monopoly.test.ts` | **新增** — fail-closed + ENFORCED 验收 |
| `spec/l3-03a-effect-tool-monopoly.md` | 本文件 |
| `spec/ws2-effect-monopoly.md` | §1 tool 路径证据更新 |
| `.internal/docs/status/2026-07-17-l3bc-loop-state.md` | L3-03a DONE + SHAs |

## 4. 验收测试

1. **Prod 构造**：`NODE_ENV=production` 且无 broker → `ToolStepExecutor` / `ConnectorStepExecutor` 构造抛 `EFFECT_BROKER_UNAVAILABLE`
2. **Prod 旁路**：`http.post` 无 `hasExternalEffects` → 走 broker 路径；handler 未调用
3. **Prod localOnly**：`localOnly: true` 的 echo 工具可走 registry（内部工具）
4. **Policy deny-default**：bootstrap policy + 真实 broker → `crm.write` → `POLICY_DENIED`
5. **Allowlist ENFORCED**：InMemoryKernel 无 allowlist → `http.post` → `ACTION_NOT_ALLOWLISTED`
6. **Permit bypass**：`COMMANDER_WORKER_EFFECT_POLICY=permit` 仍 deny 非 llm
7. **Connector 对称**：同上 broker 路由 + prod gate
8. **静态**：executors 无 direct fetch/exec

## 5. 风险

| 风险 | 缓解 |
|------|------|
| 生产 echo 等内部工具需 `localOnly: true` | spec 文档化；测试覆盖 |
| step input 伪造 `localOnly` | Gateway/kernel 未来校验（L3-03b）；当前 worker fail-closed 默认 broker |
| `execute()` 合并 admit+execute 非显式两调用 | WS2 已接受；broker 内部仍 admit→executeAdmitted |

## 6. Spec audit

**Verdict: APPROVE**

- 差距聚焦 prod bypass + ENFORCED 证据，无 scope creep
- `localOnly` 最小豁免保留 dev/内部工具，生产默认 broker 符合 fail-closed
- 不碰 llm.* allowlist（明确 non-goal）
- 文件列表与 L3-02 spec 格式一致

**Phase 3 代码审计（2026-07-17）**

- P1/P2：无
- P3 residual：
  - Gateway 侧 tool catalog 未强制 `hasExternalEffects` / token 颁发（L3-03b）
  - `localOnly` 由 step input 声明，Gateway 未校验（L3-03b）
  - dev/test 仍允许无 broker 的 registry 直调（非 prod gate）

**最终状态：DONE（worker tool/connector 主路径 ENFORCED）**

| Done when | 证据标签 | 证据 |
|-----------|----------|------|
| D1 | **ENFORCED** | `effectGate.ts` + prod 默认 broker 路由；`l3-03a` 测试 2/7b |
| D2 | **ENFORCED** | `bootstrap.policy.test.ts` + l3-03a 测试 4/6 |
| D3 | **ENFORCED** | l3-03a 测试 5（ACTION_NOT_ALLOWLISTED）；ws2-acceptance §5 回归 |
| D4 | **ENFORCED** | l3-03a 测试 6；ws2-acceptance §4 permit-default |
| D5 | **PROVEN** | `l3-03a-effect-tool-monopoly.test.ts` 12/12 |
| D6 | **WIRED** | 本 spec + `ws2-effect-monopoly.md` §1 更新 |
