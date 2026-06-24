# Commander 修复任务包 — 按难度 x 重要程度分包

> **目标**: 将审计发现的 28 个模块问题拆分为可并行的独立任务包
> **分包原则**: 每个包可分配给不同开发者/小组，包内无外部依赖
> **难度定义**: Easy(<1天) Medium(1-3天) Hard(1-2周) VeryHard(2周+)
> **优先级回顾**: P0(阻断发布) P1(必须修复) P2(应该修复) P3(锦上添花)

---

## 任务包总览

```
                    难度
              Easy   Medium   Hard   Very Hard
           ┌──────┬────────┬───────┬──────────┐
    P0     │  Pkg1 │        │       │  Pkg3    │
           │  Pkg15│        │       │          │
    P      ├──────┼────────┼───────┼──────────┤
    重     │  Pkg4 │  Pkg6  │ Pkg12 │          │
    P1     │       │  Pkg13 │       │          │
    要     ├──────┼────────┼───────┼──────────┤
    程     │ Pkg11 │ Pkg8  │ Pkg7  │          │
    P2     │       │ Pkg9  │       │          │
    度     │       │ Pkg10 │       │          │
           ├──────┼────────┼───────┼──────────┤
    P3     │       │ Pkg14 │       │          │
           └──────┴────────┴───────┴──────────┘
```

---

## P0 阻断器（Launch Blockers）

### 任务包 1: 紧急安全与健康检查修复
**难度**: Easy-Medium ⚡ | **重要性**: P0 🔴
**预估工时**: 2-3 天
**涉及模块**: Security Module, API Server, Health Check

| ID | 任务 | 文件 | 难度 |
|----|------|------|------|
| 1.1 | **修复正则注入漏洞** | `ultimate/artifactSystem.ts:134` — 用户输入经 `new RegExp()` 时未转义 | Easy |
| 1.2 | **修复健康检查虚假数据** | `runtime/healthCheck.ts` — 5 个 stub("not implemented") 返回 "healthy" | Easy |
| 1.3 | **添加生产速率限制** | `apps/api/src/index.ts` — 添加 express-rate-limit 或 API 网关层 | Medium |
| 1.4 | **添加 SQLite 不可用告警** | `runtime/checkpointStore.ts` — 降级到 in-memory 时必须 log warning | Easy |

**验收标准**:
- [ ] `artifactSystem.ts` 用户输入被 `escapeRegex` 包裹
- [ ] 健康检查端点真实反映: `circuitBreaker.health`, `dlq.size > threshold`, `providers.available`
- [ ] API 服务器 `/health` 和 `/api/*` 路径有速率限制（如 100 req/min）
- [ ] SQLite 初始化失败时日志输出 `WARN: CheckpointStore falling back to in-memory — crash recovery DISABLED`
- [ ] 所有端点的回归测试通过

---

### 任务包 2: 多租户声明修正
**难度**: Medium 🛠️ | **重要性**: P0 🔴
**预估工时**: 2-5 天
**涉及模块**: Multi-Tenancy, TenantContext, TenantAwareSingleton

| ID | 任务 | 文件 | 难度 |
|----|------|------|------|
| 2.1 | **标记所有多租户 API 为 @alpha** | `runtime/tenantContext.ts`, `tenantAwareSingleton.ts`, 所有 index.ts 导出 | Easy |
| 2.2 | **更新文档/README 去除非真实声明** | `README.md`, `ARCHITECTURE.md`, 网站 | Easy |
| 2.3 | **添加存储层隔离警告（运行时）** | 所有 `getGlobal()` 调用站点添加 console.warn | Medium |
| 2.4 | **添加每个租户存储隔离接口**（可选） | 创建 `TenantStore` 接口 + SQLite 每个租户实现 | Hard |

**注意**: 选项 A（2.1-2.3，快速修复）vs 选项 B（2.4，实际修复）。推荐选项 A 用于发布，选项 B 用于后续迭代。

**验收标准**:
- [ ] README 中多租户标注为 `⚠️ Alpha — isolation only, no storage isolation`
- [ ] `getGlobal()` 每次调用在非开发环境输出 `WARN: Global singleton bypass — data not isolated`
- [ ] 所有 `tenantAwareSingleton.ts` 的 TTL 驱逐添加 warning 日志
- [ ] 所有现有测试通过

---

## P1 严重风险

