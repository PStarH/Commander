# L3-10a：Memory 天花板 / 单写 API

**状态：PARTIAL（产品写路径 MEMORY-001 + `writeProductMemory` ENFORCED；scratch / ACT-R 旁路已标注并在 agent 身份下 fail-closed；非产品概念已移出 allowlist）**  
**范围：Phase 1 Spec → Phase 2 Build → Phase 3 Review & Audit**  
**关联：** PRINCIPLES §3 memory allowlist、MEMORY-001（`namespaceGuard.ts`）、WS6 memory unify；**勿与 L3-05 run authority 并行改动**

---

## 1. Goal / Thesis

Commander 是 Agent 交易控制平面。产品面 durable memory 写入必须只有**一个权威入口**，跨租户/跨 agent namespace 写入 fail-closed（MEMORY-001）。本项是 I3 卫生：降双权威、钉天花板、文档化跨 hop 授权——**不做** memory 算法重写、RAG、curator 重设计、providers/topology/console 扩张。

---

## 2. Done when

| # | 条件 | 判定 |
|---|------|------|
| 1 | 产品 memory 写双权威收敛为单一首选写 API | **ENFORCED**（产品面）— UnifiedMemory / ThreeLayer durable route-out / Procedural / API adapter → `writeProductMemory` → `MemoryStore.write` → `MemoryService.store`；`MemoryStoreFacade.write` 仍公开（实现层），运维迁移直调 `service.store` 不计入产品权威 |
| 2 | MEMORY-001 在所选写路径上保持 | **ENFORCED** — InMemory + Postgres `store()` 调用 `assertNamespacedStoreInput` |
| 3 | 禁止的跨 namespace / 双路径旁路在声称 ENFORCED 处有测试 | **ENFORCED** — `memoryIsolation` + `l3-10a-productWrite` |
| 4 | 产品 memory 概念 ≤ 目标数（inventory + ceiling） | **ENFORCED** — allowlist 12→7，ceiling 16→7 |
| 5 | 跨 hop 授权文档化 | **ENFORCED** — 本 spec §5 |
| 6 | Scratch / ACT-R 等非产品写面清零 | **PARTIAL** — 已 deprecate / fail-closed / 移出产品 allowlist；未删除实现 |

---

## 3. Non-goals

- 全量 memory  redesign / HNSW / curator 重写
- 删除全部 secondary stores（仅标记非产品或移出 allowlist）
- L4 / Gateway 新面
- 改动 L3-05 run authority 文件

---

## 4. Concept inventory（before → after）

### 4.1 Product memory-system allowlist（PRINCIPLES §3 / `duplicationCountGuard`）

| Concept | Before | After | Role |
|---------|--------|-------|------|
| UnifiedMemory | product | **product** | Agent-facing facade；`remember` → `writeProductMemory` |
| ThreeLayerMemory | product | **product** | Working / routing；durable 出站经 `writeProductMemory` |
| MemoryCurator | product | **product** | Lifecycle on MemoryStore |
| ConversationStore | product | **product** | Conversation persistence（非 namespaced product record 权威） |
| SemanticMemoryStore | product | **product** | Semantic graph（非 MEMORY-001 record 权威） |
| ProceduralMemoryStore | product | **product** | Procedural rules；**writes via MemoryStore** |
| MemoryIndexManager | product | **product** | API index projection over ProjectMemoryStoreAdapter |
| EpisodicMemoryStore | product | **non-product internal** | Pillar IV ACT-R；parallel；无 MEMORY-001 |
| MemoryFederation | product | **non-product internal** | Cross-agent federation aux |
| MemoryManagerAgent | product | **non-product internal** | P1 prototype |
| MemoryQualityGate | product | **non-product internal** | Quality filter helper |
| CrossModelMemory | product | **non-product internal** | selfEvolution aux |

**Counts:** live allowlist hits **12 → 7**；locked ceiling **16 → 7**.

### 4.2 Write-authority inventory（dual → single）

| Surface | Before | After | MEMORY-001 |
|---------|--------|-------|------------|
| `MemoryService.store` (InMemory/Postgres) | canonical enforce | **canonical** | ENFORCED |
| `MemoryStoreFacade.write` | adapter | implementation of MemoryStore | via store |
| **`writeProductMemory`** | — | **preferred product entry** | via store |
| `UnifiedMemory.remember` / `ThreeLayerMemory` durable route-out / `ProjectMemoryStoreAdapter.append` / namespaced HTTP | direct `store.write` | **must** call `writeProductMemory` | via store |
| `MemoryStoreTool` (`.commander_memory` FS) | dual durable-looking path | **scratch-only**；agent-identified → fail-closed | N/A / blocked |
| `EpisodicMemoryStore.record` | parallel ACT-R write | non-product internal | not claimed |
| `MemoryWriteGuard` | file-path policy (MEMORY.md) | unchanged；not product record authority | N/A |

---

## 5. Cross-hop authorization（memory writes）

Product durable writes cross process / HTTP hops as follows. Client-controlled `meta.acl` / `meta.createdBy` are **never** trusted for grants.

```
Agent / SDK / HTTP client
  │  (untrusted: body.meta.namespace may be requested;
  │   body.namespaceAcl MUST be ignored if present)
  ▼
API hop (e.g. namespaced-memory router)
  │  1. Authenticate (JWT / API key scopes) → ACL role
  │  2. RBAC: role may write target namespace?
  │  3. Server-inject namespaceAcl = { role, namespaces: [namespace] }
  ▼
writeProductMemory(MemoryStore, options)
  ▼
MemoryStoreFacade.write → MemoryService.store
  ▼
assertNamespacedStoreInput (MEMORY-001)
  │  writer agents/{agentId} OR ACL-granted namespace OR skip if no agentId
  │  (system / tenant bulk jobs)
  ▼
Persist (InMemory map / Postgres)
```

**Rules:**

1. **Same-agent hop:** `meta.namespace` omitted or under `agents/{agentId}` → allowed without ACL.
2. **Cross-namespace hop:** requires **server-injected** `namespaceAcl` after RBAC（see `namespacedMemoryEndpoints.ts`）.
3. **Prefix safety:** `pathUnderNamespace` is boundary-aware（`agents/a` ↛ `agents/ab/...`）.
4. **Tool scratch hop:** `MemoryStoreTool` without product store is not a control-plane durable write；with `agentId` it must not bypass（throws）.

---

## 6. Evidence

| Claim | Evidence |
|-------|----------|
| Preferred write API | `packages/core/src/memory/writeProductMemory.ts` |
| MEMORY-001 on store | `inMemoryMemoryService.ts` / `postgresMemoryService.ts` + `tests/security/memoryIsolation.test.ts` |
| Dual-path agent bypass closed | `tests/memory/l3-10a-productWrite.test.ts`（MemoryStoreTool + agentId） |
| Ceiling 7 | `duplicationCountGuard.test.ts` MEMORY_RE + CEILINGS.memory |
| Cross-hop server ACL | `apps/api/src/namespacedMemoryEndpoints.ts`（`namespaceAcl` comment + inject） |

---

## 7. Residual（honest PARTIAL）

- `MemoryStoreTool` filesystem scratch remains for legacy demos when **no** `agentId`（not product durable）.
- `EpisodicMemoryStore` / federation / quality / manager / cross-model still exist as internals；not deleted.
- Conversation / Semantic specialty stores are product **features** but not the namespaced record write authority.
- Lowering allowlist does not delete code； growth regression is what the ceiling ENFORCES.
