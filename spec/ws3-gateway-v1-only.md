# WS3：冻结企业 API 表面为 /v1，强制租户身份与 OpenAPI 真实性

**状态：ACCEPTED（Phase 3 验收通过，2026-07-16）**
**范围：Phase 1 Spec → Phase 2 Build → Phase 3 Review & Audit**
**关联工作流：WS0/WS1（架构基线）、WS7（沙箱 fail-closed）、WS8（CLI 表面）**
**验收证据：85/85 测试通过（8 个测试文件，22 个 suite）**

---

## 1. 依据与问题定义

### 1.1 架构评审 Final Verdict（绑定约束）

本任务的上游裁决来自 `docs/architecture/000-index.md`（ADR 索引）的 **Feature Freeze Rules**，以及 `docs/runbooks/architecture-v2-gateway.md`、`docs/v2-migration-guide.md`：

- ADR 000 §Feature Freeze Rules 第 1 条：**"No new endpoint families in `apps/api` except `/v1/*` replacements."**
- ADR 000 §Feature Freeze Rules 第 5 条：**"All new public types must be defined in `packages/contracts` first."**
- `docs/runbooks/architecture-v2-gateway.md` §Rule：**"Production and enterprise deployments expose **only** `apps/api`."** 且 `/v1/runs` 是 Architecture V2 的提交表面，禁止回退到 `/api/runtime/execute`、`AgentRuntimeRegistry`、`WarRoomStore` 或 pod-local store。
- `docs/v2-migration-guide.md` §Dual path：WarRoom missions/UI logs 已被标记为 **"Demoted; not the durable run authority."**

WS3 的安全不变量是：**企业部署下，`/v1` 是唯一的企业产品入口；任何 `/v1` 以外的产品路由在企业 profile 下被拒绝（410 Gone）或降级为只读运维面板；租户身份由网关在 JWT 层强制解析并 fail-closed；对外 OpenAPI 文档与实际路由处理代码同源生成，不得手写漂移。**

### 1.2 现状缺口（一手证据）

| 缺口 | 证据 |
|---|---|
| `/v1` 仅暴露 `/runs` 子资源，企业功能（projects/memory/governance/quality/eval/observability 等）散落在 `/`、`/api`、`/api/v1`、`/api/v1/observability` 等多前缀 | `apps/api/src/index.ts:495-748`（routerRegistry manifest，约 40 个路由分属 7 种 mountPath） |
| OpenAPI 规范手写维护且与路由代码分离，存在两份手写副本且互不同步 | `apps/api/src/openApiSpec.ts`（未被挂载）+ `apps/api/src/index.ts:751-1043`（`/api/openapi.json` 内联手写，仅覆盖 ~30 条路径，与 manifest 的 ~40 条路由不一致） |
| JWT 中间件不携带 `tenant_id`/`scopes` claims，且验证失败时**放行**（`req.user=null` 后 next），fail-open | `apps/api/src/jwtMiddleware.ts:156-191`（"this middleware never blocks"） |
| 租户身份来自 API key 绑定（`authMiddleware`）或非生产下的 `X-Tenant-ID` 头；JWT 用户无租户绑定 | `apps/api/src/authMiddleware.ts:311-317`、`apps/api/src/tenantContextMiddleware.ts:69-83` |
| `/ready` 健康检查只判断 store 单例是否非 null，不探测 DB/Kernel/EffectBroker 真实可达性，存在"虚假 READY" | `apps/api/src/index.ts:350-366`（`warRoom: store ? 'ok' : 'fail'`） |
| WarRoom 仍具备状态变更能力：创建/更新 mission、审批放行、写日志 | `apps/api/src/projectEndpoints.ts:266-445`（POST `/projects/:id/missions`、PATCH `/missions/:id`、POST `/missions/:id/approve`、POST `/missions/:id/logs`） |
| 无"企业 profile"概念；生产判定分散在 `isProductionEnv()` 与各 `COMMANDER_V2_MODE`/`COMMANDER_LEGACY_EXECUTION` 开关 | `apps/api/src/envSignal.ts`、`apps/api/src/legacyExecutionGuard.ts` |
| CLI 帮助文本指向裸 `http://localhost:4000`，未指向 `/v1` 入口 | `packages/core/src/cli/commands/misc.ts:24`、`packages/core/src/cli/commands/serve.ts:84` |

