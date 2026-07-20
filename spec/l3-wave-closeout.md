# L3 Wave：Authority Closeout（单一 Wave 程序规格）

**状态：CLOSED（2026-07-19；Review fix 后 CLI 仅 env Gateway 键 + pretest/测加固；未 merge master）**  
**日期：** 2026-07-19  
**分支 / worktree：** `feat/l3-wave` @ `.worktrees/l3-wave`（base `master` @ `49d920a8`）  
**并行约束：** L4-A / L4-B（含 L4-02/05/07/08）由**另一条工作流**独占；本 wave **禁止**修改 Action Gateway、`/v1/actions`、L4 demo、Cell 拓扑或宪法删除日。  
**合并门禁：** 触及 `apps/api/src/v1GatewayEndpoints.ts` 时须相对 `feat/l4-b` rebase/协调；禁止静默覆盖 `/v1/actions` 挂载。

**流程（强制）：** Spec → Review → Implement → Audit（有瑕疵则 Fix → 再 Audit）  
**隔离（强制）：** 本 wave 全程在独立 worktree；不在 `feat/l4-b` / `feat/l4-a-product-wedge` 上施工。

### Review 锁定决策（Implement 不得再改口）

| 决策点 | 锁定 |
|--------|------|
| Phase B 形态 | **方案 A（最小列表）**：新增 `GET /v1/runs`（tenant 作用域、limit 默认 50、max 200）+ kernel `listRuns` + CLI `commander history` 在 API 模式下调用该列表 |
| Phase B 命令 | **复用** `commander history`（不新增 `runs get` 作为主路径） |
| Enterprise / API 模式触发 | **仅** `process.env.COMMANDER_API_URL`（trim 非空）→ API 模式；凭证 **仅** `COMMANDER_API_KEY`。禁止复用 LLM file-config `apiBase`/`apiKey`（`configInjection` 测试键） |
| Phase C | **C-doc**：不实现 Gateway HTTP catalog；`spec/l3-03b` + 分层表标 `KNOWN LIMITATION`；follow-up ID = **`L3-03b-http`** |
| Phase A 状态升级 | `spec/l3-11` 仅升「HTTP 面 ENFORCED」；WORM/SIEM 仍非目标 |

---

## 0. 一句话目标

把 **L3 权威主链**从「多数已合入但若干 PARTIAL」收敛到可对外诚实宣称的 **ENFORCED / PROVEN**，并与分层表、loop-state、单条 `spec/l3-*.md` 对齐；**不**吞并 L4。

---

## 1. 背景：master 已具备什么（不要重做）

一手来源：`.internal/docs/status/2026-07-17-l3bc-loop-state.md`（master tip `49d920a8`）。

| ID | Master 状态 | 说明 |
|----|-------------|------|
| L3-01 | DONE（可执行子集） | V1 barrel / 命名仍 PARTIAL — **本 wave 不扩 scope 清整包债务** |
| L3-02 | DONE | ops /ready + loops |
| L3-03a | DONE | effectGate monopoly |
| L3-03b | DONE（worker catalog） | **Gateway HTTP catalog sync 仍 PARTIAL** → Phase C |
| L3-04b | DONE | C-α / multi-isolate 已合 |
| L3-05 | PARTIAL | `/v1` kernel-only + WarRoom 降级已 ENFORCED；**CLI ≡ `/v1` history 未闭合** → Phase B |
| L3-06 | DONE | enterprise `/v1` only freeze |
| L3-07 | PARTIAL | step 身份 + admit 绑定 ENFORCED；**OIDC/mTLS 全链路不在本 wave** |
| L3-08a | ENFORCED（包级） | UNKNOWN reconcile + ticket chaos |
| L3-09 | OPEN / 后置 | Runtime 抽包 — **明确排除** |
| L3-10a | PARTIAL→产品路径 ENFORCED | 不再扩 memory 算法；仅要求状态文档诚实 |
| L3-11 | PARTIAL | 库级 bundle + verify 已有；**master 无 Gateway `/v1` evidence HTTP** → Phase A |
| L3-12a | PARTIAL | harness ENFORCED；live PASS 依赖 runsc — **本 wave 不强制 live 环境** |

分层表 `2026-07-17-l3-l4-stratified.md` 中大量 `OPEN` **已过时**；本 wave 结束时必须回写该表与 loop-state。

---

## 2. 本 Wave 范围（In Scope）

### Phase A — L3-11 Gateway Evidence HTTP（I1）

