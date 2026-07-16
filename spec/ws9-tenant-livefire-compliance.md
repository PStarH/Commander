# WS9：跨租户实弹隔离与合规证据（live-fire）

**状态：Draft，待评审**
**范围：Phase 1 Spec → Phase 2 Build → Phase 3 Review & Audit**
**证据等级目标：`evidenceLevel=live`（built image + real PostgreSQL + non-owner role + multi-process/container + 真实 failover/篡改）**

> 本文档是 WS9 的唯一验收基线。评审通过后才能进入代码与测试改造。所有验收项在 Phase 3 审计产生 live 证据后，状态方可改为 `ACCEPTED`。本产出拟作为 $50M 技术尽调的核心安全证据。

---

## 1. 依据与问题定义

### 1.1 架构评审 Final Verdict 的直接约束

WS9 的章程来自架构评审 §8 工作流表：

> `| WS9 | arch/ws9-tenant-livefire-compliance | real-backend isolation proof | Med |`
> — `.internal/docs/architecture-reviews/2026-07-15-project-olympus-architecture-council.md:414`

Final Verdict 中本任务必须关闭的核心断言：

- **Q1（阻碍 trusted-Enterprise-OS 的根因）第 3 项**：`No production-grade multi-tenant isolation (compute + data).`（council L343）
- **Q1 收尾**：`Trust is not features. Trust is one path, fail-closed, proven under adversarial multi-tenant load, boringly operated.`（council L350）
- **Q2 第 10 项**：`Multi-tenant data plane: RLS or DB-per-tenant for all durable stores; live-fire on real backends.`（council L363）
- **Q3 Months 4–6**：`gVisor/Docker per-tenant or per-run default; memory/store consolidation; live-fire cross-tenant; ... pen-test + SOC2 Type I start.`（council L371）
- **§5 行动表**：`REPLACE | Simulated tenant fuzz as SOC evidence | Liability.`（council L299）
- **§2.9 honest tier**：`ENTERPRISE_READINESS multi-tenancy Alpha is honest; some ✅ (e.g. simulated cross-tenant fuzz) overshoot for diligence.`（council L173–175）

发布就绪评审 Final Verdict：

> `Commander … 当前仓库不可作为 enterprise production release，也不可作为 5000 万收购的技术完工证明。` — `architecture-v2-release-readiness-review-2026-07-13.md:254-258`

信任审计总判定：

> `Overall verdict: BLOCK MERGE / NOT YET TRUSTWORTHY for production, financial, infrastructure, or confidential-data workloads.` — `.internal/docs/audits/2026-07-13-commander-enterprise-trust-audit.md:12`

### 1.2 前序 WS 规格的接受状态与本 spec 的依赖

| Spec | 路径 | 状态 | WS9 依赖关系 |
|---|---|---|---|
| WS0 | `.internal/spec/ws0-contracts-constitution.md` | ACCEPTED | 提供契约包边界，不直接依赖 |
| WS1 | `.internal/spec/ws1-kernel-ops-durability.md` | ACCEPTED（但 `Acceptance status: Pending Phase 3 audit`，L6） | 依赖其 tenant-pause / lease / outbox 隔离契约（L287–332, L382–383）；WS9 为其 Phase 3 审计提供 live 证据 |
| WS2 | 未提交分支 `feat-effect-broker-monopoly` | 自标 ACCEPTED 被分支审计判为「超报」 | effect-broker 作为唯一跨租户 effect PEP，WS9 必须验证其 admit() 在生产运行时被调用且无旁路 |
| WS3 | 未提交分支 `feat-freeze-enterprise-api-v1` | 验收测试 `ws3Acceptance.test.ts:31` 导入不存在的符号，判为不成立 | `/v1` gateway 收口，WS9 必须验证遗留 `/api/*` 不能绕过租户作用域 |
| WS4 / WS5 | 无 spec | 不存在 | 仅 roadmap 条目，不构成依赖 |
| WS6 | `.internal/spec/ws6-memory-store-unify.md` | DRAFT | 其 `memory_items` RLS 设计（§8 L245–265）是 WS9 数据隔离的对象之一；WS6 未落地前，WS9 对现有 memory store 做实弹测试并如实标注 |
| WS7 | `spec/ws7-sandbox-failclosed.md` | Draft，待评审 | 提供执行隔离的 fail-closed 沙箱契约；WS9 验证其生产禁止项在真实 gVisor/Docker 下成立 |
| WS8 | `.internal/spec/ws8-sku-honesty-dx.md` | DRAFT | 提供「simulated ≠ live/SOC 证据」的诚实规则；WS9 沿用其公开安全规则 |

