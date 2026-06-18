# WorkCoordinator Resume Semantics

When WorkCoordinator starts with a `SqliteWorkQueueStore`, it scans persisted items and re-arms in-flight work. This document explains what happens during a process crash + restart.

## Trigger

`new WorkCoordinator({ store })` calls `recover()` automatically. No manual invocation needed.

## State transitions

| Pre-crash state | Post-recover state | `attempts` | `claimedBy` |
| --------------- | ------------------ | ---------: | ----------- |
| `PENDING`       | `PENDING`          |  unchanged | `undefined` |
| `CLAIMED`       | `PENDING`          |  unchanged | `undefined` |
| `RUNNING`       | `PENDING`          |  unchanged | `undefined` |
| `COMPLETED`     | `COMPLETED`        |  unchanged | preserved   |
| `FAILED`        | `FAILED`           |  unchanged | preserved   |
| `REASSIGNED`    | `REASSIGNED`       |  unchanged | preserved   |

**In-flight items** (`CLAIMED`, `RUNNING`) are reset to `PENDING` because the prior claimer is dead.

## `attempts` counter is preserved

A process crash does **not** count as an attempt. If the work item was on attempt 1 of 2 when the process died, the next claim makes it attempt 2. The semantic is "the prior in-flight claim is lost, the next claim counts as `attempts + 1`".

| Pre-crash                          | After recover       | After re-claim      | After fail | Result                                        |
| ---------------------------------- | ------------------- | ------------------- | ---------- | --------------------------------------------- |
| attempts=1, maxAttempts=2, RUNNING | attempts=1, PENDING | attempts=2, CLAIMED | attempts=2 | FAILED (2 ≥ 2)                                |
| attempts=1, maxAttempts=3, RUNNING | attempts=1, PENDING | attempts=2, CLAIMED | attempts=2 | REASSIGNED → PENDING (one more retry allowed) |

## Compensation (M2.1) integration

If the in-flight work item had already taken file mutations (e.g., `file_write` to a new file), the snapshot at `<filePath>.atr-snapshot.<actionId>` may still be on disk. On re-execution:

- The agent re-runs `file_write`
- A new snapshot is taken (or none, if file doesn't exist)
- The new write succeeds
- No leak

For **non-mutation side effects** (API call, email, deploy), re-execution **may cause duplicates**. This is the M2.3.2 boundary; see [Side effects](#side-effects-and-m2.3.2).

## Side effects and M2.3.2

M2.3.1 (this slice) does not dedupe tool calls across replays. If your work item is:

```typescript
{ goal: 'POST /api/orders with payload X', tools: ['http_post'] }
```

…and the agent successfully POSTed, then the process crashed, on resume the agent will POST again. The API will see a duplicate request.

**Mitigation strategies** until M2.3.2 ships:

1. **Idempotency keys in your tools** — Make `http_post` accept a `idempotencyKey` parameter, and have your API check it.
2. **Manual inspection** — For critical runs, check the work item's history before resuming.
3. **Work item design** — Prefer tools that are naturally idempotent (`file_write` overwriting same content = no-op, `set_state` to same value = no-op).

M2.3.2 (planned) will integrate `IdempotencyStore` from `atr/idempotencyStore.ts` into AgentRuntime's tool path. When a tool is called with an `(runId, toolName, argsHash)` tuple that's been seen before in the same run, the cached result is replayed. See `.sisyphus/plans/m2-reliability.md` for details.

## Observability

The recover operation logs:

```
[INFO] [WorkCoordinator] Reclaimed in-flight items from prior process
  {"reclaimedCount": 2, "totalRecovered": 5}
```

Hook this into your alerting: if `reclaimedCount > 0`, you had an unclean shutdown.

For metrics, the `WorkEvent` subscribers receive the standard `enqueued` event for each rearmed item (because the items are loaded as `PENDING` and treated as available to claim). To distinguish "fresh" from "recovered" items, check whether the process has been running less than the item's `claimedAt` was set to.

## Testing

See `packages/core/tests/ultimate/workCoordinator.test.ts` → "GAP-M2.3 resume (crash recovery)" for 5 crash scenarios:

1. RUNNING items rearmed to PENDING
2. CLAIMED items rearmed (agent died between claim and start)
3. attempts counter preserved (crash does not consume attempt)
4. Mixed-state recovery touches only in-flight items
5. Recover emits a log line summarizing reclaimed count
