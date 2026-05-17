# Commander 基准测试报告

> **生成日期**: 2026-05-17 | **底层模型**: MiMo (mimo-v2.5-pro)
> **证据文件**: `benchmarks/<bench>/` 目录，每个基准有独立结果文件

## 实测结果

| 基准 | 规模 | Commander | 竞品 | 证据 |
|------|:----:|:---------:|:----:|------|
| **HumanEval+** | 164题 | **91.5%** | o4 97.1% | `/tmp/humaneval-audit/` |
| **GAIA (Commander)** | 165题 | **69.7%** | 裸MiMo 21.2% | `benchmarks/gaia/` |
| **BFCL (全量)** | 35场景 | 工具60.0% / 参数91.4% | — | `benchmarks/bfcl/results_full.json` |
| **BFCL (核心)** | 12场景 | 工具91.7% / 参数91.7% | Llama 405B 88.5% | `benchmarks/bfcl/results.json` |
| **MT-Bench (全量)** | 80题 | **6.6/10** | — | `benchmarks/mtbench/results_full.json` |
| **MT-Bench (核心)** | 7题 | **8.0/10** | — | `benchmarks/mtbench/results.json` |

## BFCL 全量 (35场景)

| 类别 | 场景 | 工具选择 | 参数准确 |
|------|:----:|:--------:|:--------:|
| Simple | 20 | 85.0% | 85.0% |
| Irrelevance | 5 | 20.0% | 100.0% |
| Multiple | 5 | 40.0% | 100.0% |
| Parallel | 5 | 20.0% | 100.0% |
| **Total** | **35** | **60.0%** | **91.4%** |

## MT-Bench 全量 (80题)

| 类别 | 得分 |
|------|:----:|
| Math | **8.3** |
| Reasoning | **7.2** |
| Coding | **7.0** |
| Extraction | **6.7** |
| Roleplay | **6.5** |
| STEM | **6.3** |
| Writing | **5.9** |
| Humanities | **5.0** |
| **平均** | **6.6** |
