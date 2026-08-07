# External OpenAI Agents MCP Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an independent OpenAI Agents SDK process that invokes every governed rollback operation through Commander MCP and emits reproducible deterministic and live-smoke evidence.

**Architecture:** An isolated consumer package uses the public `@openai/agents` `Model` and `MCPServerStdio` APIs. A fetch-compatible proof adapter maps the existing Kubernetes rollback driver's public Gateway requests to external consumer invocations, so the established Kind/PostgreSQL recovery and receipt proof remains authoritative while all action traffic crosses the SDK/MCP process boundary.

**Tech Stack:** TypeScript, Node.js 22, pnpm 9.15.4, `@openai/agents` 0.14.3, MCP stdio, Vitest/Node test runner, existing Commander Action Gateway, PostgreSQL, Kind, Ed25519 evidence verification, GitHub Actions.

## Global Constraints

- The external consumer must not import `@commander/*`, `packages/**`, or `apps/**`.
- Deterministic CI requires no OpenAI API key and makes no public network request at runtime.
- Consequential action proposal is never independently retried with a new idempotency key.
- `COMPLETION_UNKNOWN` can only be followed by get, reconcile, or evidence operations.
- The full `PROVEN` verdict still requires the existing real Kind/PostgreSQL G5 environment and trusted JWKS.
- Live mode is opt-in, requires an explicit model, and writes only sanitized metadata.

---

### Task 1: Independent Agents SDK Consumer

**Files:**
- Create: `integrations/openai-agents-mcp/package.json`
- Create: `integrations/openai-agents-mcp/tsconfig.json`
- Create: `integrations/openai-agents-mcp/src/contracts.ts`
- Create: `integrations/openai-agents-mcp/src/deterministicModel.ts`
- Create: `integrations/openai-agents-mcp/src/invoke.ts`
- Create: `integrations/openai-agents-mcp/src/cli.ts`
- Create: `integrations/openai-agents-mcp/tests/boundary.test.ts`
- Create: `integrations/openai-agents-mcp/tests/deterministicModel.test.ts`
- Modify: `package.json`
- Modify: `pnpm-workspace.yaml`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Consumes: public `Agent`, `MCPServerStdio`, `Model`, `ModelRequest`, and `ModelResponse` exports from `@openai/agents`.
- Produces: `invokeCommanderTool(input: InvokeCommanderToolInput): Promise<InvokeCommanderToolResult>` and CLI JSON on stdout.

- [ ] **Step 1: Write boundary and model tests**

```ts
it('has no Commander source or package imports', () => {
  for (const source of consumerSources()) {
    expect(source).not.toMatch(/@commander\//);
    expect(source).not.toMatch(/(?:packages|apps)\//);
  }
});

it('emits exactly one requested function call before a final response', async () => {
  const model = new DeterministicToolModel('commander_action_get', { runId: 'run-1' });
  const first = await model.getResponse(modelRequest([]));
  expect(first.output).toContainEqual(expect.objectContaining({
    type: 'function_call',
    name: 'commander_action_get',
  }));
});
```

- [ ] **Step 2: Run tests and verify RED**

Run: `pnpm exec vitest run integrations/openai-agents-mcp/tests/boundary.test.ts integrations/openai-agents-mcp/tests/deterministicModel.test.ts`

Expected: FAIL because the consumer and deterministic model do not exist.

- [ ] **Step 3: Implement the minimal consumer**

```ts
export class DeterministicToolModel implements Model {
  constructor(readonly toolName: string, readonly args: Record<string, unknown>) {}
  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    return hasFunctionResult(request.input)
      ? finalResponse('Commander tool result received')
      : functionCallResponse(this.toolName, this.args);
  }
  async *getStreamedResponse(): AsyncIterable<StreamEvent> {
    throw new Error('DETERMINISTIC_STREAMING_UNSUPPORTED');
  }
}
```

`invokeCommanderTool` must create an `MCPServerStdio`, connect it, assert the requested tool is discovered, run an `Agent` with the supplied deterministic or live model, parse the MCP text result as JSON, close the server in `finally`, and return only typed metadata plus the Gateway payload.

- [ ] **Step 4: Run focused tests and typecheck**

Run: `pnpm --filter @commander/openai-agents-mcp test && pnpm --filter @commander/openai-agents-mcp typecheck`

Expected: PASS with no API key.

### Task 2: Real Agents SDK to Commander MCP Transport