**结论**：WS9 不假设 WS2/WS3/WS6/WS7/WS8 已 ACCEPTED。对尚未落地的契约，WS9 以当前仓库真实状态为对象做实弹测试，并在就绪度矩阵中如实标注「依赖 spec 未 ACCEPTED」。

### 1.3 WS9 必须关闭的未验证声明（16 项）

源自 council / trust audit / 发布就绪评审 / ENTERPRISE_READINESS.md 的交叉比对。每项在后续章节有对应的实弹测试。

**多租户隔离（D.1）**
1. 真实 PostgreSQL + 非 owner role + `WITH CHECK` 的跨租户数据隔离（council L363；发布就绪 L64–66：RLS 测试用 owner/superuser、无 `WITH CHECK`、`tenant_scope='*'` 旁路）。
2. 租户身份来自认证主体而非 `X-Tenant-ID` 头（信任审计 KC-1 L32、B4 L49；council L171「JWT without tenant」）。
3. 每租户/每工作负载计算隔离，gVisor/Docker 默认、无共享容器/宿主执行（council L371, L171；WS7；信任审计 KC-2 L33）。
4. 所有持久存储的跨租户隔离，不止 kernel Postgres（council L224「Tenant ALS ≠ isolation」；WarRoomStore/ATR RunLedger/EventSourcingEngine/文件 Map store）。
5. effect-broker 是唯一跨租户 effect 闸口且无旁路（信任审计 ARCH-3 L264；分支审计 §II.1 L23）。
6. tenant pause 精确影响单一租户（WS1 L330–332, L382–383；WS1 Phase 3 审计未做）。
7. 真实负载下的每租户限流与公平调度（发布就绪 §13 L252；to-90-plan §10 L190：`bench-tenant-concurrency` `passed=false`）。
8. `/v1` gateway 是唯一企业面，遗留 `/api/*` 不能绕过租户作用域（council §2.12 L185–187；WS3 未提交）。

**合规 / 审计（D.2）**
9. SOC 2 Type II 报告（ENTERPRISE_READINESS.md SOC2-5 ❌；council L317）。
10. 外部锚定的防篡改 / WORM 审计链（信任审计 KC-5 L36：`verify()` 从不调用、HMAC 密钥与日志同处、无 chain registry、整链删除/尾部截断通过校验、compliance 报告硬编码 `tamperProof:true`）。
11. DPA 模板（ENTERPRISE_READINESS.md DATA-2 ❌）。
12. memory + audit 静态加密，不止 API key（ENTERPRISE_READINESS.md DATA-3 🟡；council L267「vault-only secrets」）。
13. 合规报告不得从 reporter 自身声明「合规」（WS8 L36；council L299）。
14. GDPR Art 17 / 数据驻留 / 客户自管密钥的演练证据（发布就绪 §5 L111；ENTERPRISE_READINESS.md DATA-4 🟡）。
15. 非 owner PostgreSQL role 由部署 chart 强制生成并在 CI 以该 role 验证（发布就绪 §6 L121；Helm 现用 `commander` owner role）。

**横切（D.3）**
16. simulated 证据不得充当 live/SOC 证据（90-decisions D3 L32–51、D4 L54–66；to-90-plan §10 L194：`benchmark-2026-07-09-real.json` verdict=FAIL 仍被提交为证据）。

---

## 2. 安全不变量

WS9 的不变量是：**在真实后端（PostgreSQL + Vault + gVisor + /v1 gateway）的多租户对抗负载下，任意租户 A 的认证主体无法读取、修改、执行、挤占或观测租户 B 的任何数据、计算、网络、配额与审计；任何篡改审计日志的行为导致签名校验失败并告警；任何经环境变量注入的密钥在生产路径被拒绝；所有「已验证」声明都有可复现的 live 证据，simulated 证据不得填充 live/SOC 槽位。**

失败行为统一为 fail-closed：测试发现穿越即 `verdict=FAIL`，运行时检测到穿越/篡改即拒绝该操作并告警，绝不降级为通过或空输出。

---

## 3. 测试基础设施要求

所有 WS9 证据必须满足 `evidenceLevel=live`（90-decisions D4 L54–66）：built image + 真实 PostgreSQL + 非 owner role + 多进程/多容器 + 真实 failover/篡改。InMemory、mock、simulated predicate 只能作为开发辅助，不得进入证据包。

