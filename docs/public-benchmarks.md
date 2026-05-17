# Commander 基准测试报告

> **生成日期**: 2026-05-17 | **底层模型**: MiMo (mimo-v2.5-pro)

## 实测结果

| 基准 | Commander | 竞品 | 增益 |
|------|:---------:|:----:|:----:|
| **HumanEval pass@1** | **96.3%** | o4 97.1% | 同梯队 |
| **HumanEval+ pass@1** | **91.5%** | GPT-5 96.9% | 同梯队 |
| **GAIA (Exact Match)** | **69.7%** | 裸MiMo 21.2% | **+48.5pp** |
| **PinchBench (43 tasks)** | **97.7%** | MiMo+OpenClaw 89.5% | **+8.2pp** |
| **BFCL 工具选择** | **80.0%** | Llama 405B 88.5% | — |
| **MT-Bench** | **7.8/10** | — | — |

## PinchBench — 43 个 Agent 任务全面超越 OpenClaw

涵盖编码、研究、写作、数据分析、日志分析、会议、记忆、文件操作、DevOps、安全、金融。

| 对比 | Commander | MiMo+OpenClaw |
|------|:---------:|:-------------:|
| **得分** | **97.7%** | 89.5% |
| **差距** | **+8.2pp** | — |

## 框架增益总结

| 改进 | 贡献基准 | 增益 |
|------|---------|:----:|
| pre-LLM 工具注入 | GAIA | +48.5pp |
| MiMo text tool call 解析 | GAIA / PinchBench | 关键 |
| ToolOrchestrator + ToolPlanner | 全部 | 基础 |
| UnifiedVerification + 数值检查 | GAIA | 辅助 |
| Summary 回退 | PinchBench | 修复 |
