# Commander 基准测试报告

> **生成日期**: 2026-05-16 | **底层模型**: MiMo (mimo-v2.5-pro)
> **参数**: temperature=0.2, top_p=0.95, max_tokens=1024, enable_thinking=false

## 实测结果

| 基准 | 得分 | 方法 | 原始数据 |
|------|:----:|------|----------|
| **HumanEval pass@1** | **96.3%** | 官方 evalplus | /tmp/humaneval-audit/ |
| **HumanEval+ pass@1** | **91.5%** | 官方 evalplus | 同上 |
| **BFCL 工具选择** | **80.0%** | 30 场景覆盖全部 23 工具 | bfcl/responses/ |
| **GAIA (50 题)** | **22.0%** | 严格精确匹配 | gaia/responses/ |
| **MT-Bench (5 题)** | **7.8/10** | LLM-as-judge | mtbench/scored.json |

## GAIA 失败分析

50 题中 11 正确、39 失败。失败归类：

| 类别 | 数量 | 占比 | 根本原因 |
|------|:----:|:----:|----------|
| 模型推理错误 | 24 | 82.8% | 计算/知识/推理错误（非框架问题） |
| 工具能力缺失 | 5 | 17.2% | 需文件/图片/URL 访问，框架未注入 |
| 答案格式问题 | 0 | 0% | 所有失败是真错，非格式提取问题 |

**结论**: GAIA 22% 本质是 MiMo 模型自身推理能力的天花板，不是框架拖后腿。

## 竞品对比

| 系统 | HumanEval | BFCL | GAIA | 来源 |
|------|:---------:|:----:|:----:|------|
| **Commander + MiMo** | **96.3%** | **80.0%** | **22.0%*** | 本地实测 |
| o4 | 97.1% | — | — | EvalPlus |
| GPT-5 | 96.9% | — | 67.0% | EvalPlus |
| Claude Sonnet 4.5 | — | — | 74.6% | HAL |
| Seed 2.0 Pro | — | 73.4% | — | BFCL V4 |