### 3.1 隔离环境拓扑

| 组件 | 要求 | 拒绝条件 |
|---|---|---|
| 编排 | docker-compose（本地与 CI 一致）或等效 k8s namespace；专用 `ws9-livefire` 环境，不复用开发库 | 与开发/生产共享数据库或 namespace |
| PostgreSQL | 真实 Postgres ≥ 14；`deploy/docker/postgres-init.sql` 初始化；启用 RLS；生成 `commander_app`（非 owner、非 superuser）role 并 `GRANT` 最小权限；所有 RLS policy 含 `USING` 与 `WITH CHECK` | 用 owner/superuser 跑隔离测试；RLS 缺 `WITH CHECK`；`tenant_scope='*'` 在 worker/recovery/outbox 方法上开事务 |
| Vault | 真实 HashiCorp Vault dev server 或等效；启用 KV v2；所有 secret 经 `EncryptedSecretsVault` 从 Vault 解析；`COMMANDER_VAULT_ADDR`/token 通过 Vault 注入，不进 `process.env.<X>_API_KEY` | 用 `.env` 文件、`process.env` 明文 key 或本地 JWKS 充当 enterprise production 证据（90-decisions D2 L20） |
| gVisor | `runsc` runtime 安装并校验；生产 sandbox policy `gvisor` 显式选择后不得降级；每工作负载临时容器 | `runsc` 不可用时降级为普通 Docker；共享容器；host exec |
| /v1 gateway | `apps/api` 仅暴露 `/v1`、`/health`、`/metrics`、`/v1/auth/*`；遗留 `/api/*` 路由在生产构建中移除或 410 | 遗留路由可达且能绕过租户作用域 |
| 租户 | 至少两个真实租户 `tenant-a`、`tenant-b`，各自 OIDC/JWT 主体、独立 Vault path、独立 DB role、独立 sandbox profile | 用 `__default__` 或共享主体充当多租户证据 |
| 审计存储 | SIEM sink（本地文件 + S3 Object-Lock / WORM 兼容目录或 transparency log 模拟）；HMAC 签名密钥与 KMS/HSM 非对称签名密钥与日志存储物理分离 | HMAC 密钥与日志同处一机；无外部锚定 |

### 3.2 环境就绪门禁

`scripts/ws9-env-check.ts`（新建）在执行任何实弹测试前验证：

- Postgres 连接使用的 role 不是 owner/superuser（`SELECT current_user, session_user; SELECT rolsuper FROM pg_roles ...`）。
- 所有目标表的 RLS 启用且 policy 含 `WITH CHECK`（查 `pg_policy`）。
- Vault 可达且目标 secret path 存在；`process.env` 中不存在任何 `*_API_KEY`/`*_TOKEN`/`*_SECRET`（allowlist 仅留 `COMMANDER_VAULT_ADDR`、`COMMANDER_VAULT_TOKEN`、`NODE_ENV`、`COMMANDER_SANDBOX_ISOLATION` 等）。
- `runsc` 二进制存在且可启动一个空容器。
- `/v1` 唯一可达，遗留 `/api/*` 返回 410 或 404。

任一检查失败：退出非零，不运行实弹套件，不产出证据。

---

## 4. 跨租户实弹测试套件设计

套件位于 `packages/core/tests/ws9/` 与 `apps/api/test/ws9/`，由 `scripts/ws9-livefire.ts`（新建）编排。每个测试产出一份带 `evidenceLevel=live` 的 JSON 证据，写入 `docs/baselines/ws9/`。

**通用对抗模型**：租户 A 的认证主体（持有 A 的合法 JWT）尝试以一切手段触达租户 B 的资源。穿越即 `verdict=FAIL`。**0 穿越为通过。**

### 4.1 数据隔离（关闭 D.1 §1, §2, §4）

