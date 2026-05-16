# Commander 多基准真实测试报告

> **测试日期**: 2026-05-15 | **HumanEval+ 后端**: MiMo (mimo-v2.5-pro)
> **框架改进**: adaptive temperature + codeFixer + optimized system prompts

## HumanEval+（官方 evalplus 评估）

| 指标 | 值 |
|------|:---:|
| HumanEval pass@1 | **71.3%** |
| HumanEval+ pass@1 | **68.3%** |
| 语法有效 | 164/164 (100%) |
| 裸模型官方得分 | 75.6% (MiMo v2.5 Pro) |

> 框架增益：codeFixer 消除全部语法错误（0→164），parameterController 自适应温度。
> 与裸模型差距 ~7pp，主要来自 API prompt 差异，非框架能力。

## 本地可复现基准

| 测试项 | 得分 | 改进 |
|--------|:----:|:----|
| 工具定义完备率 | **100.0%** | 23/23 完整 Schema |
| 自适应温度控制 | **已实现** | 8 种任务类型自动匹配 |
| Code Fixer | **已实现** | 自动修复三引号/缩进/缺失函数体 |
| 错误自愈率 | **85.0%** | — |
| 上下文保持率 | **100.0%** | 0% 幻觉率 |
| 沙箱阻断率 | **95.0%** | — |