### 任务包 3: AgentRuntime 上帝对象分解
**难度**: Very Hard 🏗️ | **重要性**: P1 🔴
**预估工时**: 4-8 周
**涉及模块**: AgentRuntime（全部核心）

这是整个系统最艰巨的技术债务——4,571 行的 `agentRuntime.ts` 需要分解为 5-8 个独立模块：

| ID | 任务 | 说明 | 难度 |
|----|------|------|------|
| 3.1 | **提取 ProviderRouter** | 所有 provider 选择、fallback、重试逻辑 → `providerRouter.ts` | Medium |
| 3.2 | **提取 ExecutionContext** | `slidingWindow`, `governor`, `tools`, `messages` 等可变状态 → `executionContext.ts` | Medium |
| 3.3 | **提取 LifecycleManager** | init/start/stop/shutdown 逻辑 → `lifecycleManager.ts` | Hard |
| 3.4 | **提取 ToolRegistry** | 工具加载、缓存、执行 → `toolRegistry.ts` | Hard |
| 3.5 | **提取 ErrorHandler** | 110 个 catch 块统一为结构化错误处理 → `errorHandler.ts` | Medium |
| 3.6 | **替换 76 个单例为 DI 容器** | `getX()` → constructor injection via IoC | Very Hard |
| 3.7 | **删除 ~2,500 行死代码引用的导出** | 清理 actor/, inspectorAgent 等引用 | Easy |
| 3.8 | **添加集成测试** | 覆盖新模块的交互 | Hard |

**策略建议**: 增量分解——每个提取保持向后兼容，分支合并不阻塞其他包。

**验收标准**:
- [ ] `agentRuntime.ts` 从 4,571 行减少到 < 1,000 行（协调器角色）
- [ ] 每个新模块有独立测试文件，覆盖率 > 70%
- [ ] 76 个 `getX()` 减少到 < 10 个（仅基础设施级单例）
- [ ] 0 个 `console.warn('[Catch]', err)` —— 全部替换为结构化错误事件
- [ ] 所有现有集成/回归测试通过

---

### 任务包 4: 死代码清理
**难度**: Easy 🧹 | **重要性**: P1 🔴
**预估工时**: 1-2 天
**涉及模块**: actor/, inspectorAgent, frameworkIntegration, adaptiveOrchestrator, company(duplicate)

| ID | 任务 | 文件 | 难度 |
|----|------|------|------|
| 4.1 | **删除 actor/ 目录** | `actor/*.ts` (1,728 行)——完全孤立 | Easy |
| 4.2 | **删除 inspectorAgent.ts** | ~500 行——仅被 frameworkIntegration 引用 | Easy |
| 4.3 | **删除 frameworkIntegration.ts** | 237 行——孤立 | Easy |
| 4.4 | **删除 adaptiveOrchestrator.ts** | 649 行——半孤立 | Easy |
| 4.5 | **删除 tokenBudgetAllocator.ts** | ——半孤立 | Easy |
| 4.6 | **删除重复的 company.ts** | 356 行——`ultimate/companyEngine.ts` 已替代 | Easy |
| 4.7 | **清理 index.ts 导出** | 移除所有已删除文件的 barrel 导出 | Easy |
| 4.8 | **删除 9 个遗留拓扑别名** | `types.ts:102-118` ——迁移窗口活跃 | Easy |

**注意**: `git rm` + 确保无导入断链。运行全量 TypeScript 编译检查。

**验收标准**:
- [ ] 项目编译通过（`tsc --noEmit` exit 0）
- [ ] 减少 ~3,000 行代码
- [ ] 无运行时错误（测试套件通过）
- [ ] docs/dead-code-and-stubs.md 更新为已清理

---

### 任务包 5: 集成测试与 SLO 测量
**难度**: Medium-Hard 🧪 | **重要性**: P1 🔴
**预估工时**: 1-2 周
**涉及模块**: Test Suite, CI Pipeline

| ID | 任务 | 说明 | 难度 |
|----|------|------|------|
| 5.1 | **添加端到端集成测试** | 完整 deliberation→execution→synthesis 流水线 | Hard |
| 5.2 | **添加 SLO 测量 CI** | 恢复 <5s，故障转移 <10s，补偿 <30s，DLQ <60s | Medium |
| 5.3 | **添加负载测试** | 1/5/10/50 并发代理的吞吐量和延迟 | Medium |
| 5.4 | **添加 agentRuntime 可测试性** | 提取接口使 execute() 可 mock | Hard |
| 5.5 | **添加失败注入测试** | provider 故障、SQLite 故障、OOM 模拟 | Medium |