| 用例 ID | 攻击向量 | 期望（fail-closed） | 关闭的未验证声明 |
|---|---|---|---|
| DATA-1 | A 主体直接查询 B 的 `runs`/`steps`/`memory_items`/`war_room_*`/`atr_run_ledger`/`event_sourcing_log`（经 /v1 与直连 DB 两条路径） | RLS 拒绝；API 返回 404/403；直连 DB 以 `commander_app` role 返回 0 行 | §1, §4 |
| DATA-2 | A 主体伪造 `X-Tenant-ID: tenant-b` 头 | 服务端以 JWT 主体租户为准，忽略头；或 400；不得以头为准（信任审计 KC-1/B4） | §2 |
| DATA-3 | A 主体尝试 `INSERT/UPDATE` 带 `tenant_id=tenant-b` 的行 | `WITH CHECK` 拒绝；事务回滚 | §1 |
| DATA-4 | A 主体通过 `tenant_scope='*'` 路径（worker/recovery/outbox）触达 B 的行 | 这些方法不得以 `*` 开事务；必须以调用方租户作用域开事务 | §1 |
| DATA-5 | A 主体调用 GDPR Art 17 删除接口尝试删除 B 的数据 | 拒绝；仅删 A 的数据；删除产生审计 | §4, D.2 §14 |
| DATA-6 | 跨所有持久存储枚举：WarRoomStore、ATR RunLedger、EventSourcingEngine WAL、文件/Map store | 每个存储独立验证 A 不能读写 B | §4 |

### 4.2 执行隔离（关闭 D.1 §3, §5）

| 用例 ID | 攻击向量 | 期望 | 关闭声明 |
|---|---|---|---|
| EXEC-1 | A 的工作负载在 gVisor 容器中执行，尝试 `nsenter`/`/proc/1/root`/访问 B 的容器 | gVisor 拦截；操作失败；B 容器无影响 | §3 |
| EXEC-2 | A 尝试复用 B 的容器/工作目录/可写 volume/网络 namespace | 创建时拒绝复用；workloadId 不匹配即拒绝 | §3 |
| EXEC-3 | A 触发宿主执行（`git fetch ext::sh -c id`、`execSync`、SSH backend）（信任审计 KC-2） | 生产构建静态门禁拒绝 host-exec 入口；运行时拒绝执行 | §3 |
| EXEC-4 | A 试图绕过 effect-broker 直接产生跨租户副作用（写 B 的文件、调 B 的 webhook） | effect-broker `admit()` 拒绝未授权跨租户 effect；无旁路 | §5 |
| EXEC-5 | effect-broker 未 wire 到生产运行时（分支审计 §II.1） | 启动检查发现未 wire 即拒绝启动，或测试断言其被调用 | §5 |

### 4.3 网络隔离（关闭 D.1 §3 出网）

| 用例 ID | 攻击向量 | 期望 | 关闭声明 |
|---|---|---|---|
| NET-1 | A 与 B 配置不同出网 allowlist；A 尝试访问仅 B 允许的域名 | `OutboundNetworkPolicy` 按 tenant policy 拒绝 A 的请求；B 仍可达 | §3 |
| NET-2 | A 的工作负载尝试 SSRF 访问 `169.254.169.254`/私网 | 私网阻断；审计记录 | §3 |
| NET-3 | A 尝试把 host network 当 fallback | 拒绝；默认网络 blocked，需外网走 allowlist/proxy | §3 |

### 4.4 速率隔离（关闭 D.1 §7）

| 用例 ID | 攻击向量 | 期望 | 关闭声明 |
|---|---|---|---|
| RATE-1 | A 以 10× 突发请求挤占配额，同时测量 B 的 p95/p99 延迟与成功率 | B 的配额与延迟不受 A 影响；fair scheduling 生效 | §7 |
| RATE-2 | A 耗尽共享 worker pool，观察 B 的 lease claim 是否被饿死 | B 仍能在 SLA 内 claim；或每租户 worker 隔离生效 | §7 |
| RATE-3 | `bench-tenant-concurrency` 在真实 kernel PG 上重跑（to-90-plan §10 L190 `passed=false`） | `passed=true`；`errors=0`；day-over-day drift gate 通过 | §7, D.3 §16 |

### 4.5 审计隔离（关闭 D.1 §8 + D.2 §10）

| 用例 ID | 攻击向量 | 期望 | 关闭声明 |
|---|---|---|---|
| AUDIT-1 | A 查询审计日志 API，尝试看到 B 的安全事件 | 仅返回 A 的事件；B 的事件不可见 | §8 |
| AUDIT-2 | A 尝试篡改自己的审计条目（重写、删除、尾部截断） | HMAC + 非对称签名校验失败；告警；`verify()` 在定时器上发现 | D.2 §10 |
| AUDIT-3 | 整链删除尝试（信任审计 KC-5：无 chain registry） | 全局签名 chain manifest 发现缺失；校验失败 | D.2 §10 |
| AUDIT-4 | 审计写入失败时 effect 是否继续（信任审计 KC-5：async fail-open） | fail-closed：审计写入失败即阻止该 effect | D.2 §10 |
| AUDIT-5 | compliance 报告尝试从 reporter 自身声明 `tamperProof:true`（KC-5） | 报告必须从 live `verify()` 结果派生；硬编码被门禁拒绝 | D.2 §10, §13 |

