# Commander 基准测试报告

> **生成日期**: 2026-05-16 | **底层模型**: MiMo (mimo-v2.5-pro)
> **参数**: temperature=0.2, top_p=0.95, max_tokens=1024, enable_thinking=false
> **所有原始数据**: `/tmp/humaneval-audit/`

## 本地实测指标

| 基准 | Commander | 方法 | 证据 |
|------|:---------:|------|------|
| **HumanEval pass@1** | **96.3%** | 官方 evalplus | 164 API 响应 + evalplus 240KB |
| **HumanEval+ pass@1** | **91.5%** | 官方 evalplus | 同上 |
| **BFCL 工具选择** | **80.0%** | 30 场景覆盖全部 23 工具 | 30 API 响应 |
| **BFCL 参数生成** | **80.0%** | 同上 | 同上 |
| **GAIA (50 题抽样)** | **22.0%** | 精确匹配 | 50 API 响应 |
| **MT-Bench (5 题)** | **7.8/10** | LLM-as-judge | 评分记录 |

## 竞品对比

| 系统 | HumanEval | BFCL | GAIA | 数据来源 |
|------|:---------:|:----:|:----:|----------|
| **Commander + MiMo** | **96.3%** | **80.0%** | **22.0%*** | 本地实测 |
| o4 | 97.1% | — | — | EvalPlus |
| GPT-5 | 96.9% | — | 67.0% | EvalPlus / HAL |
| Claude Sonnet 4.5 | — | — | 74.6% | HAL |
| Seed 2.0 Pro | — | 73.4% | — | BFCL V4 |
| Llama 3.1 405B | — | 88.5% | — | BFCL V3 |

> *GAIA 使用严格精确匹配。LLM-as-judge 评分会更高。BFCL V4 总分公式不同，80% 单项不可直接对比 V4 综合分。

## 证据完整性

| 检查项 | 状态 |
|--------|:----:|
| HumanEval 164 份 API 响应 | ✅ 164 个文件 |
| HumanEval evalplus 官方结果 | ✅ 240KB 结果文件 |
| BFCL 30 场景 API 响应 | ✅ 30 个文件 |
| GAIA 50 题 API 响应 | ✅ 50 个文件 |
| MT-Bench LLM-as-judge 评分 | ✅ 已评分 |