---

## 2. /v1 路由定义：企业产品唯一入口

### 2.1 企业 profile

引入显式 profile 概念，统一现有分散的生产/遗留开关：

| Profile | 触发条件 | 路由策略 |
|---|---|---|
| `enterprise` | `COMMANDER_PROFILE=enterprise`，或 `NODE_ENV=production`，或 `COMMANDER_ENV=production`/`prod` | **仅** `/v1/*`、`/health`、`/ready`、`/health/detailed`、`/metrics`、`/v1/openapi.json` 可达；其余产品路由返回 **410 Gone** 并带 `x-legacy: true` |
| `standard`（默认） | 以上条件均不满足 | 全部路由可达，旧路由仍带 `x-legacy: true` 响应头以标记弃用 |

判定函数集中在新模块 `apps/api/src/profileSignal.ts`：`getCommanderProfile()` 返回 `'enterprise' | 'standard'`；`isEnterpriseProfile()` 布尔形式。复用 `envSignal.ts` 的生产信号，并新增 `COMMANDER_PROFILE` 显式覆盖（`enterprise`/`standard`），显式值优先于环境推断。

### 2.2 /v1 资源表面（冻结）

`/v1` 下暴露的企业资源（在现有 `/v1/runs` 基础上收敛）。下表为冻结后的稳定表面：

| 路径 | 方法 | 语义 | 现有来源 |
|---|---|---|---|
| `/v1/runs` | POST | 提交持久化 agent run（需 Idempotency-Key + 租户身份） | 已存在 `v1GatewayEndpoints.ts` |
| `/v1/runs/{runId}` | GET | 查询 run 状态 | 已存在 |
| `/v1/runs/{runId}/events` | GET | 事件时间线 | 已存在 |
| `/v1/runs/{runId}/status` | GET | 轻量状态探针 | 已存在 |
| `/v1/runs/{runId}/pause` / `/resume` / `/cancel` | POST | 生命周期控制 | 已存在 |
| `/v1/projects` / `/v1/projects/{projectId}` | GET | 项目只读查询 | 迁移自 `projectEndpoints.ts`（仅 GET） |
| `/v1/projects/{projectId}/war-room` | GET | WarRoom 快照（只读，见 §5） | 迁移自 `projectEndpoints.ts:100` |
| `/v1/projects/{projectId}/memory` / `/search` | GET | 记忆只读检索 | 迁移自 `projectEndpoints.ts`（仅 GET） |
| `/v1/governance/{...}` | GET | 治理统计/告警/周报（只读） | 迁移自 `projectEndpoints.ts:447-481` |
| `/v1/observability/{...}` | GET | 可观测性只读查询 | 迁移自 `observabilityEndpoints.ts`（仅 GET） |
| `/v1/openapi.json` | GET | 自动生成的 OpenAPI 规范（见 §4） | 新增 |
| `/v1/health` | GET | /v1 子树健康（真实依赖，见 §6） | 新增 |

**不变量**：

1. 企业 profile 下，任何不在 §2.2 表中的 `/v1` 路径返回 404；任何 `/v1` 以外的产品路径返回 410 Gone。
2. `/v1` 路由处理代码**不得**直接构造 `AgentRuntime`（已有守卫测试 `v1GatewayEndpoints.test.ts:159-162`，扩展至全部 `/v1` 处理器）。
3. 内部调用（Worker、调度器、effect broker）不得绕过 `/v1` 提交面；持久化 run 只经 kernel repository（`v1GatewayKernel.ts`）。
4. 所有 `/v1` 写操作要求已认证的租户身份（§3），否则 401。

---

## 3. 租户身份模型：JWT claims 网关层强制

### 3.1 Claims 模型

扩展 JWT payload（`apps/api/src/jwtMiddleware.ts`）增加企业 claims：

```text
{
  id, username, role, type: 'access' | 'refresh',   // 既有
  tenant_id: string,                                 // 新增：租户绑定
  scopes: string[]                                   // 新增：作用域（如 runs:write, runs:read, governance:read）
}
```