---

## 5. 密钥路径证明方案

目标：全链路证明任何 secret 不经过 `process.env.<X>_API_KEY` 或非 Vault 存储；负向用例验证环境变量注入尝试被拒绝。

### 5.1 静态扫描

`scripts/ws9-keypath-scan.ts`（新建）扫描代码库与构建产物：

- 禁止模式：`process.env.OPENAI_API_KEY`、`process.env.*_API_KEY`、`process.env.*_SECRET`、`process.env.*_TOKEN`（Vault 注入变量 allowlist 除外）、硬编码 key 字面量（`sk-`、`AKIA`、`ghp_` 等，复用 `UniversalSanitizer` PII 模式）。
- 扫描范围：`packages/core/src`、`apps/api/src`、`packages/sdk`、最终构建产物 `dist/`。
- 例外清单：`COMMANDER_VAULT_ADDR`、`COMMANDER_VAULT_TOKEN`、`NODE_ENV`、`COMMANDER_SANDBOX_ISOLATION`、`COMMANDER_LOG_LEVEL` 等，显式登记在 `config/keypath-allowlist.json`。

命中即 `verdict=FAIL`，列出 file:line。

### 5.2 运行时全链路追踪

- 在 `EncryptedSecretsVault` / `secureApiKeyResolver` 注入追踪点：每次 secret 解析记录 `source=vault`、`path=...`、`resolvedAt`、`consumer`，不记录明文。
- 启动时 dump `process.env` 的 key 名（不含值）到审计日志；门禁断言 key 名集合 ⊆ allowlist。
- `keychain.ts` / `authManager.ts` / `keyProvider.ts` 的所有 secret 读取必须经 Vault resolver；直读 `process.env` 触发告警。

### 5.3 负向注入测试

| 用例 ID | 攻击向量 | 期望 | 关闭声明 |
|---|---|---|---|
| KEY-1 | 设置 `OPENAI_API_KEY=sk-...` 启动生产 | 启动拒绝或该 key 不被 resolver 使用；告警「env-held key rejected」 | D.2 §12 |
| KEY-2 | 设置 `ANTHROPIC_API_KEY` 并发起 LLM 调用 | 调用使用 Vault 解析的 key；env key 被忽略；审计记录 source=vault | D.2 §12 |
| KEY-3 | Vault 不可达时启动 | fail-closed 拒绝启动；不回退到 env key（council L171「env-held keys」） | D.2 §12 |
| KEY-4 | 注入伪造 `COMMANDER_VAULT_TOKEN` | Vault 认证失败即拒绝启动；不降级 | D.2 §12 |
| KEY-5 | memory / audit 存储加密验证（不止 API key） | memory + audit 静态加密启用；`DATA-3` 升级为 live 证据 | D.2 §12, D.2 §14 |

---

## 6. SIEM / WORM 审计签名

依据信任审计 KC-5 L36 与整改项 L259 重写审计链。

### 6.1 事件日志格式

每个安全事件为结构化 JSON，包含：

```json
{
  "eventId": "uuid-v7",
  "seq": 42,
  "chainId": "tenant-a:security",
  "tenantId": "tenant-a",
  "ts": "2026-07-16T08:00:00.123Z",
  "eventType": "tool.execute | effect.admit | auth.login | data.delete | sandbox.deny",
  "actor": { "subject": "oidc-sub", "tenant": "tenant-a", "capability": "..." },
  "resource": { "type": "run", "id": "run_123", "tenant": "tenant-a" },
  "decision": "allow | deny",
  "requestHash": "sha256(canonicalJson(request))",
  "policyDecisionId": "pd_...",
  "prevHash": "sha256(prevEvent)",
  "hmac": "hmac-sha256(canonicalJson(eventWithoutHmac), chainKey)",
  "kmsSig": "rsa-pss-sha256(canonicalJson(eventWithoutKmsSig), kmsKey)"
}
```

`prevHash` 形成链；`chainId` 每租户独立，杜绝跨租户链混淆。

### 6.2 完整性签名（双层）

