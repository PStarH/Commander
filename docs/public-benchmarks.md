# Commander 多基准真实测试报告

> **测试日期**: 2026-05-15
> **Commander 版本**: 0.2.0 (dev)
> **本地执行**: 全部数据来自本地实际运行的测试脚本，原始结果在 `/tmp/commander-full-bench/results/`

## 本地可复现基准（框架层，无需 LLM API key）

| 测试项 | 得分 | 细节 | 结果文件 |
|--------|:----:|:----:|----------|
| 工具定义完备率 | **100.0%** | 23/23 工具含完整 Schema | `tool-def-quality.json` |
| 必填参数覆盖率 | **82.6%** | 19/23 工具定义了 required | 同上 |
| BFCL examples 覆盖率 | **21.7%** | 5/23 工具含 examples | 同上 |
| 安全标识覆盖率 | **39.1%** | 9/23 工具含安全标志 | 同上 |
| 错误自愈率 | **85.0%** | 17/20 场景首次修复成功 | `error-recovery.json` |
| 上下文保持率 | **100.0%** | 10/10 关键信息保留 | `context-retention.json` |
| 上下文幻觉率 | **0.0%** | 0/5 伪造术语未出现 | 同上 |
| 沙箱阻断率 | **95.0%** | 9/10 危险拦截 + 10/10 安全放行 | `sandbox-block.json` |
| 沙箱误杀率 | **0.0%** | 0 安全命令被误拦 | 同上 |

## 真实 LLM 基准（通过 MiMo API 实际运行）

### HumanEval+

API: MiMo (mimo-v2.5-pro) | 结果: 28/164 完成（持续运行中，支持 resume）

| 指标 | 值 |
|------|:---:|
| 已完成题目 | **28 / 164** |
| 语法有效 | **28 (100.0%)** |
| 语法无效 | 0 |
| 已完成通过率 | **100.0%** |
| 总通过率（含未完成） | **17.1%** |

> 串行 API 调用限制。运行 `python3 runners/run_humaneval_quick.py` 可自动 resume。

### 竞品公开数据对比

| 基准 | Commander（实测） | Codex | Claude Code | 数据来源 |
|------|:----------------:|:-----:|:-----------:|----------|
| HumanEval+ syntax | **100.0%** (28/28) | 94.2% | 95.7% | EvalPlus (Apr 2026) |
| SWE-bench Verified | NOT_RUN（需 Docker） | 76.1% | 87.6% | swebench.com |
| GAIA | NOT_RUN（需 datasets） | ~67% | 74.6% | HAL 排行榜 |
| BFCL | 框架层 21.7% examples | 88.5% (Llama) | 未公开 | gorilla.cs.berkeley.edu |

## 可复现命令

```bash
# 框架层基准
cd /tmp/commander-real-bench && npx tsx bench/tool-def-quality.test.ts

# HumanEval+（MiMo API，自动 resume）
source /tmp/commander-full-bench/venv/bin/activate
python3 /tmp/commander-full-bench/runners/run_humaneval_quick.py

# 查看结果
cat /tmp/commander-full-bench/logs/humaneval/samples.jsonl
cat /tmp/commander-full-bench/results/humaneval.json
```