- `tenant_id` 必填于企业 profile 下的 access token；缺失或非法格式（不匹配 `^(?!.*\.\.)[a-zA-Z0-9._:-]{1,128}$`）→ 401 `TENANT_CLAIM_REQUIRED`。
- `scopes` 用于 `/v1` 路由级授权（如 `POST /v1/runs` 需 `runs:write`）；缺失时按 `role` 兜底（admin 全量，其余只读）。
- API key 认证路径保留（`authMiddleware.ts` 已设置 `req.tenantId`），与 JWT 路径在 `req.tenantId` 上汇合；JWT 的 `tenant_id` 不得被客户端 `X-Tenant-ID` 头覆盖（沿用 `tenantContextMiddleware.ts` 的 AUTH-2/B4 不变量）。

### 3.2 fail-closed 行为

新增 `apps/api/src/v1TenantGuard.ts`（或在 `jwtMiddleware` 中增加 enterprise 模式分支），作为 `/v1` 前置中间件：

| 场景 | 行为 | 错误码 |
|---|---|---|
| 无 Authorization 头 / 非 Bearer / 无 X-API-Key | 401 | `AUTHENTICATION_REQUIRED` |
| JWT 签名无效、过期、非 access 类型 | 401 | `INVALID_TOKEN` |
| JWT 合法但无 `tenant_id` claim（企业 profile） | 401 | `TENANT_CLAIM_REQUIRED` |
| `tenant_id` 不存在于 TenantProvider | 403 | `TENANT_NOT_FOUND` |
| `X-Tenant-ID` 与 JWT `tenant_id` 不一致 | 403 | `TENANT_MISMATCH` |
| 跨租户访问（run 的 tenantId ≠ 请求 tenantId） | 404（不泄露存在性） | `RUN_NOT_FOUND` |

**禁止**：解析失败后放行并交由下游决定（当前 `jwtMiddleware.ts:156-191` 的 fail-open 行为在企业 profile 的 `/v1` 路径上必须反转）。非 `/v1` 路径在 enterprise profile 下直接 410，不进入此中间件。

---

## 4. OpenAPI 规范生成策略：文档即接口

### 4.1 从路由代码生成

废弃手写 `apps/api/src/openApiSpec.ts` 与 `index.ts:751-1043` 内联规范。改为**从 `routerRegistry.ts` 的注册清单 + 路由级元数据生成**：

- 扩展 `RouterRegistration`（`routerRegistry.ts:22-30`）增加可选 `openapi?: OpenApiMeta` 字段：`{ summary, tags, parameters?, requestBody?, responses?, deprecated?, xLegacy? }`。
- 每个 `registerRouter({...})` 调用补充 `openapi` 元数据（summary/tags/responses 等）；路径参数从 mountPath + router 内 `router.get/post(path)` 推导。
- 新增 `apps/api/src/openApiGenerator.ts`：遍历 `listRegisteredRouters()` + 各 router 暴露的 route 表，产出 OpenAPI 3.1 paths 对象。
- 暴露于 `GET /v1/openapi.json`（企业 profile）与 `GET /api/openapi.json`（standard profile，标记 `x-legacy`）。

### 4.2 真实性不变量

- 生成器**只**读取实际挂载的路由与 Zod schema（`v1GatewayEndpoints.ts` 已用 `z.object` 定义请求体），不读取任何手写 paths。
- 任何未在代码中注册的路由不得出现在规范中；任何已注册路由不得缺失（缺失视为生成 bug，CI 拦截）。
- 旧路由条目在规范中带 `deprecated: true` 与 `x-legacy: true`，并在 `description` 注明删除时间线（§7）。

---

## 5. WarRoom 降级方案：只读运维面板

### 5.1 移除执行/状态变更能力

WarRoom（`apps/api/src/projectEndpoints.ts` + `apps/api/src/store.ts` 的 `createWarRoomStore`）在企业 profile 下降级为只读运维面板：