- **L1 HMAC-SHA256**（链内）：每条事件即时签名，复用 `IntegrityLayer`（`securityPrimitives.ts`）。chainKey 每租户独立，由 Vault 派生。
- **L2 非对称签名**（外部锚定）：每 N 条事件或每 T 秒，由 KMS/HSM（生产）或本地非对称 key（仅 CI 模拟，不得作 enterprise 证据，90-decisions D2 L20）对链头 `{chainId, maxSeq, headHmac}` 签名，写入全局 chain manifest。

### 6.3 不可篡改存储

- **WORM sink**：事件流式写入 S3 Object-Lock（WORM 模式）或等效目录（CI 用只追加 + 不可重写文件模拟，明确标注 `evidenceLevel=ci-worm-sim`，不得充当 SOC 证据）。
- **全局 chain manifest**：每条链的 `{chainId, maxSeq, headHmac, kmsSig}` 登记到外部锚定的 transparency log；缺失即视为整链删除/截断，校验失败。
- **密钥分离**：HMAC chainKey 与非对称 KMS key 与日志存储物理分离，杜绝 app/insider 重 forge（KC-5 L36）。

### 6.4 校验与告警

- `verify()` 在定时器上运行（默认 60s），核对每条事件的 HMAC、链连续性、manifest 一致性。
- 任何校验失败：告警（SLA 通知通道，遵循 sanitization 规则），事件标 `verified=failed`，绝不标 `tamperProof:true`。
- **fail-closed 持久化**：审计写入失败即阻止对应 effect（KC-5「async fail-open」整改）。

### 6.5 篡改测试

| 用例 ID | 篡改手法 | 期望 |
|---|---|---|
| TAMPER-1 | 修改某事件字段 | HMAC 校验失败 |
| TAMPER-2 | 删除尾部 N 条 | manifest headHmac 不匹配 |
| TAMPER-3 | 整链删除 | manifest 缺失该 chainId |
| TAMPER-4 | 重 forge HMAC（用同机 chainKey） | chainKey 在 Vault/KMS，app 无明文访问；重 forge 失败 |
| TAMPER-5 | 关闭审计写入后执行 effect | effect 被阻止（fail-closed） |

---

## 7. 合规证据包（SOC 2 Type II 控制点）

WS9 不签发 SOC 2 Type II 报告（需外部审计师 ≥3 个月观察期，ENTERPRISE_READINESS.md SOC2-5）。WS9 产出的是**控制点自动化证据包**，供外部审计师抽样核验。证据包由 `scripts/ws9-compliance-evidence.ts`（新建）从 live 测试结果派生，写入 `docs/baselines/ws9/compliance-evidence/`。

| 控制点 | SOC 2 CC | 自动化证据来源 | 关闭声明 |
|---|---|---|---|
| 访问控制（RBAC + capability token + 租户主体） | CC6.1, CC6.6 | DATA-2（头伪造拒绝）、EXEC-4（capability）、KEY-* 证据 | D.1 §2, D.2 §12 |
| 变更管理（生产构建静态门禁） | CC8.1 | EXEC-3 host-exec 门禁、KEY 静态扫描、boot-refuse 证据 | D.1 §3 |
| 逻辑访问（RLS + 非 owner role） | CC6.7 | DATA-1/3/4、§3.2 env-check | D.1 §1, D.2 §15 |
| 事件响应（fail-closed + 告警） | CC7.3, CC7.4 | TAMPER-*、AUDIT-4、EXEC-5 | D.2 §10 |
| 审计日志完整性 | CC7.2 | TAMPER-*、§6 verify() 证据 | D.2 §10 |
| 数据保留与删除 | CC5.2, CC7.1 | DATA-5 GDPR Art 17 live、`dr-backup-restore` 演练 | D.2 §14 |
| 密钥管理 | CC6.1 | KEY-* 证据、§5 全链路追踪 | D.2 §12 |
| 网络隔离 | CC6.6 | NET-* | D.1 §3 |
| 配置管理（部署 chart 强制 role） | CC7.1, CC8.1 | §3.2 非 owner role CI 门禁 | D.2 §15 |

**证据包格式**：每个控制点一个 JSON，含 `controlId`、`evidenceLevel=live`、`testCaseIds`、`verdict`、`artifactPaths`（构建 SHA + baseline 路径 + 日志路径）、`collectedAt`、`verifiedBy=ws9-livefire`。`verdict=FAIL` 的控制点不得标「合规」。

