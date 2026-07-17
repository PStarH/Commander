# L3-12a — WS9 live-fire select（EXEC-1）

**状态：PARTIAL（harness ENFORCED；live PASS 依赖 runsc/docker+runsc + 可用镜像）**  
**重要程度：I2**  
**依赖：** WS9 baseline + `probeGvisor` / docker `runsc` runtime  
**下游：** 不宣称整份 WS9 ACCEPTED；不启动 L3-10a

## Goal

把 WS9 套件中唯一 **missing** 证据的 **EXEC-1**（gVisor 跨租户执行隔离对抗）从 stub 提升为可诚实产出 `evidenceLevel=live` 的 harness：当 gVisor 可用时实弹验证；不可用时 SKIP 且不写伪证据。

## Done when

- [x] `spec/l3-12a-ws9-livefire-select.md` 写明 Goal / Done when / Non-goals / Evidence / ENFORCED vs PARTIAL
- [x] EXEC-1 harness：`probeGvisor.available` 时用真实 `docker --runtime=runsc`（或 PATH 上的 runsc）跑对抗；仅在真实拦截证据上 `writePass('EXEC-1', …, 'live')`
- [x] gVisor 不可用 → skip，**不写** artifact
- [x] harness helper 单测（mock spawn）可在无 runsc 环境跑；**不得**写 `evidenceLevel=live`
- [x] 相关 vitest 跑通；文档如实记录本机无/有 runsc 时的结果
- [x] `.internal` loop state 标记 L3-12a DONE + tip SHA

## Non-goals

- 不把整份 WS9 标为 ACCEPTED
- 不批量把 25 条 `simulated` 抬成 `live`
- 不伪造 `evidenceLevel=live`（in-process / mock 路径禁止）
- 不做 L3-10a
- 可选第二案（DATA-4 / DATA-6 / KEY-*）若不便宜则跳过 — 本波仅 EXEC-1

## Evidence

| 测 | 命令 | 期望 |
|----|------|------|
| EXEC-1 helpers（无 runsc） | `cd packages/core && pnpm exec vitest run tests/ws9/exec-isolation.test.ts` | helper 单测 PASS；无 runsc 时 live 块 skip；**无** EXEC-1.json |
| EXEC-1 live（有 docker+runsc） | 同上（probe 绿时） | 对抗拦截 → `docs/baselines/ws9/EXEC-1.json` 且 `evidenceLevel=live` |

对抗向量（spec §4.2 EXEC-1）：

1. A 在 gVisor 内 `nsenter` → 失败（EPERM / 非零）
2. A 经 `/proc/1/root` 读 host-only marker → 不可见
3. A 读 B 容器 canary → 不可见；B canary 仍完整

## ENFORCED vs PARTIAL

| 层 | 标签 | 含义 |
|----|------|------|
| Harness + honesty gate | **ENFORCED** | 无 gVisor 不写证据；mock 路径不写 live；仅真实拦截写 live PASS |
| Suite-level EXEC-1 live PASS | **PARTIAL** | 依赖本机/CI 具备 `runsc` 或 `docker` runtime `runsc` + 可启动镜像；本波不保证每台开发机都绿 |
| WS9 overall ACCEPTED | **未宣称** | summary 仍可因其它 simulated 槽位 / 缺证据 FAIL |

## Suggested landing zones

| 路径 | 职责 |
|------|------|
| `packages/core/tests/ws9/exec1-gvisor-harness.ts` | 可注入 spawn 的对抗 harness + 判定纯函数 |
| `packages/core/tests/ws9/exec-isolation.test.ts` | EXEC-1 live / skip / helper 单测 |
| `packages/core/tests/ws9/_evidence.ts` | `probeGvisor` 识别 PATH runsc **或** docker `runsc` runtime |
