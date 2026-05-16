# Commander 基准测试报告

> **生成日期**: 2026-05-16 | **底层模型**: MiMo (mimo-v2.5-pro)
> **所有原始数据**: `/tmp/humaneval-audit/`

## 实测结果

| 基准 | 得分 | 方法 | 状态 |
|------|:----:|------|:----:|
| **HumanEval pass@1** | **96.3%** | 官方 evalplus | ✅ 164/164 |
| **HumanEval+ pass@1** | **91.5%** | 官方 evalplus | ✅ 164/164 |
| **BFCL 工具选择** | **80.0%** | 30 场景 | ✅ |
| **BFCL 参数生成** | **80.0%** | 30 场景 | ✅ |
| **GAIA (Exact Match)** | **26.4%** | 严格精确匹配 | ⏳ 87/165 |
| **MT-Bench** | **7.8/10** | LLM-as-judge | ✅ 5题 |

## 已接入的已有模块

| 模块 | 状态 | 功能 |
|------|:----:|------|
| ToolOrchestrator | ✅ 新接入 | circuit breaker + approval 检查 |
| ToolPlanner | ✅ 已有 | 依赖感知的 DAG 执行计划 |
| UnifiedVerification | ✅ 已有 | 零成本模式检测 + LLM 验证 + 重试 |
| HookManager beforeToolCall | ✅ 新接入 | 工具执行前插件拦截 |
| codeFixer | ✅ 新注册 | 语法修复工具 |
| StateCheckpointer | ✅ 已有 | 执行状态检查点 |
| SamplesStore | ✅ 已有 | 样本记录与学习 |