**Done when**

| # | 标准 |
|---|------|
| A1 | `GET /v1/runs/:runId/evidence`（租户绑定）返回可 `verifyEvidenceBundle` 的 bundle |
| A2 | 默认 DLP：无 CoT / prompt / tool args / Authorization 明文（与 `evidenceBundle.ts` 一致） |
| A3 | 无 kernel / 跨租户 → 503 / 404 fail-closed |
| A4 | 新增显式测试文件 `apps/api/test/v1RunEvidence.test.ts`（≥3 cases）PROVEN；`spec/l3-11-evidence-bundle.md` 状态头改为「HTTP 面 ENFORCED；WORM/SIEM 仍非范围」 |

**非目标：** WORM/SIEM 锚定；`/v1/actions/:id/evidence`（属 L4-A 流）。

**主要文件（预期）**

- `apps/api/src/v1GatewayEndpoints.ts`
- `apps/api/src/v1GatewayKernel.ts`（暴露 `listEffects` / `listEvents` 等聚合所需能力）
- `apps/api/test/v1RunEvidence.test.ts`（**新建**）
- `packages/effect-broker/src/evidenceBundle.ts`（仅复用，不改契约语义）

### Phase B — L3-05 CLI ≡ `/v1` History（I1 收口）

**Done when**

| # | 标准 |
|---|------|
| B1 | 新增 `GET /v1/runs?limit=`（tenant 作用域；默认 limit=50，clamp 1..200；按 `updatedAt` desc） |
| B2 | Kernel repository 新增 `listRuns(tenantId, { limit })`（Postgres + in-memory 一致）；Gateway 响应字段名 **`state`**，值为 `@commander/contracts` `RunState` |
| B3 | API 模式（**仅** `COMMANDER_API_URL` 非空）下 `commander history` 调用该列表并打印；字段与 contracts 对齐；LLM `apiBase`/`apiKey` 不得触发 API 模式 |
| B4 | Local SKU（上述均空）保持 `StateCheckpointer` 路径，help/输出含「非 durable `/v1` 权威」 |
| B5 | 测试：`apps/api/test/v1ListRuns.test.ts` + `packages/core/tests/cli/history.v1.test.ts`（mock gateway） |
| B6 | 更新 `spec/l3-05-one-run-authority.md` §4 → ENFORCED（enterprise/API 列表路径） |

**非目标：** 删除 ATR RunLedger / WarRoom；不强迫 local SKU 改走 Postgres；不做复杂过滤/分页 cursor（v0 仅 limit）。

**主要文件（预期）**

- `packages/kernel/src/{repository,postgres,testing/inMemoryRepository,types}.ts`
- `apps/api/src/v1GatewayKernel.ts`、`v1GatewayEndpoints.ts`
- `packages/sdk/src/v1/client.ts`（可选 `listRuns`；若 CLI 直 fetch 可省略 SDK，但须在回报中说明）
- `packages/core/src/cli/commands/history.ts`、help 文案
- `apps/api/test/v1ListRuns.test.ts`、`packages/core/tests/cli/history.v1.test.ts`

### Phase C — L3-03b residual（**锁定 C-doc**）

**Done when**

| # | 标准 |
|---|------|
| C1 | `spec/l3-03b-gateway-localonly.md` 增加 **KNOWN LIMITATION：无 Gateway HTTP catalog sync**；follow-up **`L3-03b-http`** |
| C2 | 分层表 L3-03b 行标注 worker catalog ENFORCED + HTTP sync OPEN（`L3-03b-http`） |
| C3 | **不**新增 `GET /v1/tools/effect-catalog`（本 wave） |

### Phase D — 状态面诚实化（必须）

| # | 标准 |
|---|------|
| D1 | 更新 `2026-07-17-l3-l4-stratified.md` L3 行：DONE / ENFORCED / PARTIAL 与证据一致 |
| D2 | 更新 `2026-07-17-l3bc-loop-state.md`：本 wave SHA、各 Phase 结果 |
| D3 | 各 `spec/l3-*.md` 状态头与代码一致；禁止「代码 PARTIAL、表 OPEN」漂移 |

---

## 3. 明确排除（Out of Scope）

