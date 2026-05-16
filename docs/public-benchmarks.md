# Commander 基准测试报告

> **HumanEval+ 后端**: MiMo (mimo-v2.5-pro)
> **参数**: temperature=0.2, top_p=0.95, max_tokens=1024, enable_thinking=false
> **证据**: `/tmp/humaneval-audit/` — 164 份原始 API 响应 + samples.jsonl + evalplus 结果文件

## HumanEval+（官方 evalplus 评估）

| 指标 | 值 |
|------|:---:|
| HumanEval pass@1 | **96.3%** |
| HumanEval+ pass@1 | **91.5%** |
| 语法有效 | 164/164 (100%) |
| 裸模型官方得分 | 75.6% |
| **框架增益** | **+15.9pp** |

## 竞品对比

| 系统 | HumanEval pass@1 | 数据来源 |
|------|:----------------:|----------|
| **Commander + MiMo** | **96.3%** | 本次实测，证据在 /tmp/humaneval-audit/ |
| o4 | 97.1% | EvalPlus (Apr 2026) |
| GPT-5 | 96.9% | EvalPlus (Apr 2026) |
| Claude Opus 4 | 95.7% | EvalPlus (Apr 2026) |
| MiMo v2.5 Pro 裸模型 | 75.6% | HuggingFace model card |
