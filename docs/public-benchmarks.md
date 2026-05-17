# Commander 基准测试报告

> **生成日期**: 2026-05-17 | **底层模型**: MiMo (mimo-v2.5-pro)
> **证据目录**: `benchmarks/` — 每个基准的原始结果和 LOG 文件

## 实测结果

| 基准 | Commander | 竞品 | 增益 |
|------|:---------:|:----:|:----:|
| **HumanEval pass@1** | **96.3%** | o4 97.1% | 同梯队 |
| **HumanEval+ pass@1** | **91.5%** | GPT-5 96.9% | 同梯队 |
| **GAIA (Commander, 165题)** | **69.7%** | 裸MiMo 21.2% | +48.5pp |
| **PinchBench (43 tasks)** | **97.7%** | MiMo+OpenClaw 89.5% | +8.2pp |
| **BFCL 工具选择** | **91.7%** | Llama 405B 88.5% | +3.2pp |
| **BFCL 参数生成** | **91.7%** | — | — |
| **MT-Bench (7题)** | **8.0/10** | — | — |

## 证据文件

| 基准 | 结果文件 | 响应数 |
|------|----------|:------:|
| GAIA Commander | `benchmarks/gaia/results.json` | 165 |
| GAIA 裸API | `benchmarks/gaia/results_bare_api.json` | 165 |
| BFCL | `benchmarks/bfcl/results.json` | 12 |
| MT-Bench | `benchmarks/mtbench/results.json` | 7 |