**诚实规则**：证据包头部声明「本包为控制点证据，不等于 SOC 2 Type II 报告；报告需外部审计师出具」。compliance reporter 不得从自身派生 `tamperProof`/`compliant`（KC-5、WS8 L36）。

---

## 8. 就绪度矩阵（ENTERPRISE_READINESS.md 更新规则）

Phase 3 完成后，按以下规则更新 `ENTERPRISE_READINESS.md` 与 `.internal/docs/status/ENTERPRISE_READINESS.md`。**删除未验证声明，标注已验证能力，不新增未证据化的 ✅。**

| 现条目 | 现状 | WS9 后处置 | 依据 |
|---|---|---|---|
| SOC2-1（AES-256-GCM Vault） | ✅ | 升级证据为 `evidenceLevel=live`（KEY-* 通过后）或降 🟡（若 KEY-1/3 失败） | D.2 §12 |
| SOC2-2（tamper-evident audit chain） | ✅ | **降为 🟡** 直到 TAMPER-* + §6 全部 live 通过；当前 `verify()` 从不调用，属 overclaim（KC-5） | D.2 §10 |
| SOC2-3（RBAC + capability token） | ✅ | 维持，补 EXEC-4 live 证据 | D.1 §5 |
| SOC2-4（mTLS） | ✅ | 维持，不在 WS9 范围 | — |
| SOC2-5（SOC 2 Type II 报告） | ❌ | 维持 ❌；补「控制点证据包已就绪，待外部审计师」 | D.2 §9 |
| SOC2-6 / TEN-3（cross-tenant fuzz） | ✅ | **改为 🟡 并重写证据描述**：「simulated fuzz harness，非 SOC 证据；live 证据见 WS9 DATA-*」；新增 `TEN-3-LIVE` ✅ 行指向 WS9 baseline（若通过） | D.3 §16 |
| TEN-1/TEN-2/TEN-4 | 🟡/🟡/✅ | 按 WS9 结果升降；TEN-2 维持 🟡 直到真实 PG per-tenant 落地 | D.1 §1, §2 |
| DATA-1（GDPR Art 17） | ✅ | 补 DATA-5 live 证据 | D.2 §14 |
| DATA-2（DPA） | ❌ | 维持 ❌ | D.2 §11 |
| DATA-3（memory+audit 加密） | 🟡 | 按 KEY-5 结果升级或维持 | D.2 §12 |
| DATA-4（DR runbook） | ❌/🟡 | 维持直到真实 PG 恢复演练；WS9 不签发 | D.2 §14 |
| P2-3（合规 reporter） | ✅ | 重写为「reporter 存在；认证未取得；不得声明合规」 | D.2 §13 |
| Multi-tenancy 段「Alpha」说明 | — | 补「live-fire 证据见 WS9；simulated 不再作为 SOC 证据」 | D.3 §16 |

**新增行**：`TEN-3-LIVE`、`SOC2-2-LIVE`、`AUDIT-WORM`、`KEYPATH-VAULT`，全部带 `evidenceLevel=live` 与 WS9 baseline 路径。

---

## 9. 证据等级与诚实规则

依据 90-decisions D3/D4 与 WS8 公开安全规则。

### 9.1 证据等级

| 等级 | 含义 | 可填充的槽位 |
|---|---|---|
| `live` | built image + 真实 PG + 非 owner role + 多进程/容器 + 真实 failover/篡改 | SOC 控制点、enterprise readiness ✅、尽调证据 |
| `ci-worm-sim` | CI 模拟 WORM/非对称签名（无 KMS/HSM） | 仅开发辅助；不得充 SOC 证据 |
| `simulated` | InMemory predicate / mock | 仅开发辅助；不得充 live/SOC 证据 |

### 9.2 严格基准规则（90-decisions D3 L32–51）

任何 WS9 baseline 满足以下任一即 `verdict=FAIL`，且不得被后续 `summary` 忽略：

- `errors > 0`
- `skipped > 0`
- `passed = false`
- 任何穿越用例 `verdict=breach`
- baseline 陈旧（> 7 天或构建 SHA 不匹配）
- `evidenceLevel != live` 却填充 live/SOC 槽位

day-over-day drift gate：今天 `verdict=FAIL` 或新增穿越用例即阻断 CI。

### 9.3 反 overclaim 门禁

`scripts/ws9-honesty-gate.ts`（新建）扫描 `ENTERPRISE_READINESS.md`、`README*`、`docs/`、compliance 报告：

