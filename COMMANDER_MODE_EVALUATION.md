# Commander 模式评鉴报告

**评鉴者身份**: 真实用户，使用 mimo-v2.5-pro 模型
**评鉴任务**: 跨文件代码分析（需要读取多个文件、理解依赖关系、生成报告）
**评鉴日期**: 2026-05-31

## 评鉴结果

| 模式 | 状态 | 耗时 | Tokens | 质量 | 核心问题 |
|------|------|------|--------|------|----------|
| `plan` | ❌ 失败 | 33s | 0 | - | LLM 规划超时 45s，回退启发式 |
| `run` | ❌ 失败 | 130s | 0 | - | LLM 规划超时，预算超限 |
| `company` | ✅ 成功 | ~30s | 3,416 | 97% | SQLite schema 错误但完成 |
| `drive` | ✅ 成功 | 239s | 41,136 | 好 | 3 迭代，逐步执行 |
| `workers` | ✅ 成功 | 72s | 23,318 | 好 | 2 worker 并行 |
| `goal` | ⏳ 运行中 | - | - | - | 多轮收敛循环 |
| `swarm` | ⏳ 运行中 | - | - | - | 递归分治 |
| `watch` | 未测 | - | - | - | 同 run + SSE |
| `review` | ⏳ 运行中 | - | - | - | 代码审查专用 |
| `workflow` | 未测 | - | - | - | 工作流编排 |
| `benchmark` | 未测 | - | - | - | A/B 测试 |

## 关键发现

### 1. LLM 规划是瓶颈
`plan` 和 `run` 模式都因为 LLM 规划步骤超时而失败。mimo 模型在 deliberation 阶段需要 45+ 秒，超过了超时限制。这不是模式本身的问题，而是规划步骤对慢模型不友好。

### 2. 功能重叠严重
- `run` vs `watch` vs `company` — 都是执行模式，区别仅在于输出方式
- `goal` vs `swarm` vs `drive` — 都是多轮迭代模式，区别在于收敛策略
- `plan` vs `run` — plan 只是 run 的预览版

### 3. 真正有独特价值的模式
- **`company`** — 唯一支持质量门控 + 能力匹配的模式
- **`workers`** — 唯一支持真正的并行研究
- **`drive`** — 唯一支持自主逐步执行
- **`review`** — 唯一专门用于代码审查的模式
- **`swarm`** — 唯一支持递归分治的模式

### 4. 可以合并的模式
- `plan` + `run` → 合并为 `run --dry-run`
- `watch` → 合并为 `run --stream`
- `goal` → 合并到 `drive --mode=goal`
- `workflow` → 合并到 `company`

## 推荐保留的 5 种模式

### 1. `run` (核心执行模式)
- 合并 `plan`（`--dry-run` 标志）
- 合并 `watch`（`--stream` 标志）
- 合并 `goal`（`--mode=goal` 标志）
- 用法: `commander run "task" [--dry-run] [--stream] [--mode=goal|balanced|fast]`

### 2. `company` (企业级执行)
- 保留质量门控 + 能力匹配 + 记忆
- 合并 `workflow`（工作流是 company 的子功能）
- 用法: `commander company "task" [--workflow=id]`

### 3. `swarm` (递归分治)
- 保留递归分解 + 并行执行 + 合并
- 适合大型复杂任务
- 用法: `commander swarm "task" [--depth=3] [--workers=10]`

### 4. `drive` (自主执行)
- 保留逐步自主执行
- 适合需要探索的任务
- 用法: `commander drive "task" [--mode=auto|supervised] [--iterations=20]`

### 5. `review` (代码审查)
- 保留专用的代码审查流程
- 适合 PR review、commit review
- 用法: `commander review [--commit] [--branch] [--json]`

## 删除的模式

| 删除 | 替代方案 | 原因 |
|------|----------|------|
| `plan` | `run --dry-run` | 只是预览，不值得独立命令 |
| `watch` | `run --stream` | 只是 SSE 输出，不值得独立命令 |
| `goal` | `drive --mode=goal` | 与 drive 功能重叠 |
| `workers` | `swarm --mode=parallel` | 并行是 swarm 的子功能 |
| `workflow` | `company --workflow` | 工作流是 company 的子功能 |
| `benchmark` | `run --benchmark` | 测试工具，不值得独立命令 |

## 保留后的命令结构

```
commander run "task"              # 核心执行
commander run "task" --dry-run    # 只看计划
commander run "task" --stream     # 实时输出
commander run "task" --mode=goal  # 多轮收敛

commander company "task"          # 企业级执行
commander company "task" --workflow=id  # 工作流

commander swarm "task"            # 递归分治
commander swarm "task" --depth=3 --workers=10

commander drive "task"            # 自主执行
commander drive "task" --mode=supervised

commander review --commit         # 代码审查
commander review --branch

commander config                  # 配置管理
commander doctor                  # 诊断
commander mode                    # 审批模式
commander history                 # 历史记录
commander skill                   # 技能管理
```

从 11 种模式精简到 5 种，减少 55% 的认知负担，同时保留所有核心功能。