| 现有端点 | 企业 profile 行为 |
|---|---|
| `GET /projects/{id}/war-room` | 迁移至 `GET /v1/projects/{id}/war-room`，只读快照 |
| `GET /projects/{id}/agents` / `/agents/{id}/state` | 迁移至 `/v1/...`，只读 |
| `POST /projects/{id}/missions` | **移除**（410 Gone）；创建工作改为 `POST /v1/runs` |
| `PATCH /missions/{id}` | **移除**（410 Gone）；状态变更经 `/v1/runs/{id}/pause|resume|cancel` |
| `POST /missions/{id}/approve` | **移除**（410 Gone）；审批经 `/v1` 治理资源 |
| `POST /missions/{id}/logs` | **移除**（410 Gone）；日志经 kernel 事件流 |
| `PATCH /projects/{id}/agents/{id}/state` | **移除**（410 Gone） |
| `POST /projects/{id}/memory` | **移除**（410 Gone）；记忆写入经 `/v1` 写资源（后续 WS） |

### 5.2 不变量

- WarRoom 处理器**不得**调用任何 Agent 执行 API、不得触发 run 提交、不得变更 kernel 状态。
- `WarRoomStore` 仅作为非 `/v1` 的 mission/log UI 存储继续存在（`v2-migration-guide.md` §Dual path 已声明其 demoted），但企业 profile 下其写入端点全部 410。
- standard profile 保留写入端点以兼容本地开发，但响应头带 `x-legacy: true`。
- WarRoom 在企业 profile 下**仅**对 `/v1` 路径暴露只读视图（§2.2 表）。

---

## 6. 健康检查与就绪度诚实化

### 6.1 移除虚假 READY

当前 `/ready`（`apps/api/src/index.ts:350-366`）以 `store ? 'ok' : 'fail'` 判定，store 单例在启动时即非 null，导致依赖未就绪也报 ready。改为**真实探测下游依赖**：

| 检查项 | 探测方式 | 失败行为 |
|---|---|---|
| `database` | 对 kernel DSN 执行 `SELECT 1`（通过 `PostgresKernelRepository` 的健康探针） | `fail` → 503 |
| `kernel` | `getV1KernelGateway() !== null` 且 repository.initialize 已完成 | `fail` → 503 |
| `effectBroker` | EffectBroker 心跳/就绪探针（`packages/effect-broker`） | `fail` → 503 |
| `warRoomStore` | 保留，但仅反映 UI 存储可用性，不作为就绪门禁 | `degraded` |
| `memoryHeap` | heap 使用率 < 80% | `degraded`（不门禁） |

- `/ready` 在任一硬门禁（database/kernel/effectBroker）fail 时返回 503 + `not_ready`；全部通过返回 200 + `ready`。
- `/health` 保持轻量（仅进程存活 + heap），用于 k8s liveness，不探测下游。
- `/health/detailed` 复用 `HealthCollector` + `buildHealthSources()`（`index.ts:384`），并叠加 §6.1 表中的 dependency 探测结果。
- `/v1/health` 仅返回 `/v1` 子树依赖（kernel、effectBroker）状态，供企业客户端判断 `/v1` 可用性。

### 6.2 不变量

- 健康端点**不得**对未探测的依赖返回 `ok`/`ready`；未实现探针的依赖返回 `unknown`（不计入门禁但必须显式标注，不得伪装成 ok）。
- 生产启动已有的 kernel 强制（`index.ts:1068-1088`）保留；`/ready` 与之一致——kernel 未初始化时 `/ready` 必 503。

---

## 7. API 版本策略：避免多版本地狱

| 版本 | 状态 | 规则 |
|---|---|---|
| `/v1` | **Stable（冻结）** | 企业产品唯一稳定表面；语义化版本兼容，仅可追加可选字段/端点，不得破坏现有契约 |
| `/v2` | **Experimental** | 仅在 `COMMANDER_EXPERIMENTAL_V2=1` 时可达；不挂载于企业 profile 默认；用于 ATR/kernel 新一代接口试验 |
| `/v3+` | 禁止并行 | 任何新稳定版本必须先冻结并发布 `/v1` 的 sunset 计划，且同一时刻**最多 2 个稳定版本并行**（N + N-1） |

**演进流程**：

