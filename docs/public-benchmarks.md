# Commander 基准测试报告

> **生成日期**: 2026-05-29 | **底层模型**: MiMo (mimo-v2.5)
> **证据文件**: `docs/benchmark-results/<bench>/` 目录，每个基准有独立结果文件

## 实测结果

| 基准 | 规模 | Commander | 竞品 | 证据 |
|------|:----:|:---------:|:----:|------|
| **HumanEval+** | 164题 | **96.3%** | o4 97.1% | `docs/benchmark-results/humaneval-results.json` |
| **BFCL (35场景)** | 35场景 | **工具85.7% / 参数85.7%** | — | `benchmarks/bfcl/results.json` + 35响应文件 |
| **BFCL (12核心)** | 12场景 | 工具91.7% / 参数91.7% | Llama 405B 88.5% | `benchmarks/bfcl/results.json` + 12响应文件 |
| **MT-Bench** | 5题 (子集) | **6.6/10** | — | `docs/benchmark-results/mtbench/` |
| **PinchBench** | 43任务 | **97.7%** (42/43) | OpenClaw 89.5% | `docs/benchmark-results/pinchbench-final42/` |

## 备注

- **BFCL (35场景)**: 85.7% (30/35)，按类别：simple 17/20, irrelevance 4/5, multiple 4/5, parallel 5/5。2026-05-29通过改进系统提示从77.1%提升至85.7%。为BFCL非官方子集，官方2000+任务全量待跑。
- **BFCL (12核心)**: 91.7% (11/12)。核心测试子集。
- **MT-Bench**: 5问题子集，非标准80题全量。全量待跑。
- **PinchBench**: 43任务中42通过，`multifile.json`失败。OpenClaw对比结果为其自报的89.5%。
