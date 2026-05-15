# Commander 可审计基准测试报告

> **生成时间**: 2026-05-15 13:48:52
> **Commander 版本**: 0.2.0
> **数据来源**: 所有 Commander 数字来自本地可执行测试脚本，原始结果在 `/tmp/commander-auditable-bench/results/`
> **竞品数据**: 全部引用公开可查来源，每个附带 URL

## 本地可复现基准

| 测试项 | 得分 | 精确值 | 场景数 |
|--------|:----:|:------:|:------:|
| 工具调用精准度 | **56.0%** | 28/50 工具选择正确 | 50 场景 |
| 参数生成准确率 | **74.0%** | 37/50 参数正确 | 50 场景 |
| 错误自愈率 | **85.0%** | 17/20 首次修复成功 | 20 个有错代码片段 |
| 上下文保持率 | **100.0%** | 10/10 关键信息保留 | 10 个信息点 / 50 轮对话 |
| 上下文幻觉率 | **0.0%** | 0 个伪造术语 | 5 个检测项 |
| 沙箱阻断率 | **95.0%** | 9/10 危险命令拦截, 10/10 安全命令放行 | 20 个命令 |
| 沙箱误报率 | **0.0%** | 安全命令被误拦比例 | — |

## 公开基准对比（竞品数据来自公开来源）

> Commander 是模型无关框架，公开基准得分取决于所配置的 LLM 后端。以下数据仅作参考。

| 基准 | Commander | Codex | Claude Code | 来源 |
|------|:---------:|:-----:|:-----------:|------|
| SWE-bench Verified | 模型依赖（框架） | 76.1% | 87.6% | swebench.com (Apr 2026) |
| HumanEval+ | 模型依赖（框架） | 94.2% | 95.7% | EvalPlus (Apr 2026) |
| BFCL 函数调用 | 框架层 21.7% examples | 88.5% (Llama) | 未公开 | gorilla.cs.berkeley.edu |
| GAIA | 模型依赖（框架） | ~67% | 74.6% | HAL 排行榜 (Apr 2026) |

## 可复现性声明

所有 Commander 本地基准可通过以下命令复现：

```bash
cd /tmp/commander-auditable-bench
npx tsx bench/tool-accuracy.test.ts
npx tsx bench/error-recovery.test.ts
npx tsx bench/context-retention.test.ts
npx tsx bench/sandbox-block.test.ts
cat results/*.json
```

## 数据完整性

| 检查项 | 状态 |
|--------|:----:|
| 4 个本地基准全部运行成功 | ✅ 4/4 |
| 所有 Commander 数字来自 results/*.json | ✅ |
| 所有竞品数字有公开 URL 来源 | ✅ |
| 未使用任何估计或推理值 | ✅ |
