# 方向二：P0 安全与健康检查修复 Implementation Plan

> **For agentic workers:** Use `general_purpose_task` subagent to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 消除 `code-quality-audit-report.html` 与 `COMMANDER_TASK_PACKAGES.md` 标定的 P0 阻断器，让 `/health` 真实反映系统状态，并堵上可直接利用的安全缺口。

**Architecture:** 本方向聚焦“可观测的欺骗性”和“可直接利用的入口”。修复点集中在 `runtime/healthCheck.ts`、`runtime/httpServer.ts`、`ultimate/artifactSystem.ts`、`mcp/a2aServer.ts` 以及 API 限流层。所有改动遵循 project_memory 中 3-Layer Defense 架构：统一走 `UniversalSanitizer`、不可逆工具走 `ReversibilityGate`、外部调用走 `ResourceGovernor`。

**Tech Stack:** TypeScript, vitest, Express（apps/api）, `crypto.timingSafeEqual`。

---

## File Structure

| File | Responsibility |
|------|---------------|
| `packages/core/src/runtime/healthCheck.ts` | **MODIFY** — 五项 stub 检查接入真实数据源 |
| `packages/core/src/runtime/httpServer.ts` | **MODIFY** — 向 `HealthCollector` 注入 `HealthSources` |
| `packages/core/src/ultimate/artifactSystem.ts` | **MODIFY** — 用户输入进 `new RegExp()` 前转义 |
| `packages/core/src/mcp/a2aServer.ts` | **MODIFY** — JSON-RPC 端点增加 Bearer token 校验 |
| `apps/api/src/index.ts` | **MODIFY** — 添加生产速率限制 |
| `README.md`, `ARCHITECTURE.md`, `ENTERPRISE_READINESS.md` | **MODIFY** — 多租户能力声明修正为 Alpha |

---

## Task 1: 修复 `/health` 健康检查虚假数据

**Files:**
- Modify: `packages/core/src/runtime/healthCheck.ts`
- Modify: `packages/core/src/runtime/httpServer.ts`
- Create/Modify: `packages/core/tests/runtime/healthCheck.test.ts`（若不存在则创建）

- [ ] **Step 1: 定义 HealthSources 接口与采集器**

在 `healthCheck.ts` 中确认/新增：

```ts
export interface HealthSources {
  circuitBreaker: () => { status: 'CLOSED' | 'OPEN' | 'HALF_OPEN' } | undefined;
  deadLetterQueue: () => { size: number; threshold: number } | undefined;
  compensation: () => { pending: number } | undefined;
  eventBus: () => { backlog: number } | undefined;
  providers: () => { available: number; total: number } | undefined;
}
```

- [ ] **Step 2: 修改 HealthCollector 接收注入源**

将 `new HealthCollector()` 改为 `new HealthCollector(sources)`，使五项检查不再返回 `"healthy — not wired"`。

- [ ] **Step 3: 在 CommanderHttpServer 构造时收集真实 getter**

在 `httpServer.ts` 中构造 `HealthSources`：

```ts
const healthSources: HealthSources = {
  circuitBreaker: () => this.circuitBreakerRegistry?.getSummary(),
  deadLetterQueue: () => ({ size: this.deadLetterQueue?.size() ?? 0, threshold: 100 }),
  compensation: () => ({ pending: this.compensationService?.pendingCount() ?? 0 }),
  eventBus: () => ({ backlog: this.messageBus?.backlog() ?? 0 }),
  providers: () => this.providerRegistry?.healthSummary(),
};
```

- [ ] **Step 4: 编写回归测试**

创建测试断言：当 DLQ size > threshold 或 breaker OPEN 时，`/health` 返回非 healthy 状态。

- [ ] **Step 5: 运行测试**

Run:
```bash
cd packages/core && corepack pnpm vitest run --no-cache tests/runtime/healthCheck.test.ts
```

Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/runtime/healthCheck.ts packages/core/src/runtime/httpServer.ts packages/core/tests/runtime/healthCheck.test.ts
git commit -m "fix(runtime): wire real health sources into /health endpoint"
```

---

## Task 2: 修复 artifactSystem 正则注入

**Files:**
- Modify: `packages/core/src/ultimate/artifactSystem.ts`
- Modify: `packages/core/tests/ultimate/artifactSystem.test.ts`（若存在）或创建新测试

- [ ] **Step 1: 定位用户输入进入 RegExp 的位置**

找到 `artifactSystem.ts:134` 附近使用 `new RegExp(userInput)` 的代码。

- [ ] **Step 2: 添加 escapeRegex 辅助函数**

```ts
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
```

- [ ] **Step 3: 在构造正则前转义用户输入**

```ts
const safePattern = escapeRegex(userInput);
const regex = new RegExp(safePattern, 'i');
```

- [ ] **Step 4: 添加测试覆盖恶意输入**

```ts
it('does not treat user input as regex metacharacters', () => {
  const result = findArtifacts('test.*');
  expect(result).toEqual([/* only literal match */]);
});
```

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/ultimate/artifactSystem.ts packages/core/tests/ultimate/artifactSystem.test.ts
git commit -m "fix(ultimate): escape user input before constructing RegExp in artifactSystem"
```

