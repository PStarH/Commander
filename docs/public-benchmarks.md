# Commander 基准测试报告

> **生成日期**: 2026-05-17 | **底层模型**: MiMo (mimo-v2.5-pro)
> **证据文件**: `docs/benchmark-results/<bench>/` 目录，每个基准有独立结果文件

## 实测结果

| 基准 | 规模 | Commander | 竞品 | 证据 |
|------|:----:|:---------:|:----:|------|
| **HumanEval+** | 164题 | **91.5%** | o4 97.1% | `docs/benchmark-results/humaneval-results.json` |
| **GAIA (Commander)** | 165题 | **69.7%** | 裸MiMo 21.2% | `docs/benchmark-results/gaia-commander-final/` |
| **BFCL (35场景)** | 35场景 | 工具60.0% / 参数91.4% | — | `benchmarks/bfcl/results_full.json` + 35响应文件 |
| **BFCL (30任务)** | 30任务 | 工具80.0% / 参数80.0% | — | `docs/benchmark-results/bfcl/results.json` |
| **BFCL (12核心)** | 12场景 | 工具91.7% / 参数91.7% | Llama 405B 88.5% | `benchmarks/bfcl/results.json` + 12响应文件 |
| **MT-Bench** | 5题 (子集) | **7.8/10** | — | `docs/benchmark-results/mtbench/` |
| **PinchBench** | 43任务 | **97.7%** (42/43) | OpenClaw 89.5% | `docs/benchmark-results/pinchbench-final42/` |

## 备注

- **BFCL**: 三个实际运行子集——35场景（通用，60%/91.4%，含逐场景响应文件）、30任务（Commander rerun，80%/80%）和12场景（核心测试，91.7%/91.7%）。均为BFCL非官方子集。官方2000+任务全量待跑。
- **MT-Bench**: 5问题子集，非标准80题全量。全量待跑。
- **GAIA**: 115/165正确 (69.7%)，其中105条正确答案的`answer`字段为空（提取逻辑缺陷），`correct`字段基于完整LLM响应判定。提取逻辑需改进。
- **PinchBench**: 43任务中42通过，`multifile.json`失败。OpenClaw对比结果为其自报的89.5%。
