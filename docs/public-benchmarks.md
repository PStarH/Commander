# Commander 多基准真实测试报告

> **测试日期**: 2026-05-15
> **Commander 版本**: 0.2.0 (dev)
> **HumanEval+ 后端**: MiMo (mimo-v2.5-pro)
> **所有 Commander 分数来自本地实际运行，原始结果在 `/tmp/commander-full-bench/results/`**

## HumanEval+（官方 evalplus 评估 ✅）

**164/164 题全部完成，MiMo API + evalplus 官方测试套件**

| 指标 | 值 |
|------|:---:|
| HumanEval base pass@1 | **68.3%** |
| HumanEval+ pass@1 | **65.2%** |
| 语法有效 | 155/164 (94.5%) |
| 语法无效（占位符替代） | 9 (5.5%) |
| API 调用失败 | **0** |

> 9 个语法无效的解答使用 `pass` 占位符，拖低了分数。纯语法有效子集上 pass@1 估计 ~70%。
> 竞品参考（官方 HumanEval+ pass@1）：o4 97.1%, GPT-5 96.9%, Claude Opus 4 95.7%, GPT-5.3 Codex 94.2%

## 本地可复现基准（框架层）

| 测试项 | 得分 | 细节 |
|--------|:----:|:------|
| 工具定义完备率 | **100.0%** | 23/23 工具含完整 Schema |
| 错误自愈率 | **85.0%** | 17/20 场景首次修复成功 |
| 上下文保持率 | **100.0%** | 10/10 关键信息保留，0% 幻觉 |
| 沙箱阻断率 | **95.0%** | 9/10 危险拦截 + 10/10 安全放行 |

## 竞品公开数据对比

| 基准 | Commander（实测） | Codex | Claude Code | 数据来源 |
|------|:----------------:|:-----:|:-----------:|----------|
| HumanEval+ pass@1 | **65.2%** (MiMo) | 94.2% | 95.7% | EvalPlus / 本次实测 |
| SWE-bench Verified | NOT_RUN（需 Docker） | 76.1% | 87.6% | swebench.com |
| GAIA | NOT_RUN（需 datasets） | ~67% | 74.6% | HAL 排行榜 |

## 可复现命令

```bash
source /tmp/commander-full-bench/venv313/bin/activate
python3 -m evalplus.evaluate --dataset humaneval --samples /tmp/commander-full-bench/logs/humaneval/samples_full.jsonl --parallel 1
```
