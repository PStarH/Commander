# Refactoring Proposals

## 1. Extract Magic Numbers to Constants

**Issue**: 20+ hardcoded numeric literals across `orchestrator.ts`, `topologyRouter.ts`, `deliberation.ts`, `subAgentExecutor.ts`.

**Examples**:
- `0.000015` in 2 places (cost per token)
- `2048`, `4096`, `8192` (thinking budgets)
- `2000`, `50000` (token limits)
- `0.1` confidence adjustments in 6 places

**Fix**: ✅ Partially done — created `src/config/constants.ts`, updated `orchestrator.ts`. Remaining: `topologyRouter.ts`, `deliberation.ts`, `subAgentExecutor.ts`.

**Risk**: Low. Mechanical replacement.

---

## 2. Reduce `as any` Type Assertions

**Issue**: 17 `as any` assertions across source code.

**Hotspots**:
- `src/runtime/agentRuntime.ts` (4) — `response as any` for `reasoning_content`, `toolCalls`
- `src/runtime/toolApproval.ts` (4)
- `src/runtime/llmRetry.ts` (4) — `err as any` for status extraction
- `src/ultimate/topologyOptimizer.ts` (3) — `as any` in optimization result

**Fix**: Add proper TypeScript interfaces for the response shapes instead of casting. The `LLMResponse` type should include optional `reasoning_content` and `toolCalls` fields.

**Risk**: Medium. Requires careful interface design.

---

## 3. Empty Catch Blocks Audit

**Issue**: 48 empty catch blocks. Most are Intentional (cleanup in finally), but some swallow errors.

**Suspicious patterns**:
```typescript
catch { /* ignore */ }  // in file operations
catch {}  // in memory operations  
```

**Fix**: Audit all empty catch blocks. Replace with structured logging at minimum. For critical paths, add fallback values or error propagation.

**Risk**: Low. Add logging, don't change behavior.

---

## 4. High Cyclomatic Complexity in `agentRuntime.ts`

**Issue**: The `execute()` method (lines 79-354) has cyclomatic complexity > 50 due to nested loops, retry logic, tool dispatch, and error handling all in one function.

**Fix**: Extract:
- Tool execution loop → `executeToolCalls(request, routing)` 
- Retry logic → `executeWithRetry(request, routing)`
- Result building → `buildResult(response, steps, tokens)`

**Risk**: Medium. Requires careful testing to avoid regression.

---

## 5. Uncovered Test Modules

**Issue**: The following source modules have no dedicated test files:
- `src/runtime/llmRetry.ts` — tested indirectly via edge cases but no unit tests
- `src/runtime/circuitBreaker.ts` — tested in chaos monkey but no standalone unit tests
- `src/sandbox/execPolicy.ts` — tested in edge cases
- `src/sandbox/approval.ts` — tested in dimensional benchmark
- `src/pluginLoader.ts` — no tests
- `src/moats/*` — removed per compliance

**Fix**: Create dedicated unit test files for each module.

**Risk**: Low.

---

## Priority Order

1. **P0**: Empty catch block audit (risk of silent failures)
2. **P0**: Constants extraction (maintainability)
3. **P1**: agentRuntime.ts decomposition (testability)
4. **P1**: `as any` reduction (type safety)
5. **P2**: Uncovered test modules (coverage)