**Files:**
- Create: `integrations/openai-agents-mcp/tests/mcpTransport.test.ts`
- Modify if required by the failing compatibility test: `packages/mcp-server/src/stdioServer.ts`
- Modify if required: `packages/mcp-server/tests/stdioServer.test.ts`

**Interfaces:**
- Consumes: built `packages/mcp-server/dist/cli.js` and `invokeCommanderTool`.
- Produces: a real stdio initialization, `tools/list`, and `tools/call` proof against a local HTTP Gateway fixture.

- [ ] **Step 1: Write the black-box transport test**

```ts
it('uses the official Agents SDK MCP client to propose through Commander', async () => {
  const gateway = await startRecordingGateway();
  const result = await invokeCommanderTool({
    mode: 'deterministic',
    toolName: 'commander_action_propose',
    args: rollbackEnvelope,
    gatewayUrl: gateway.url,
    mcpCommand: process.execPath,
    mcpArgs: ['packages/mcp-server/dist/cli.js'],
  });
  expect(gateway.requests).toHaveLength(1);
  expect(gateway.requests[0].path).toBe('/v1/actions');
  expect(result.transport).toBe('mcp-stdio');
});
```

- [ ] **Step 2: Build MCP and verify RED**

Run: `pnpm build:mcp-server && pnpm --filter @commander/openai-agents-mcp test -- mcpTransport.test.ts`

Expected: FAIL until the external invocation and any protocol compatibility gaps are implemented.

- [ ] **Step 3: Make the smallest MCP compatibility correction**

Only change the server if the official client exposes a concrete incompatibility. Preserve newline-delimited JSON-RPC, suppress responses to MCP notifications, and return MCP tool failures as `isError` results rather than successful text when required by the SDK.

- [ ] **Step 4: Verify transport and existing MCP tests**

Run: `pnpm test:mcp-server && pnpm --filter @commander/openai-agents-mcp test`

Expected: both suites PASS and the recording Gateway observes one request.

### Task 3: Route the Existing Kubernetes Proof Through the External Runtime

**Files:**
- Create: `scripts/openai-agents-mcp-fetch.ts`
- Create: `scripts/openai-agents-mcp-fetch.test.ts`
- Modify: `scripts/kubernetes-rollback-kind.ts`
- Modify: `scripts/kubernetes-rollback-kind.test.ts`

**Interfaces:**
- Consumes: public Gateway-shaped `RequestInfo` calls made by `RepositoryKubernetesRollbackKindDriver`.
- Produces: `createOpenAIAgentsMcpFetch(options): typeof fetch`, which maps each request to exactly one canonical MCP tool and invokes the external consumer process.

- [ ] **Step 1: Write request mapping and fail-closed tests**

```ts
it('maps unknown recovery to reconcile and never propose', async () => {
  const calls: ExternalInvocation[] = [];
  const fetch = createOpenAIAgentsMcpFetch({ invoke: recordingInvoker(calls) });
  await fetch('http://gateway/v1/actions/run-1/reconcile', {
    method: 'POST',
    headers: { 'Idempotency-Key': 'reconcile-1' },
  });
  expect(calls).toEqual([{ toolName: 'commander_action_reconcile', args: {
    runId: 'run-1', idempotencyKey: 'reconcile-1',
  }}]);
});
```

Cover propose, get, approve, reconcile, evidence, compensation request, and compensation approval. Reject unsupported paths, missing idempotency keys, malformed bodies, and a second propose after the tracked action reaches `COMPLETION_UNKNOWN`.

- [ ] **Step 2: Run the mapper test and verify RED**

Run: `pnpm exec node --import tsx --test scripts/openai-agents-mcp-fetch.test.ts`

Expected: FAIL because the fetch adapter does not exist.

- [ ] **Step 3: Implement mapping and integrate the Kind CLI mode**

```ts
const fetchPort = process.env.COMMANDER_OPENAI_AGENTS_MCP === '1'
  ? createOpenAIAgentsMcpFetch(externalConsumerOptions(process.env))
  : globalThis.fetch.bind(globalThis);
```

The external invoker uses `spawn`, JSON-only stdin/stdout, an explicit timeout, a scrubbed environment, and a nonzero exit on malformed or unsafe output. The Kind proof's existing state, write-count, reconciliation, compensation, and receipt assertions remain unchanged.

- [ ] **Step 4: Verify mapper and Kind proof unit suite**

