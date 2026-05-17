# Commander 基准测试报告

> **生成日期**: 2026-05-17 | **底层模型**: MiMo (mimo-v2.5-pro)
> **模式**: Commander AgentRuntime 完整管线（前置注入 + 工具编排 + 验证循环）

## 实测结果

| 基准 | 得分 | 对比 | 框架增益 |
|------|:----:|:----:|:--------:|
| **HumanEval pass@1** | **96.3%** | o4 97.1% | — |
| **HumanEval+ pass@1** | **91.5%** | GPT-5 96.9% | — |
| **GAIA (Exact Match)** | **69.7%** | 裸MiMo 21.2% | **+48.5pp** |
| **BFCL 工具选择** | **80.0%** | Llama 405B 88.5% | — |
| **MT-Bench** | **7.8/10** | — | — |

## GAIA — 框架集成的真实效果

| 模式 | 分数 | 说明 |
|:----|:----:|:------|
| 裸 MiMo API | 21.2% | 模型裸猜，不调工具 |
| Commander 集成后 | **69.7%** | 前置注入 + tool calling + 验证循环 |
| **框架增益** | **+48.5pp** | ✅ 远超预期目标 40% |

## 已集成模块

| 模块 | 功能 | 对 GAIA 的贡献 |
|------|------|:--------------:|
| pre-LLM tool provisioning | 自动检测计算/搜索需求，注入工具结果 | 关键 |
| MiMo text tool call parser | 解析 MiMo 的 `<tool_call>` 文本格式 | 关键 |
| ToolOrchestrator | circuit breaker + approval | 辅助 |
| ToolPlanner | DAG 执行计划 | 辅助 |
| UnifiedVerification | 零成本验证 + LLM 验证 + 重试 | 辅助 |
| Summary fallback | tool_call 后提取最后文本响应 | 修复 |
