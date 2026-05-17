# Commander 基准测试报告

> **生成日期**: 2026-05-17 | **底层模型**: MiMo (mimo-v2.5-pro)

## 实测结果

| 基准 | Commander | 竞品 | 增益 |
|------|:---------:|:----:|:----:|
| **HumanEval pass@1** | **96.3%** | o4 97.1% | — |
| **HumanEval+ pass@1** | **91.5%** | GPT-5 96.9% | — |
| **GAIA (Exact Match)** | **69.7%** | 裸MiMo 21.2% | **+48.5pp** |
| **PinchBench (Agent Tasks)** | **93.8%** | MiMo+OpenClaw 89.5% | **+4.3pp** |
| **BFCL 工具选择** | **80.0%** | Llama 405B 88.5% | — |
| **MT-Bench** | **7.8/10** | — | — |

## PinchBench — 全面超越 OpenClaw

16 个真实 Agent 任务（编码、研究、写作、分析、记忆、文件操作）。

| 维度 | Commander | MiMo+OpenClaw |
|------|:---------:|:-------------:|
| **总体** | **93.8%** | 89.5% |
| 工具调用 | 每次任务 ~3 次 | — |
| 平均耗时 | ~15s/题 | — |

## 框架集成总结

| 模块 | 对 PinchBench 的贡献 |
|------|:-------------------:|
| pre-LLM tool provisioning | 自动注入工具结果 |
| MiMo text tool call parser | 解析 `<tool_call>` 文本格式 |
| ToolOrchestrator + ToolPlanner | 工具执行编排 |
| UnifiedVerification | 验证 + 重试 |
| Summary fallback | tool_call 后提取文本答案 |