**验收标准**:
- [ ] `tests/e2e/orchestration.test.ts` 覆盖完整流水线
- [ ] CI 报告 SLO 测量值（通过/阈值）
- [ ] 负载测试在 50 个并发代理下 < 500ms P99 延迟
- [ ] agentRuntime.execute() 可通过 mock provider 测试

---

### 任务包 6: 真实监控与可观测性
**难度**: Medium 📊 | **重要性**: P1 🔴
**预估工时**: 3-5 天
**涉及模块**: Health Check, Logging, Observability

| ID | 任务 | 文件 | 难度 |
|----|------|------|------|
| 6.1 | **实现真实熔断器健康检查** | `runtime/healthCheck.ts:107`——读取 circuitBreakerRegistry 实际状态 | Medium |
| 6.2 | **实现真实 DLQ 健康检查** | `runtime/healthCheck.ts:111`——读取 DLQ 大小 | Medium |
| 6.3 | **实现真实补偿健康检查** | `runtime/healthCheck.ts:146`——检查待处理补偿数 | Medium |
| 6.4 | **实现真实 EventBus 健康检查** | `runtime/healthCheck.ts:150`——检查 backlog 深度 | Medium |
| 6.5 | **实现真实 Provider 健康检查** | `runtime/healthCheck.ts:154`——ping 每个已配置 provider | Medium |
| 6.6 | **添加结构化错误关联 ID** | 替换 `console.warn('[Catch]', err)` 为 `logger.error({ correlationId, module, error })` | Medium |
| 6.7 | **添加告警规则文档** | Prometheus 告警规则推荐 + 阈值建议 | Easy |

**验收标准**:
- [ ] `/health/detailed` 返回真实状态（不是 "not implemented"）
- [ ] 当熔断器 OPEN 时健康检查返回 `{ status: 'degraded', circuitBreaker: 'open' }`
- [ ] 当 DLQ > 500 时健康检查返回 `{ status: 'warning', dlqSize: 512 }`
- [ ] 所有 catch 块输出结构化 JSON（含 module, file, line, correlationId）
- [ ] 所有历史测试通过

---

## P2 应该修复

### 任务包 7: Quality Gates 重写
**难度**: Hard 🔬 | **重要性**: P2 🟡
**预估工时**: 1-2 周
**涉及模块**: Synthesizer, Quality Gates

| ID | 任务 | 说明 | 难度 |
|----|------|------|------|
| 7.1 | **用 LLM-as-judge 替换正则质量门** | 一致性/幻觉/完整性门使用 LLM 评估 | Hard |
| 7.2 | **或实现嵌入评估** | 余弦相似度 + 语义阈值作为轻量替代 | Medium |
| 7.3 | **移除假阳性模式** | 取消惩罚 "however"、"might be"、"on the other hand" | Easy |
| 7.4 | **添加质量门测试** | 验证门可以检测真实幻觉 vs 正常语言 | Medium |

**验收标准**:
- [ ] 质量门可以区分"假装知道"和"审慎表达"
- [ ] 已知幻觉样本被标记为 FAIL
- [ ] 正常分析语言（"might indicate"、"suggests that"）标记为 PASS
- [ ] 回归测试通过

---

### 任务包 8: Provider 系统加固
**难度**: Medium 🔌 | **重要性**: P2 🟡
**预估工时**: 3-5 天
**涉及模块**: Provider System, Fallback Chain

| ID | 任务 | 文件 | 难度 |
|----|------|------|------|
| 8.1 | **文档化每个 provider 的能力** | 创建 PROVIDER_CAPABILITIES.md（支持 tool calling、流式、vision 等） | Easy |
| 8.2 | **Perplexity/Replicate 工具调用友好失败** | 提前检测工具要求并给出清晰错误信息 | Medium |
| 8.3 | **添加 provider 超时隔离** | ProviderFallbackChain 每个 provider 独立超时 | Medium |
| 8.4 | **添加 provider 健康检查 ping** | 每个 provider 启动时验证 API 密钥有效性 | Medium |
| 8.5 | **修复薄包装 provider 的能力声明** | 17 行 provider 实际仅继承 baseOpenAICompatible 无额外验证 | Easy |

