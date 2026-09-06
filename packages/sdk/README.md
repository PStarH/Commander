# @commander/sdk

TypeScript client for Commander's canonical Gateway V1 API.

> Alpha: use this package for evaluated integrations only. It is not a claim
> that Commander or the Gateway is production-ready.

## Requirements

- Node.js 20 or newer
- A running Commander Gateway
- A scoped `COMMANDER_API_KEY`

## Install

```bash
npm install @commander/sdk
```

## Gateway client

```typescript
import { CommanderGatewayClient } from '@commander/sdk';

const client = new CommanderGatewayClient({
  baseUrl: process.env.COMMANDER_API_URL!,
  apiKey: process.env.COMMANDER_API_KEY!,
});

const result = await client.submitRun({
  goal: 'Review the proposed change',
  policySnapshotId: 'review-policy-v1',
  idempotencyKey: crypto.randomUUID(),
});

console.log(result.run.id, result.accepted);
```

Consequential actions use the `/v1/actions` methods on
`CommanderGatewayClient`. Simulate first, bind approvals to the returned
digest and policy snapshot, and verify the evidence receipt before treating an
action as complete.

The legacy in-process `CommanderClient` remains alpha. It may initialize local
state and configured tools and is not a read-only first-user path.

See the repository's `PRIVACY.md` and enterprise quickstart before sending
sensitive data or enabling target-system writes.
