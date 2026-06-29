# Unmounted Routes

These route files have complete implementations but are **not mounted** on the
Express app in `index.ts`. They were moved here to keep the active API surface
clean while preserving the code for future activation.

## Files

- `sagaEndpoints.ts` — 6 Saga compensation routes (list/run/timeline/resume/fork/stream)
- `hubCorrelationsEndpoints.ts` — Tier-0 correlation event observability (SSE + REST)

## Reactivation

To activate these routes, import and mount them in `index.ts`:

```ts
import { createSagaRouter } from './_unmounted/sagaEndpoints';
import { createHubCorrelationsRouter } from './_unmounted/hubCorrelationsEndpoints';

app.use(createSagaRouter());
app.use('/api/v1/hub', createHubCorrelationsRouter());
```