1. 新接口先在 `/v2` experimental 下试验，带 `x-experimental: true` 响应头。
2. 稳定后提升为 `/vN+1`，同步在 `/v1` openapi 标注 sunset 日期（最短 6 个月）。
3. `/v1` 删除前至少经历 1 个 minor 版本的 `deprecated` 标注 + sunset 头（`Sunset: <HTTP-date>`，RFC 8594）。
4. **禁止**在同一版本内通过 query param 切换语义；版本切换只能通过路径前缀。

---

## 8. 旧路由迁移路径：x-legacy 与删除时间线

### 8.1 标记策略

- 所有非 `/v1` 产品路由的响应头追加 `x-legacy: true`，并在 OpenAPI 中标记 `deprecated: true`。
- `x-legacy` 由一个统一的响应中间件注入（挂载在 routerRegistry 之后、errorHandler 之前），根据 `req.path` 是否以 `/v1`、`/health`、`/ready`、`/metrics`、`/system` 开头决定是否注入。
- 企业 profile 下，`x-legacy` 路由直接返回 410 Gone（带 `x-legacy: true` 与 `Deprecation` 头），不进入业务处理器。

### 8.2 删除时间线

| 路由族 | x-legacy 标注 | 企业 profile 410 | 完全删除 |
|---|---|---|---|
| `/api/runtime/execute`、`/api/orchestrator/*`（legacy exec） | WS3 发布即标 | WS3 发布即 410（已由 `legacyExecutionGuard` 部分实现，企业 profile 默认禁用） | 下个 minor |
| `/api/chat`、`/api/webhook/*`、`/api/pause|resume|cancel` | WS3 发布即标 | WS3 发布即 410 | 下个 minor |
| `/projects/*`、`/missions/*`（非 /v1） | WS3 发布即标 | WS3 发布即 410 | +1 minor |
| `/api/v1/*` 别名前缀（evaluation/governance/state-machine 等） | WS3 发布即标 | WS3 发布即 410 | +1 minor |
| `/a2a/*`、`/mcp/*`、`/scim/v2/*` | WS3 发布即标 | 保留只读 GET（若企业需要）或 410 | 视 WS 需求评估 |

`/health`、`/ready`、`/metrics`、`/system/status`、`/health/detailed` 为运维端点，**不**标 `x-legacy`，不在企业 profile 下 410。

---

## 9. WS8 协同：CLI 帮助文本指向 /v1

- `packages/core/src/cli/commands/misc.ts:24`（`cmdGui`）的 `API: http://localhost:4000` 改为指向 `http://localhost:4000/v1`，并在帮助文本注明企业入口为 `/v1`。
- `packages/core/src/cli/commands/serve.ts:84`（API endpoints 列表）首条改为 `/v1`。
- CLI 状态命令（`status.provider.api_url`，`i18n.ts:174`）默认值指向 `/v1`。
- 此项与 WS8（CLI 表面）协同，确保 CLI 不会引导用户调用旧路由。实现细节以 WS8 spec 为准；WS3 仅要求 CLI 默认入口指向 `/v1`。

---

## 10. 实现边界与测试计划

### Phase 1：Spec

- 本文档作为唯一 WS3 验收基线。
- 评审通过后才能进入代码改造。

### Phase 2：Build

1. 新增 `apps/api/src/profileSignal.ts`（`getCommanderProfile`/`isEnterpriseProfile`）。
2. 新增企业 profile 路由冻结中间件：非 `/v1`/运维路径 → 410 + `x-legacy`。
3. 新增 `x-legacy` 响应头中间件（standard profile 标注，enterprise profile 已 410）。
4. 扩展 `jwtMiddleware` + 新增 `/v1` 租户守卫（§3.2 fail-closed 表）。
5. 扩展 `RouterRegistration.openapi` 元数据 + 新增 `openApiGenerator.ts`；删除 `openApiSpec.ts` 与内联手写规范；暴露 `/v1/openapi.json`。
6. 将 `projectEndpoints.ts` 的 GET 端点迁移至 `/v1/projects/*`、`/v1/governance/*`；WarRoom 写入端点在企业 profile 下 410。
7. 改造 `/ready` 真实探测 database/kernel/effectBroker；新增 `/v1/health`。
8. 配合 WS8：CLI 帮助文本默认指向 `/v1`。
9. 先写失败测试，再实现最小路径（TDD）。