**验收标准**:
- [ ] PROVIDER_CAPABILITIES.md 被生成且链接自 README
- [ ] 工具调用在 Perplexity/Replicate 上返回清晰错误 "Provider X does not support tool calling. Switch to OpenAI/Anthropic"
- [ ] ProviderFallbackChain 单个 provider 超时不会阻塞整个链
- [ ] `commander init` 验证 API 密钥并报告有效/无效

---

### 任务包 9: 自我优化修复
**难度**: Medium 🤖 | **重要性**: P2 🟡
**预估工时**: 3-5 天
**涉及模块**: Self-Optimization, MetaLearner

| ID | 任务 | 文件 | 难度 |
|----|------|------|------|
| 9.1 | **修复 strategyPerformanceTracker** | `analyzeModelPerformance()` 返回空 Map → 实现真实跟踪 | Medium |
| 9.2 | **添加自我优化集成测试** | 验证在 5 次运行后学习者可以影响策略选择 | Medium |
| 9.3 | **移除浪费的 deliberateWithLLM 调用** | 或使其实际增加价值 | Medium |
| 9.4 | **添加自我优化状态查询** | CLI `commander status --meta` 显示学习进度 | Easy |

**验收标准**:
- [ ] `analyzeModelPerformance()` 在 5+ 次运行后返回非空数据
- [ ] Thompson Sampling 在有足够数据时选择不同于默认的拓扑
- [ ] `deliberateWithLLM` 被移除或真正用于分类
- [ ] `commander status --meta` 报告经验计数和当前 epsilon

---

### 任务包 10: 延迟与性能优化
**难度**: Medium ⚡ | **重要性**: P2 🟡
**预估工时**: 3-7 天
**涉及模块**: SubAgentExecutor, Orchestrator, Sync I/O

| ID | 任务 | 文件 | 难度 |
|----|------|------|------|
| 10.1 | **添加 SubAgentExecutor 背压** | 队列大小限制 + 背压信号给调用者 | Medium |
| 10.2 | **移动同步 I/O 到 worker threads** | `metaLearnerPersistence.ts`, `explorationEventLog.ts`, `harnessInfrastructure.ts` | Hard |
| 10.3 | **使原子化器自适应** | ASPECT 步数基于复杂度估算而非固定 3/4 | Medium |
| 10.4 | **移除 dead code 的同步 I/O** | 死代码清理后自然移除 | Easy |
| 10.5 | **限制 activeExecutions Map 大小** | 防止无限增长 OOM | Easy |

**验收标准**:
- [ ] SubAgentExecutor 队列达到 `maxParallel * 2` 时拒绝任务
- [ ] `fs.existsSync`/`fs.mkdirSync`/`fs.appendFileSync` 从热路径移除
- [ ] ASPECT 对简单任务产生 2-3 步，对复杂任务产生 5-8 步
- [ ] activeExecutions 达到 100 时返回错误而非 OOM

---

### 任务包 11: 配置与文档清理
**难度**: Easy 📝 | **重要性**: P2 🟡
**预估工时**: 1-2 天
**涉及模块**: CLI, Schema, README

| ID | 任务 | 文件 | 难度 |
|----|------|------|------|
| 11.1 | **同步 topology 枚举** | `commander.schema.json` v1 与运行时 14 值类型 | Easy |
| 11.2 | **CLI init 自动创建 .env** | `.env.example` → `.env` 复制 + 提示用户设置 | Easy |
| 11.3 | **更新 README 功能状态** | 标注哪些功能是 alpha/beta/stable | Easy |
| 11.4 | **添加每个 provider 的能力文档** | 参见包 8.1 | Easy |
| 11.5 | **清除过时的 ARCHITECTURE.md 声明** | 匹配实际实现 | Easy |

**验收标准**:
- [ ] `commander init` 创建 `.env` + 提示设置至少一个 API 密钥
- [ ] Schema 验证不因 topology 值而失败
- [ ] README 清晰标注每个功能的开发状态

---

### 任务包 12: 沙箱与插件系统
**难度**: Hard 🔒 | **重要性**: P1-P2 🟡🔴
**预估工时**: 2-3 周
**涉及模块**: Sandbox, Plugin System