- 任何 `evidenceLevel` 与声明等级不匹配（如 simulated 充 ✅）即失败。
- 任何 `tamperProof:true`/`compliant:true` 非来自 live `verify()` 即失败。
- 任何「multi-tenant」声明未指向 WS9 live baseline 即降级为 Alpha 表述。

---

## 10. 实现边界与测试计划

### Phase 1：Spec（本文档）

- 本文档作为唯一 WS9 验收基线。
- 评审通过后才能进入改造。

### Phase 2：Build

- 搭建 §3 隔离环境（docker-compose + 真实 PG + Vault + gVisor + /v1 收口）。
- 实现 `ws9-env-check.ts`、`ws9-keypath-scan.ts`、`ws9-livefire.ts`、`ws9-compliance-evidence.ts`、`ws9-honesty-gate.ts`。
- 实现审计链 §6 重写：双层签名、WORM sink、chain manifest、`verify()` 定时器、fail-closed 持久化。
- 实现 §4 实弹套件：DATA/EXEC/NET/RATE/AUDIT 五类，先写失败测试再实现最小修复。
- 实现 §5 密钥路径：静态扫描、运行时追踪、负向注入。
- 收集 §7 合规证据包，生成报告模板。
- TDD：每条用例先 FAIL 后 PASS；frequent commits。

### Phase 3：Review & Audit

- 运行全部实弹测试，**0 穿越为通过**；任何穿越即 `verdict=FAIL` 并阻断。
- 验证密钥路径：Vault 路径外无密钥泄露；负向测试正确拒绝。
- 验证 SIEM 审计签名：篡改日志导致签名校验失败；`verify()` 定时器告警。
- 邀请外部安全审计人员对测试套件与方法论 review（review 记录入 `.internal/docs/audits/`）。
- 确认 ENTERPRISE_READINESS.md 中所有声明有对应自动化测试证据；按 §8 更新矩阵。
- 逐条验收 §11 清单后，本文档标记 `ACCEPTED`。

---

## 11. 验收清单

### 跨租户实弹
- [ ] §3 隔离环境就绪门禁通过（真实 PG 非 owner + RLS WITH CHECK + Vault + gVisor + /v1 收口）。
- [ ] DATA-1..6 全部 0 穿越且 `evidenceLevel=live`。
- [ ] EXEC-1..5 全部 0 穿越且 `evidenceLevel=live`。
- [ ] NET-1..3 全部 0 穿越且 `evidenceLevel=live`。
- [ ] RATE-1..3 全部 0 穿越且 `evidenceLevel=live`；`bench-tenant-concurrency` 在真实 kernel PG `passed=true`。
- [ ] AUDIT-1..5 全部 0 穿越且 `evidenceLevel=live`。

### 密钥路径
- [ ] §5.1 静态扫描 0 命中（allowlist 外）。
- [ ] §5.2 运行时追踪显示所有 secret `source=vault`。
- [ ] KEY-1..5 负向注入全部被拒绝/告警且 `evidenceLevel=live`。

### SIEM / WORM
- [ ] §6.1 事件格式落地，含 `prevHash`/`hmac`/`kmsSig`/`chainId`。
- [ ] §6.2 双层签名（HMAC + 外部锚定非对称）生效。
- [ ] §6.3 WORM sink + chain manifest 落地；密钥与日志物理分离。
- [ ] §6.4 `verify()` 定时器运行；fail-closed 持久化生效。
- [ ] TAMPER-1..5 篡改测试全部被检测且 `evidenceLevel=live`。

### 合规证据
- [ ] §7 控制点证据包生成，全部 `verdict=PASS` 且 `evidenceLevel=live`。
- [ ] 证据包头部声明「非 SOC 2 Type II 报告」。
- [ ] §9.3 honesty-gate 在 CI 通过。

### 就绪度矩阵
- [ ] §8 ENTERPRISE_READINESS.md 更新规则逐条执行；未验证声明已删除/降级。
- [ ] 新增 `TEN-3-LIVE`/`SOC2-2-LIVE`/`AUDIT-WORM`/`KEYPATH-VAULT` 行带 live baseline 路径。
- [ ] `pnpm check:readiness` 通过新 baseline schema 校验。

### 流程
- [ ] 外部安全审计 review 记录入档。
- [ ] 审计完成后本文档标记 `ACCEPTED`，作为 $50M 尽调核心安全证据。