---

## Task 3: 给 A2A Server 添加强制认证

**Files:**
- Modify: `packages/core/src/mcp/a2aServer.ts`
- Modify: `packages/core/tests/security/a2aMtls.test.ts`

- [ ] **Step 1: 读取 A2A 配置入口**

确认 `a2aServer.ts` 如何从 env/config 读取 `authToken`（project_memory 要求：未配置时返回 500 并阻塞所有请求）。

- [ ] **Step 2: 在 handleJsonRpc 前加 Bearer token 中间件**

```ts
private requireAuth(req: IncomingMessage, res: ServerResponse, next: () => void): void {
  const authHeader = req.headers.authorization ?? '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!this.authToken || !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(this.authToken))) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return;
  }
  next();
}
```

若 `this.authToken` 未配置，直接返回 500：

```ts
if (!this.authToken) {
  res.writeHead(500, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'A2A authToken not configured' }));
  return;
}
```

- [ ] **Step 3: 更新 a2aMtls.test.ts 提供 token**

确保现有测试在请求头里带 `Authorization: Bearer <token>`，否则测试会 401。

- [ ] **Step 4: 运行测试**

Run:
```bash
cd packages/core && corepack pnpm vitest run --no-cache tests/security/a2aMtls.test.ts
```

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/mcp/a2aServer.ts packages/core/tests/security/a2aMtls.test.ts
git commit -m "fix(mcp): enforce Bearer token on A2A JSON-RPC endpoints"
```

---

## Task 4: 添加 API 生产速率限制

**Files:**
- Modify: `apps/api/src/index.ts`
- Modify: `apps/api/package.json`

- [ ] **Step 1: 安装 express-rate-limit**

Run:
```bash
corepack pnpm --filter api add express-rate-limit
```

- [ ] **Step 2: 在公开路由前挂载限流器**

```ts
import rateLimit from 'express-rate-limit';

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.path === '/health' && req.method === 'GET',
});

app.use('/api', limiter);
```

- [ ] **Step 3: 添加限流测试**

在 `apps/api/tests/`（若无则创建）添加测试：第 101 个请求返回 429。

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/index.ts apps/api/package.json apps/api/tests/rateLimit.test.ts
git commit -m "feat(api): add production rate limiter (100 req/min per IP)"
```

---

## Task 5: 多租户能力声明修正

**Files:**
- Modify: `README.md`
- Modify: `ARCHITECTURE.md`
- Modify: `ENTERPRISE_READINESS.md`

- [ ] **Step 1: 在所有面向用户的文档中标注 Alpha**

把“多租户隔离”相关段落改为：

```md
⚠️ Alpha — API 上下文隔离已实现，但存储层隔离需由后端存储自行保证。生产多租户部署前请验证存储后端。
```

- [ ] **Step 2: 在 `tenantAwareSingleton.ts` 非开发环境加警告**

```ts
if (process.env.NODE_ENV !== 'development') {
  console.warn('WARN: Global singleton bypass — data not isolated by tenant');
}
```

- [ ] **Step 3: Commit**

```bash
git add README.md ARCHITECTURE.md ENTERPRISE_READINESS.md packages/core/src/runtime/tenantAwareSingleton.ts
git commit -m "docs(tenancy): mark multi-tenancy as Alpha and add runtime isolation warning"
```

---

## Self-Review

- **Spec coverage:** 覆盖 health wiring、regex injection、A2A auth、rate limiting、tenancy disclaimer 五个 P0/P1 项。
- **Placeholder scan:** 无 TBD；每步含具体代码/命令。
- **Security consistency:** A2A 使用 `crypto.timingSafeEqual`；artifactSystem 使用转义而非 sanitize 后再次拼接。

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-04-p0-security-health-fixes.md`.

**Execution options:**
1. **Subagent-driven** — dispatch `general_purpose_task` subagent per task.
2. **Inline execution** — I run each step in this session.

Which approach do you want for this direction?
