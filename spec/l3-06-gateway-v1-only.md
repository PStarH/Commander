# L3-06：Gateway `/v1` only — 残余缺口审计与收口

**状态：DONE（verification + 2 ENFORCED fixes）**  
**范围：相对 WS3 ACCEPTED 基线的诚实残余缺口**  
**基线：** `spec/ws3-gateway-v1-only.md`（ACCEPTED，85/85 测试）  
**分支：** `feat/l3-06-gateway-v1-only` @ base `a9d2cf9a`

---

## 1. 论题（继承 WS3）

企业 profile 不得在 Gateway 进程内执行 legacy AgentRuntime；`/v1` 是唯一产品表面；JWT 租户 fail-closed；OpenAPI 与真实路由同源。

L3-06 **不是** greenfield 重写，而是对 WS3 已 ACCEPTED 实现的残余缺口审计。

---

## 2. WS3 已 ENFORCED（本任务仅验证，无代码变更）

| 不变量 | 证据 |
|---|---|
| `profileSignal.ts` — `COMMANDER_PROFILE` / 生产信号 → enterprise | `profileSignal.test.ts` (7 cases) |
| `enterpriseRouteFreeze` — 非 `/v1`/运维路径 → 410 + `x-legacy` | `enterpriseGateway.test.ts` + `ws3Acceptance.test.ts` |
| `v1TenantGuard` — JWT/API-key fail-closed 表 | `v1TenantGuard.test.ts` (17 cases) |
| `jwtMiddleware` — enterprise `/v1` 无效 Bearer → 401 INVALID_TOKEN | `v1TenantGuard.test.ts` + `jwtMiddleware.ts` |
| OpenAPI 从 `routerRegistry` 生成，`/v1/openapi.json` 真实性 | `openApiGenerator.test.ts` (13 cases) |
| WarRoom 写入端点 enterprise 410；`/v1` 只读 | `warRoomDemotion.test.ts` + `ws3Acceptance.test.ts` |
| `/ready` 真实探测，无虚假 READY | `healthHonesty.test.ts` (15 cases) |

---

## 3. 残余缺口审计（L3-06 发现）

### 3.1 `isLegacyExecutionAllowed()` 未绑定 enterprise profile

**问题：** 守卫仅检查 `NODE_ENV=production`，未检查 `COMMANDER_PROFILE=enterprise`。在 `enterprise + development + COMMANDER_LEGACY_EXECUTION=1` 下，orchestrator 路由仍会被 `index.ts:663` 注册，pipeline 中间件放行（尽管 `enterpriseRouteFreeze` 会在路由层 410，但属于单点防御）。

**证据：** `legacyExecutionGuard.ts`（修复前）无 `isEnterpriseProfile()` 调用。

**处置：ENFORCED** — `isLegacyExecutionAllowed()` 增加 `!isEnterpriseProfile()`；`legacyExecutionDisabledReason()` 增加 enterprise 分支。

### 3.2 `/api/openapi.json` 绕过 `enterpriseRouteFreeze`

**问题：** `index.ts:827` 在模块加载期直接 `app.get('/api/openapi.json')`，注册顺序早于 `startServer()` 内的 `enterpriseRouteFreeze()`（`:968`）。Express 先匹配该 handler，注释声称 "enterprise profile 410s via freeze" **不成立**。

**证据：** `grep '^app\.(get|post|use)' index.ts` — openapi 路由在 freeze 之前；`isEnterpriseReachablePath('/api/openapi.json')` → false 但 freeze 永不执行。

**处置：ENFORCED** — handler 内 `isEnterpriseProfile()` → 410 Gone + `x-legacy` + `Deprecation`。

### 3.3 `chatEndpoints.ts` 未挂载

**状态：N/A（非缺口）** — `createChatRouter` 未在 `index.ts` / `routerRegistry` 注册；无运行时暴露面。

### 3.4 ATR / `/v2` experimental

**状态：PARTIAL（继承 WS3 §7 未勾选项）** — `/v2` 在企业 profile 下被 `enterpriseRouteFreeze` 410；`COMMANDER_EXPERIMENTAL_V2` 标志未实现。留待后续 WS，非 L3-06 范围。

### 3.5 用户认证路由 `/login` 等企业 410

**状态：BY DESIGN** — WS3 §2.2 冻结表仅列 `/v1` + 运维端点；企业认证经外部 IdP / API-key。非缺口。

---

## 4. 实现变更摘要

| 文件 | 变更 |
|---|---|
| `apps/api/src/legacyExecutionGuard.ts` | enterprise profile 禁止 legacy 执行 |
| `apps/api/src/index.ts` | `/api/openapi.json` handler 内 enterprise 410 |
| `apps/api/test/legacyExecutionGuard.test.ts` | +1 enterprise profile case |
| `apps/api/test/l3-06GatewayResidual.test.ts` | 新增残余缺口验收 |

---

## 5. 验收清单

- [x] Enterprise/production 不可 exercise legacy in-process execution（410/403/disabled + 测试）
- [x] `/v1` JWT/API-key fail-closed 无回归（WS3 测试全绿）
- [x] OpenAPI 真实性无漂移（`openApiGenerator.test.ts` 全绿）
- [x] `/api/openapi.json` pre-freeze 洞已关闭
- [ ] `/v2` experimental 标志 — **PARTIAL**（WS3 遗留）

---

## 6. 测试证据

```text
test/legacyExecutionGuard.test.ts      — 3 cases
test/enterpriseGateway.test.ts         — 6 cases
test/ws3Acceptance.test.ts             — WS3 §11 checklist
test/v1TenantGuard.test.ts             — 17 cases
test/openApiGenerator.test.ts          — 13 cases
test/warRoomDemotion.test.ts
test/profileSignal.test.ts             — 7 cases
test/l3-06GatewayResidual.test.ts      — 4 cases (new)
```

---

## 7. ENFORCED vs PARTIAL 汇总

| 项 | 状态 |
|---|---|
| `/v1` 产品表面冻结 | ENFORCED（WS3） |
| JWT `/v1` fail-closed | ENFORCED（WS3） |
| OpenAPI 真实性 | ENFORCED（WS3） |
| Legacy 执行 enterprise 禁用 | **ENFORCED（L3-06 修复）** |
| `/api/openapi.json` enterprise 410 | **ENFORCED（L3-06 修复）** |
| `/v2` experimental 标志 | PARTIAL |
| `chatEndpoints` 挂载 | N/A（未注册） |
