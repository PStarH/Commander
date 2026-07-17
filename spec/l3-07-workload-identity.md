# L3-07：Workload Identity 短生命周期

**状态：PARTIAL（step 粒度身份 + admit 绑定 ENFORCED；OIDC/mTLS 全链路 PARTIAL）**  
**范围：Phase 1 Spec → Phase 2 Build → Phase 3 Review & Audit**

## 0. 依据

- ADR 004（`docs/architecture/004-identity-and-capability.md`）：tenant 必须来自已验证身份 claim，不信 ambient header/env。
- WS2 Effect 垄断（`spec/ws2-effect-monopoly.md`）：`EffectBroker.admit()` 以 `CapabilityGrant.tenantId` 为权威；本任务确保 mint 路径绑定 step/run 身份，禁止 ambient override。
- `packages/contracts/src/controlPlane.ts`：`WorkloadIdentity` 契约。
- `packages/worker-plane`：`WorkerIdentity` 为 worker 注册级 API key 风格；**不替换**，在其上叠加 **step-scoped** 短生命周期身份。

## 1. 安全不变量

1. 每个被 kernel claim 的 step 执行前，控制平面（或 worker 内嵌 ControlPlane）签发 **step-scoped WorkloadIdentity**（含 `tenantId`、`runId`、`stepId`、`expiresAt`）。
2. Capability token 的 `tenantId` / `runId` / `stepId`（及可选 `workloadId`）**必须**从该身份派生；mint 函数不得接受 caller 提供的 tenant override。
3. `EffectBroker.admit()` 在 production/enterprise profile 下 **必须**收到 `workloadBinding`（step 三元组）；缺失 → `WORKLOAD_BINDING_REQUIRED`。
4. grant 与 binding 不一致 → `TENANT_MISMATCH` / `RUN_MISMATCH` / `STEP_MISMATCH` / `WORKLOAD_MISMATCH`。
5. 过期或缺失 step 身份 → effect 路径 fail-closed（mint 前或 admit 前拒绝）。

**不在本切片范围（诚实 PARTIAL）：**

- 完整 OIDC IdP / SPIFFE mTLS 联邦
- Gateway/API 路径 tenant 从 JWT 派生（L3-06）
- 跨 worker 进程共享 identity store（当前 ControlPlane 为进程内 Map）
- Tool/connector step input 中遗留 `capabilityToken` 在 dev/test 仍可传入；production 强制 worker 侧 mint

## 2. 架构（step 粒度）

```text
Kernel claim step (authoritative tenantId)
        │
        ▼
WorkerService.execute()
  └─ runWithStepWorkloadIdentity(step)
       ├─ ControlPlane.issueStepIdentity({ tenantId, runId, stepId })
       └─ ALS: StepWorkloadContext { identity, binding }
                │
    ┌───────────┼───────────┐
    ▼           ▼           ▼
 Agent/LLM   Tool/Conn   (future)
 mint via    mint via
 step ctx    step ctx
    │           │
    └─────┬─────┘
          ▼
 EffectBroker.admit({ token, workloadBinding })
   verify grant ≡ binding (prod required)
          ▼
 kernel.admitEffect(tenantId = grant.tenantId)
```

## 3. 契约扩展

### 3.1 WorkloadIdentity（contracts）

新增可选字段：`runId?`, `stepId?`（step-scoped 身份必填）。

### 3.2 CapabilityGrant（effect-broker）

新增可选字段：`workloadId?`（链接 step 身份）。

### 3.3 WorkloadBinding（effect-broker admit 输入）

```typescript
interface WorkloadBinding {
  tenantId: string;
  runId: string;
  stepId: string;
  workloadId?: string;
}
```

## 4. 实现切片