| ID | 任务 | 文件 | 难度 |
|----|------|------|------|
| 12.1 | **实现代码执行沙箱** | `sandbox/appContainer.ts`——容器或子进程隔离 | Hard |
| 12.2 | **实现 TEE 并行执行** | 移除 `TODO(v2): CID pool for concurrent Nitro execution` | Hard |
| 12.3 | **完成插件系统集成** | 插件钩子 → 主执行路径 | Hard |
| 12.4 | **添加插件沙箱** | `plugin-sdk/sandbox.ts` | Hard |
| 12.5 | **更新 sandboxVerifier** | 移除 `placeholder for memory/CPU enforcement checks` | Medium |

**验收标准**:
- [ ] 代码执行在隔离容器/进程中运行
- [ ] 插件可以注册 LLM 和工具钩子
- [ ] TEE 并行执行支持并发 Nitro 会话
- [ ] sandboxVerifier 实际强制执行内存/CPU 限制

---

### 任务包 13: SLO 测量基础设施
**难度**: Medium 📏 | **重要性**: P1-P2 🟡🔴
**预估工时**: 3-5 天
**涉及模块**: CI, Benchmark, Checkpoint

| ID | 任务 | 文件 | 难度 |
|----|------|------|------|
| 13.1 | **建立 checkpoint 恢复 SLO 测量** | 测量从 crash 到恢复的时间 | Medium |
| 13.2 | **建立故障转移 SLO 测量** | provider 故障到下一个 provider | Medium |
| 13.3 | **建立补偿 SLO 测量** | 失败突变到回滚完成 | Medium |
| 13.4 | **建立 DLQ 处理 SLO 测量** | 错误检测到持久化条目 | Medium |
| 13.5 | **整合到 CI 门控** | SLO 超出阈值 → CI 失败 | Medium |

**验收标准**:
- [ ] CI 中每个提交测量并报告 SLO
- [ ] SLO 阈值在 `ci.yml` 中可配置
- [ ] 超出阈值的 PR 被标记为性能退化

---

### 任务包 14: 存储与持久化加固
**难度**: Easy-Medium 💾 | **重要性**: P2-P3 🟡🟢
**预估工时**: 2-4 天
**涉及模块**: CheckpointStore, DLQ, Memory

| ID | 任务 | 文件 | 难度 |
|----|------|------|------|
| 14.1 | **添加 WAL 日志轮转** | `checkpointStore.ts`——WAL 超过 100MB 时归档 | Medium |
| 14.2 | **添加 DLQ ndjson 轮转** | `deadLetterQueue.ts`——每日或 10MB 轮转 | Medium |
| 14.3 | **添加 checkpointStore 连接池** | 复用 SQLite 连接而非每次新建 | Medium |
| 14.4 | **统一 memory/ 和 selfEvolution/ 存储** | 合并两个内存系统 | Hard |
| 14.5 | **添加 Saga store 持久化警告** | 内存模式生产部署时警告 | Easy |

**验收标准**:
- [ ] WAL 文件超过 100MB 时自动触发 checkpoint + 截断
- [ ] DLQ ndjson 每天或达到 10MB 时轮转
- [ ] CheckpointStore 复用 SQLite 连接（5+ 并发共享 1 连接）
- [ ] 生产部署使用内存 Saga store 时日志警告

---

### 任务包 15: 基础设施与 CI/CD 加固
**难度**: Easy-Medium 🔧 | **重要性**: P0-P3 🏗️
**预估工时**: 2-4 天
**涉及模块**: Docker, CI/CD, Deployment

| ID | 任务 | 文件 | 难度 |
|----|------|------|------|
| 15.1 | **修复 Windows 构建** | `ci.yml`——减少 MSVC 变通方案 | Medium |
| 15.2 | **验证 CD 目标** | `cd.yml`——部署目标存在且可访问 | Easy |
| 15.3 | **添加 Docker Compose 生产检查** | 确保 `docker-compose.prod.yml` 可以在新机器上启动 | Easy |
| 15.4 | **添加告警规则** | PrometheusRule CRD 或文档化推荐规则 | Medium |
| 15.5 | **添加 `.env` 不存在时友好错误** | `cli.ts`——检测并建议 `commander init` | Easy |

**验收标准**:
- [ ] CI 在 Windows + Node 20/22 上通过
- [ ] CD 工作流成功部署到目标环境
- [ ] `docker-compose.prod.yml` 一键启动
- [ ] 没有 API 密钥时 CLI 输出 "Run 'commander init' to set up"

---

## 分包建议（按开发者团队分配）

### 单人/小团队并行方案