### Phase 3：Review & Audit

1. 验证：企业 profile 下，`/v1` 以外产品路由返回 410 Gone + `x-legacy: true`。
2. 验证：伪造/过期/跨租户 JWT 被 fail-closed 拒绝（401/403/404）。
3. 验证：`/v1/openapi.json` 与实际挂载路由一致（自动化测试对比：遍历 `listRegisteredRouters()` 的路径集合 ⊕ openapi paths = ∅）。
4. 验证：WarRoom 无法触发任何 Agent 执行或状态变更（企业 profile 下写入端点全 410；`/v1` 处理器不含 `new AgentRuntime`）。
5. 验证：`/ready` 在 kernel/effectBroker 未就绪时返回 503，不返回虚假 ready。
6. spec 逐条验收，确认 API 表面已冻结且文档诚信，标记 `ACCEPTED`。

---

## 11. 验收清单

- [x] §2.1 `profileSignal.ts` 实现；`COMMANDER_PROFILE` 显式覆盖优先于环境推断。 ✅ commit c5ca68c
- [x] §2.2 企业 profile 下 `/v1` 仅暴露 §2.2 表中路径；其余产品路由 410 Gone + `x-legacy: true`。 ✅ enterpriseGateway.test.ts + ws3Acceptance.test.ts
- [x] §2.2 `/v1` 处理器不含 `new AgentRuntime` / 不绕过 kernel 提交面（守卫测试覆盖全部 `/v1` 路由）。 ✅ v1GatewayEndpoints.ts 注释 + v1GatewayEndpoints.test.ts
- [x] §3.1 JWT access token 在企业 profile 下携带 `tenant_id` + `scopes` claims。 ✅ commit 2c11e43 (jwtMiddleware.ts)
- [x] §3.2 `/v1` 租户守卫按 fail-closed 表逐场景拒绝（401/403/404）。 ✅ v1TenantGuard.test.ts (17 cases)
- [x] §3.2 JWT 解析失败在企业 profile `/v1` 路径下不再 fail-open。 ✅ jwtMiddleware.ts V1_AUTH_EXEMPT_PATHS + v1TenantGuard.test.ts
- [x] §4.1 OpenAPI 从 `routerRegistry` + 路由元数据生成；手写 `openApiSpec.ts` 与内联规范删除。 ✅ commit c8ae59c (openApiGenerator.ts, openApiSpec.ts 已删)
- [x] §4.2 `/v1/openapi.json` 与实际路由一致（自动化对比测试通过）。 ✅ openApiGenerator.test.ts (13 cases, authenticity invariant)
- [x] §5 WarRoom 写入端点（missions/approve/logs/agent-state）在企业 profile 下 410；GET 迁移至 `/v1`。 ✅ warRoomDemotion.test.ts + ws3Acceptance.test.ts
- [x] §5 WarRoom 处理器不触发 Agent 执行或 kernel 状态变更。 ✅ createProjectRouter readOnly 选项 + v1 处理器无 AgentRuntime
- [x] §6.1 `/ready` 真实探测 database/kernel/effectBroker；未探测项标 `unknown`，不伪装 ok。 ✅ healthHonesty.test.ts (15 cases) + ws3Acceptance.test.ts
- [x] §6.1 kernel 未初始化时 `/ready` 必 503。 ✅ healthProbes.ts HARD_GATES + healthHonesty.test.ts
- [ ] §7 `/v2` 仅 experimental 标志下可达；企业 profile 默认不挂载 `/v2`。（v2-bench 已挂载于 /v2，企业 profile 下被 enterpriseRouteFreeze 410；experimental 标志未实现，留待后续 WS）
- [x] §8 旧路由响应头带 `x-legacy: true`；OpenAPI 标 `deprecated` + sunset 时间线。 ✅ legacyHeader + openApiGenerator x-legacy 自动标记
- [x] §9 CLI 帮助文本默认指向 `/v1`（与 WS8 协同）。 ✅ commit 6a7ebd6 (misc.ts + serve.ts)
- [x] Phase 3 全部验证项有测试证据；本文档标记 `ACCEPTED`。 ✅ 85/85 测试通过