| 项 | 原因 |
|----|------|
| L4-01 / 03 / 04 / 06 | 另一流 Wave 0（L4-A 基线） |
| L4-02 / 05 / 07 / 08 | 另一流 Wave 1–4 |
| L3-09 Runtime 抽包 | I3，易爆，后置 |
| L3-07 OIDC/mTLS 全链路 | 超出 step-identity ENFORCED；单独立项 |
| L3-12a live PASS 强制 | 依赖宿主机 runsc/docker；harness 已 ENFORCED 即可 |
| `arch:guard` worker→core 历史债 | 属 L3-09 周边；本 wave 不强制清 |

---

## 4. 安全与架构不变量

1. Tenant 身份只来自认证主体；证据与 history 不得信 ambient `X-Tenant-ID` 作授权。
2. Evidence fail-closed DLP（CLAUDE.md §5）。
3. 生产 Effect 路径保持 deny-default / catalog-authoritative `localOnly`（不回归 L3-03a/b）。
4. 企业 profile 下不得复活 legacy 执行为第二 run 权威（L3-05/06）。
5. 测试串行：vitest `threads: false` / `fileParallelism: false`（仓库惯例）。

---

## 5. 实施顺序与门禁

```
Review 通过本 spec
  → Phase A（evidence HTTP）红→绿→自审
  → Phase B（CLI history + GET /v1/runs）红→绿→自审
  → Phase C（C-doc：spec/分层表 KNOWN LIMITATION + L3-03b-http）
  → Phase D（文档对齐）
  → 外部 Audit subagent（只读）
  → 若有 Critical/Important → Fix → 再 Audit
  → Wave 宣布 CLOSED（无 Critical/Important）
```

**CLI 子命令边界（Phase B）：** API 模式下仅默认列表（无子命令 / `list`）走 `GET /v1/runs`；`history view|delete|prune` **保持 local StateCheckpointer**（或显式报错「API 模式不支持」——Implement 选其一并测）。

**合并策略：** 默认不 push / 不 merge master，除非用户明确授权。完成后提供 PR 或本地 merge 选项。

---

## 6. 验收命令（Wave 级）

```bash
# Phase A
pnpm --workspace-root exec tsx --test apps/api/test/*evidence* \
  apps/api/test/v1GatewayEndpoints.test.ts

# Phase B
pnpm --filter @commander/core exec vitest run tests/cli/*history* --reporter=default

# Phase C（C-doc：无新代码门；核对 spec/分层表 diff）

# 回归锚点（不扩大为全仓）
pnpm --filter @commander/effect-broker test
pnpm --filter @commander/kernel test
pnpm contract:check
```

每条 Phase 回报格式：路径、命令、EXISTS/WIRED/ENFORCED/PROVEN、是否改默认路径。

---

## 7. 风险

| 风险 | 缓解 |
|------|------|
| 与 L4-B Wave0 抢 `apps/api` | 本 wave 只加 `GET /v1/runs` 列表与 `/v1/runs/:id/evidence`；不碰 `/v1/actions`；C-doc 无 catalog 路由 |
| CLI 破坏 local SKU | 双路径 + 显式标注 |
| 文档再次漂移 | Phase D 强制；Audit 检查分层表 |
| Scope creep 进 L4 | Out of Scope 表 + Review 否决权 |

---

## 8. Review 检查清单（给 Reviewer）

- [ ] 范围是否真排除 L4？
- [ ] Phase A/B/C Done when 是否可测、无歧义？
- [ ] C-full vs C-doc 是否需要现在锁定？
- [ ] 是否误把已 DONE 的 L3-02/03a/06 等列为重做？
- [ ] 验收命令是否可在无 runsc / 无 PG live 下跑通？

---

## 9. 修订记录

| 日期 | 变更 |
|------|------|
| 2026-07-19 | 初版：将「整包重做 L3」改为基于 master 已合入现实的 **Closeout Wave**；与 L4-B 流分轨 |
| 2026-07-19 | Review REQUEST_CHANGES → 锁定 Phase B 方案 A（最小 `GET /v1/runs`）、API 触发键、Phase C=C-doc；补 kernel wiring 与显式测文件 |
| 2026-07-19 | Implement 完成：Phase A/B/C/D；验收 §6 全绿（worktree 未 push） |
| 2026-07-19 | 终审 CLEAN：恢复丢失的 Gateway 路由；CLI 错误路径；events/evidence DLP e2e；limit 边界；l3-05 §2 表诚实化 |
| 2026-07-19 | Review fix：CLI 仅认 `COMMANDER_API_URL`/`COMMANDER_API_KEY`；api pretest build effect-broker；listRuns 排序/default-50 测加固 |
