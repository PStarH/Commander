# L3-08a — UNKNOWN 对账最小闭环

**状态：ENFORCED（package-level 2026-07-17）**  
**重要程度：I1**  
**依赖：** L3-03a Effect 垄断（已合入 master）、L3-02 ops（已合入）  
**下游：** L4-01 Governed Action Gateway MVP

## Goal

当 effect 进入 `COMPLETION_UNKNOWN`（超时 / complete 未确认 / 崩溃窗口）时，系统必须能：

1. **query-after-timeout** — 通过适配器向外部系统查询真实结局；
2. **reconcile** — 将 ledger 推进到 `COMPLETED` / `FAILED` / 保持 UNKNOWN+escalate；
3. **不双提交** — chaos：超时后外部已提交时，重试不得再次执行副作用。

## Done when

- [x] 至少 **1** 个可逆写适配器实现 `queryOutcome(effectId|idempotencyKey)` — `InMemoryTicketAdapter`
- [x] EffectBroker / kernel 路径：UNKNOWN → query → terminal state — `EffectBroker.reconcileUnknown` + `KernelRepository.reconcileEffect`
- [x] escalate 路径：query 仍不确定时标记待人工 — audit `effect.reconcile_escalated`
- [x] chaos 测：timeout 后远端已 commit → reconcile 记 COMPLETED，不二次 invoke
- [x] 无 production permit-all / 旁路完成

## Evidence

| 测 | 命令 |
|----|------|
| broker reconcile + escalate | `tsx --test packages/effect-broker/src/l3-08a-unknown-reconcile.test.ts` |
| ticket adapter chaos | `tsx --test packages/worker-plane/src/ticketAdapter.test.ts` |

## Non-goals（本波不做）

- L4-01 完整 Action Gateway HTTP/MCP 拦截面
- L3-07 workload identity 合入
- L3-11 evidence bundle 合入
- 支付 / 生命域适配器

## Suggested landing zones

| 包 | 职责 |
|----|------|
| `packages/effect-broker` | reconcile API / UNKNOWN 状态机钩子 |
| `packages/kernel` | effect state transitions + ops consumer |
| `packages/worker-plane` | 1 个 demo 适配器（如假 CRM / 假 ticket）+ 测 |

## Evidence bar

EXISTS → WIRED → ENFORCED → PROVEN（chaos 测至少一项 PROVEN）