```
Week 1            Week 2            Week 3            Week 4
┌─────────────────┬─────────────────┬─────────────────┬─────────────────┐
│ 开发者 A: Pkg1  │ Pkg6            │ Pkg11           │ Pkg14           │
│ (紧急安全+健康)  │ (监控+可观测性)  │ (配置+文档)      │ (存储加固)      │
├─────────────────┼─────────────────┼─────────────────┼─────────────────┤
│ 开发者 B: Pkg4  │ Pkg8            │ Pkg9+Pkg10      │ Pkg13           │
│ (死代码清理)     │ (Provider加固)   │ (自我优化+性能)  │ (SLO测量)       │
├─────────────────┼─────────────────┼─────────────────┼─────────────────┤
│ 开发者 C: Pkg3  │ Pkg3            │ Pkg3            │ Pkg3            │
│ (AgentRuntime)  │ (AgentRuntime)  │ (AgentRuntime)  │ (AgentRuntime)  │
├─────────────────┼─────────────────┼─────────────────┼─────────────────┤
│ 开发者 D: Pkg2  │ Pkg5            │ Pkg7            │ Pkg12           │
│ (多租户声明)     │ (集成测试)       │ (质量门重写)     │ (沙箱+插件)     │
├─────────────────┼─────────────────┼─────────────────┼─────────────────┤
│ 开发者 E: Pkg15 │ Pkg15           │ 文档+验证       │ 发布准备        │
│ (基础设施)       │ (CD验证)        │                 │                 │
└─────────────────┴─────────────────┴─────────────────┴─────────────────┘
```

### 推荐启动顺序

| 阶段 | 包 | 原因 |
|------|----|------|
| **Phase 0** (Day 1-2) | Pkg1 + Pkg2 | P0 阻断器——必须先修 |
| **Phase 1** (Week 1-2) | Pkg4 + Pkg6 + Pkg15 | 高杠杆低风险清理 |
| **Phase 1** (Week 1-4) | Pkg3 (并行) | 最艰巨但工期最长 |
| **Phase 2** (Week 2-3) | Pkg5 + Pkg8 + Pkg9 | 测试和 Provider 加固 |
| **Phase 3** (Week 3-4) | Pkg7 + Pkg10 + Pkg12 | 质量门和沙箱 |
| **Phase 4** (Week 4+) | Pkg11 + Pkg13 + Pkg14 | 文档和尾期加固 |

---

## 快速参考：每个包的最小信息

| 包 | 名称 | 难度 | 重要性 | 工时 | 开发者 |
|----|------|------|--------|------|--------|
| **Pkg1** | 紧急安全+健康检查修复 | Easy-Medium | ⛔ P0 | 2-3d | 任何人 |
| **Pkg2** | 多租户声明修正 | Medium | ⛔ P0 | 2-5d | 任何 TS 开发者 |
| **Pkg3** | AgentRuntime 上帝对象分解 | Very Hard | 🔴 P1 | 4-8w | 高级工程师 |
| **Pkg4** | 死代码清理 | Easy | 🔴 P1 | 1-2d | 任何人 |
| **Pkg5** | 集成测试与 SLO 测量 | Medium-Hard | 🔴 P1 | 1-2w | 测试/QA 工程师 |
| **Pkg6** | 真实监控与可观测性 | Medium | 🔴 P1 | 3-5d | DevOps/后端 |
| **Pkg7** | Quality Gates 重写 | Hard | 🟡 P2 | 1-2w | ML/AI 工程师 |
| **Pkg8** | Provider 系统加固 | Medium | 🟡 P2 | 3-5d | 后端工程师 |
| **Pkg9** | 自我优化修复 | Medium | 🟡 P2 | 3-5d | ML/AI 工程师 |
| **Pkg10** | 延迟与性能优化 | Medium | 🟡 P2 | 3-7d | 高级工程师 |
| **Pkg11** | 配置与文档清理 | Easy | 🟡 P2 | 1-2d | 任何人 |
| **Pkg12** | 沙箱与插件系统 | Hard | 🔴🟡 P1-P2 | 2-3w | 安全+后端 |
| **Pkg13** | SLO 测量基础设施 | Medium | 🔴🟡 P1-P2 | 3-5d | DevOps |
| **Pkg14** | 存储与持久化加固 | Easy-Medium | 🟡🟢 P2-P3 | 2-4d | 后端工程师 |
| **Pkg15** | 基础设施与 CI/CD 加固 | Easy-Medium | ⛔-🟢 P0-P3 | 2-4d | DevOps |