| 组件 | 变更 |
|------|------|
| `packages/core/src/controlPlane` | `issueStepIdentity`, `verifyIdentityByToken`, 按 token 索引 + TTL 过期剔除 |
| `packages/effect-broker` | admit/execute 接受 `workloadBinding`；prod 必填；不一致拒绝 |
| `packages/worker-plane/stepWorkloadIdentity.ts` | ALS + issue + `mintStepCapabilityToken` |
| `packages/worker-plane/workerService.ts` | 每 step 包裹 `runWithStepWorkloadIdentity` |
| `packages/worker-plane/llmBrokerBridge.ts` | broker.execute 传 binding；mint 含 workloadId |
| `packages/worker-plane/toolStepExecutor.ts` | prod 路径 worker 侧 mint + binding |
| `packages/worker-plane/connectorStepExecutor.ts` | 同上 |
| `packages/worker-plane/bootstrap.ts` | tool/connector 注入 capabilityIssuer |

## 5. 验收测试

- `packages/effect-broker/src/l3-07-acceptance.test.ts`：missing binding (prod)、tenant/run/step mismatch、expired token
- `packages/worker-plane/src/stepWorkloadIdentity.test.ts`：issue、ALS、mint 拒绝 tenant override
- `packages/core/tests/controlPlane/workloadIdentity.test.ts`：issue/verify/expiry

## 6. EXISTS / WIRED / ENFORCED / PROVEN 矩阵

| 能力 | EXISTS | WIRED | ENFORCED | PROVEN |
|------|--------|-------|----------|--------|
| WorkloadIdentity 契约 | ✅ contracts | ✅ core export | — | ✅ contract test |
| Step 身份签发 | ✅ ControlPlane.issueStepIdentity | ✅ WorkerService ALS | ✅ 每 step 包裹 | ✅ core test |
| Mint tenant 来自身份 | ✅ mintStepCapabilityToken | ✅ LLM + tool/conn prod | ✅ 无 override 参数 | ✅ worker test |
| Admit binding 校验 | ✅ EffectBroker | ✅ worker execute 传 binding | ✅ prod 必填 | ✅ l3-07 test |
| 过期/缺失拒 effect | ✅ verify + mint 检查 | ✅ admit/mint | ✅ fail-closed | ✅ tests |
| OIDC/SPIFFE worker 认证 | ⚠️ WorkerIdentity API key | ⚠️ bootstrap | ❌ | ❌ |
| 跨进程 identity 权威 | ❌ in-memory only | — | — | — |
| Gateway JWT tenant | ⚠️ jwtMiddleware 部分 | ⚠️ | ❌ prod ambient | ❌ |

## 7. Phase 3 Audit（spec）

| ID | 严重度 | 发现 | 处置 |
|----|--------|------|------|
| A1 | P2 | ControlPlane identity store 进程内，重启丢失 | 文档标注 PARTIAL；L3-06/持久化 follow-up |
| A2 | P2 | Tool step input 仍含 capabilityToken 字段（dev 兼容） | prod 强制 issuer mint；spec §1 诚实标注 |
| A3 | P3 | workloadId 未进 kernel ledger | 可选 follow-up；binding 三元组已够 ENFORCED 切片 |
| — | — | 无 P0/P1 阻塞合并 | — |

**Audit verdict:** Spec ACCEPTED for ENFORCED subset; full OIDC explicitly deferred.

## 8. Phase 3 Code Audit（post-build）

| ID | 严重度 | 发现 | 处置 |
|----|--------|------|------|
| C1 | — | `EffectBroker.admit()` prod 门禁 + binding 三元组校验已实现 | ✅ |
| C2 | — | `WorkerService.execute` 每 step 包裹 `runWithStepWorkloadIdentity` | ✅ |
| C3 | — | LLM/tool/connector mint 路径使用 `mintStepCapabilityToken` / ALS tenant | ✅ |
| C4 | P2 | dev/test 无 binding 仍可 admit（非 prod profile） | 符合 spec §1 诚实边界 |
| C5 | P2 | ControlPlane identity 进程内 Map | 同 A1，follow-up |

**Code audit verdict:** No P0/P1. ENFORCED subset merge-ready.
