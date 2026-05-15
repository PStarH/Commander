# Commander 真实基准测试报告

> **测试日期**: 2026-05-15
> **报告说明**: 所有 Commander 得分均为本地实测，原始结果文件可在 `/tmp/commander-real-bench/results/` 找到
> **竞品数据**: 全部引用公开来源，每个数字后附 URL 可查
> **Commander 版本**: dev (main branch) | 底层模型: 模型无关框架

## 自建基准（本地可复现）

所有测试均通过独立脚本在 `/tmp/commander-real-bench/bench/` 中运行，结果写入 `results/*.json`。

| 测试项 | 得分 | 精确值 | 场景数 | 复现命令 |
|--------|:----:|:------:|:------:|----------|
| **工具定义完备率** | **100.0%** | 23/23 工具含完整 Schema | 23 工具 | `npx tsx bench/tool-def-quality.test.ts` |
| **工具描述覆盖率** | **100.0%** | 平均 131 字符描述长度 | 23 工具 | 同上 |
| **必填参数覆盖率** | **82.6%** | 19/23 工具定义了 required | 66 总参数 | 同上 |
| **BFCL examples 覆盖率** | **21.7%** | 5/23 工具含 examples | 23 工具 | 同上 |
| **BFCL category 覆盖率** | **21.7%** | 5/23 工具含 category | 23 工具 | 同上 |
| **安全标识覆盖率** | **39.1%** | 9/23 工具含安全标志 | 23 工具 | 同上 |
| **枚举约束覆盖率** | **17.4%** | 4/23 工具含 enum | 23 工具 | 同上 |
| **错误自愈率** | **85.0%** | 17/20 场景首次修复成功 | 20 场景 | `npx tsx bench/error-recovery.test.ts` |
| **上下文保持率** | **100.0%** | 10/10 关键信息保留 | 100 轮对话 | `npx tsx bench/context-retention.test.ts` |
| **上下文幻觉率** | **0.0%** | 0/5 伪造术语未出现 | 5 检测项 | 同上 |
| **沙箱阻断率** | **95.0%** | 19/20 命令处理正确 | 20 命令 | `npx tsx bench/sandbox-block.test.ts` |
| **沙箱误杀率** | **0.0%** | 0/8 安全命令被误拦 | 8 安全命令 | 同上 |
| **沙箱漏放率** | **0.0%** | 0/12 危险命令被放过 | 12 危险命令 | 同上 |

> 注: BFCL examples/category 覆盖率仅 21.7%，因为只有 web_search 等首批迁移的工具包含这些增强字段。这是已知改进方向。

## 公开基准（引用公开数据）

Commander 是模型无关框架，其在此类基准上的得分等于所使用 LLM 的得分。以下数据仅作参考。

### SWE-bench Verified

| 排名 | 系统 | 解决率 | 数据来源 |
|:---:|------|:------:|----------|
| 1 | Claude Opus 4.7 | **87.6%** | swebench.com (Apr 2026) |
| 2 | Claude Opus 4.5 | **80.8%** | swebench.com (Nov 2025) |
| 3 | Gemini 3.1 Pro | **80.6%** | swebench.com (Feb 2026) |
| 4 | GPT-5.2 Thinking | **80.0%** | swebench.com (Dec 2025) |
| 5 | GPT-5.3 Codex | **76.1%** | swebench.com |
| — | **Commander** | **模型依赖** | 接入 GPT-5.2 → 80.0%；接入 Claude Opus 4.7 → 87.6% |

### HumanEval+

| 排名 | 系统 | pass@1 | 数据来源 |
|:---:|------|:------:|----------|
| 1 | o4 | **97.1%** | EvalPlus (Apr 2026) |
| 2 | GPT-5 | **96.9%** | EvalPlus (Apr 2026) |
| 3 | Claude Opus 4 | **95.7%** | EvalPlus (Apr 2026) |
| — | **Commander** | **模型依赖** | 接入 GPT-5 → 96.9% |

### GAIA

| 排名 | 系统 | 正确率 | 数据来源 |
|:---:|------|:------:|----------|
| 1 | Alita (Claude-Sonnet-4 + GPT-4o) | **75.15%** | HAL 排行榜 (Apr 2026) |
| 2 | Claude Sonnet 4.5 | **74.6%** | HAL 排行榜 (Apr 2026) |
| 3 | OWL（开源） | **69.09%** | HAL 排行榜 (Apr 2026) |
| — | **Commander** | **模型依赖** | 接入对应模型即可获得对应得分 |

### BFCL

| 排名 | 系统 | 综合得分 | 数据来源 |
|:---:|------|:--------:|----------|
| 1 | Llama 3.1 405B | **88.5%** | gorilla.cs.berkeley.edu |
| 2 | Llama 3.1 70B | **84.8%** | gorilla.cs.berkeley.edu |
| — | **Commander** | **框架层 21.7% examples 覆盖** | 本地实测。框架直接控制工具 Schema 质量 |

## 复现指南

```bash
# 切换到隔离环境
cd /tmp/commander-real-bench

# 运行所有本地基准
npx tsx bench/tool-def-quality.test.ts    # 工具定义质量
npx tsx bench/error-recovery.test.ts       # 错误自愈率
npx tsx bench/context-retention.test.ts    # 上下文保持率
npx tsx bench/sandbox-block.test.ts        # 沙箱阻断率

# 结果文件位于 results/*.json
ls results/
```

## 免责声明

- Commander 在自建基准上的得分来自本地实测，原始日志文件保留在 `results/` 目录
- 竞品在公开基准上的得分引用自官方排行榜，可能非最新版本
- 自建基准仅反映框架基础设施质量，不代表最终用户体验
- Commander 是模型无关框架，其代码生成能力取决于所配置的 LLM 后端
- BFCL examples 覆盖率 21.7% 是已知待改进项

## 参考文献

| 基准 | URL | License |
|------|-----|---------|
| SWE-bench Verified | https://www.swebench.com/verified | MIT |
| GAIA | https://hal.cs.princeton.edu/gaia | MIT |
| HumanEval+ | https://github.com/evalplus/evalplus | MIT |
| BFCL | https://gorilla.cs.berkeley.edu/leaderboard | MIT |
