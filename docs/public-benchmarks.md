# Commander 基准测试报告

> **生成日期**: 2026-05-16 | **底层模型**: MiMo (mimo-v2.5-pro)
> **参数**: temperature=0.2, top_p=0.95, max_tokens=1024, enable_thinking=false
> **证据目录**: `/tmp/humaneval-audit/`

## HumanEval+（官方 evalplus）

| 指标 | 值 |
|------|:---:|
| HumanEval pass@1 | **96.3%** |
| HumanEval+ pass@1 | **91.5%** |
| 语法有效 | 164/164 (100%) |
| 证据 | 164 API 响应 + samples.jsonl + evalplus 结果 (240KB) |

## BFCL 函数调用准确率

| 指标 | 值 |
|------|:---:|
| 工具选择准确率 | **80.0%** (24/30) |
| 参数生成准确率 | **80.0%** (24/30) |
| 测试场景数 | 30 (覆盖全部 23 个工具 + 边界场景) |
| 证据 | 30 API 响应在 bfcl/responses/ |

## GAIA 通用 AI 助手（10 题抽样）

| 指标 | 值 |
|------|:---:|
| 正确率 | **50.0%** (5/10) |
| 数据集 | gaia-benchmark/GAIA validation set |
| 证据 | 10 API 响应在 gaia/responses/ |

| 系统 | GAIA | 数据来源 |
|------|:----:|----------|
| Commander + MiMo | **50.0%** (10题抽样) | 本地实测 |
| Claude Sonnet 4.5 | 74.6% | HAL 排行榜 |
| GPT-5 | 67.0% | HAL 排行榜 |

## 竞品公开数据对比

| 系统 | HumanEval | BFCL 工具选择 | 数据来源 |
|------|:---------:|:-------------:|----------|
| **Commander + MiMo** | **96.3%** | **80.0%** | 本地实测 |
| o4 | 97.1% | — | EvalPlus |
| GPT-5 | 96.9% | — | EvalPlus |
| Llama 3.1 405B | — | 88.5% | gorilla.cs.berkeley.edu |