Run: `pnpm exec node --import tsx --test scripts/openai-agents-mcp-fetch.test.ts scripts/kubernetes-rollback-kind.test.ts`

Expected: PASS; the unit test proves all action routes use the external invoker when enabled.

### Task 4: Evidence Bundle and Opt-In Live Smoke

**Files:**
- Create: `integrations/openai-agents-mcp/src/evidence.ts`
- Create: `integrations/openai-agents-mcp/tests/evidence.test.ts`
- Create: `scripts/openai-agents-mcp-live-smoke.ts`
- Create: `scripts/openai-agents-mcp-live-smoke.test.ts`
- Create: `docs/artifacts/openai-agents-mcp/example-manifest.json`
- Modify: `.gitignore`
- Modify: `package.json`

**Interfaces:**
- Produces: schema `commander-openai-agents-mcp-proof/v1` and sanitized live schema `commander-openai-agents-mcp-live-smoke/v1`.

- [ ] **Step 1: Write evidence validation and redaction tests**

```ts
it('rejects secrets, prompts, and raw responses in a live record', () => {
  expect(() => validateLiveRecord({ ...validRecord, prompt: 'secret' })).toThrow(
    'LIVE_EVIDENCE_FORBIDDEN_FIELD',
  );
});

it('requires OpenAI identity and a verified receipt', () => {
  expect(() => validateLiveRecord({ ...validRecord, openaiRequestId: '' })).toThrow(
    'OPENAI_REQUEST_OR_TRACE_ID_REQUIRED',
  );
});
```

- [ ] **Step 2: Run tests and verify RED**

Run: `pnpm --filter @commander/openai-agents-mcp test -- evidence.test.ts && pnpm exec node --import tsx --test scripts/openai-agents-mcp-live-smoke.test.ts`

Expected: FAIL because the evidence schemas do not exist.

- [ ] **Step 3: Implement deterministic and live evidence writers**

Hash canonical JSON with SHA-256. Record versions, process identities, ordered MCP tools, action identifiers, state sequence, fault point, exact mutation/query counts, receipt verdict/key/disposition/hash, and artifact hashes. Live output allows only timestamp, explicit model, versions, OpenAI request/trace ID, Commander action ID, receipt hash, and verification verdict.

- [ ] **Step 4: Verify evidence and CLI argument gates**

Run: `pnpm --filter @commander/openai-agents-mcp test && pnpm exec node --import tsx --test scripts/openai-agents-mcp-live-smoke.test.ts`

Expected: PASS; `pnpm openai-agents:mcp:live` without key/model exits nonzero before starting MCP.

### Task 5: CI and Full Verification

**Files:**
- Create: `.github/workflows/openai-agents-mcp.yml`
- Modify: `package.json`
- Modify: `packages/mcp-server/README.md`
- Create: `integrations/openai-agents-mcp/README.md`

**Interfaces:**
- Produces root commands `openai-agents:mcp:test`, `openai-agents:mcp:proof`, and `openai-agents:mcp:live`.

- [ ] **Step 1: Write a static workflow/command test**

Add assertions to `scripts/openai-agents-mcp-fetch.test.ts` that the workflow uses Node 22, frozen pnpm install, builds MCP, runs the deterministic transport test, invokes the G5 Kind proof with `COMMANDER_OPENAI_AGENTS_MCP=1`, and uploads the evidence directory even on failure.

- [ ] **Step 2: Run static test and verify RED**

Run: `pnpm exec node --import tsx --test scripts/openai-agents-mcp-fetch.test.ts`

Expected: FAIL because the workflow and root scripts are absent.

- [ ] **Step 3: Add workflow, scripts, and concise operator docs**

The workflow has a no-key transport job on GitHub-hosted Linux and a full G5 job bound to the existing provisioned Kind/PostgreSQL environment. It never silently downgrades a missing G5 environment to a passing proof; missing prerequisites produce `NOT_READY` and a nonzero exit.

- [ ] **Step 4: Run fresh verification**

Run:

```bash
pnpm install --frozen-lockfile
pnpm build:mcp-server
pnpm openai-agents:mcp:test
pnpm test:mcp-server
pnpm exec node --import tsx --test scripts/kubernetes-rollback-kind.test.ts
pnpm --filter @commander/openai-agents-mcp typecheck
git diff --check
```

Expected: all commands exit 0. Run `pnpm openai-agents:mcp:proof` only when the documented Kind/PostgreSQL/JWKS prerequisites are present; retain its actual verdict without upgrading `NOT_READY`.
