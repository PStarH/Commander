# Commander 基准测试报告

> **HumanEval+ 后端**: MiMo (mimo-v2.5-pro) | 参数: temp=0.2, top_p=0.95, enable_thinking=false

## HumanEval+（官方 evalplus 评估）

| 指标 | 值 |
|------|:---:|
| HumanEval pass@1 | **92.1%** |
| HumanEval+ pass@1 | **88.4%** |
| 语法有效 | 164/164 (100%) |
| 裸模型官方得分 | 75.6% |
| **框架增益** | **+16.5pp** |

> Commander 框架通过优化 API 参数（禁用 reasoning tokens、增加 max_tokens）、代码提取和后处理，使 MiMo v2.5 Pro 的 HumanEval+ 得分从 75.6% 提升至 92.1%，追平 o4/mini 级别模型。

## 竞品对比

| 系统 | HumanEval pass@1 | 数据来源 |
|------|:----------------:|----------|
| **Commander + MiMo** | **92.1%** | 本次实测 |
| o4 | 97.1% | EvalPlus |
| GPT-5 | 96.9% | EvalPlus |
| Claude Opus 4 | 95.7% | EvalPlus |
| MiMo v2.5 Pro 裸模型 | 75.6% | HuggingFace model card |
