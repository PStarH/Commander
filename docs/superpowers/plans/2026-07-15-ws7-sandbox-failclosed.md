# WS7 Sandbox Fail-Closed Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make production worker boot and command execution reject every unsandboxed path, use Docker by default, support explicit gVisor, and attach every sandboxed command to a tenant/workload identity.

**Architecture:** A shared core `SandboxPolicy` resolves production configuration and is enforced both by the build gate and at runtime. `SandboxManager` selects only the requested production isolation backend, `ExecutionRouter` rejects host/SSH bypasses, and Docker/gVisor command invocations receive server-generated workload labels. Worker boot calls the same readiness gate before registry registration; tenant/run/step metadata is propagated into shell and Python tool calls.

**Tech Stack:** TypeScript 5.x, Node.js 20/22, `node:test`, Vitest, pnpm workspaces, Docker CLI, optional gVisor `runsc`, GitHub Actions.

## Global Constraints

- Production default isolation is `docker`; explicit `gvisor` must never downgrade to ordinary Docker.
- `process` means seccomp/cgroup/network-policy constrained subprocess only; it is not host exec and is rejected by the production policy.
- Production must reject `COMMANDER_ALLOW_NO_SANDBOX`, `COMMANDER_ALLOW_UNCHECKED_EXEC`, plugin `in_process`, SSH, and unwrapped host execution.
- No production command may use NoopSB, an in-process fallback, or an unverified container capability.
- Every workload context contains non-empty `tenantId`, `runId`, `stepId`, and server-generated `workloadId`.
- All tests and code edits happen in `/Users/sampan/Documents/GitHub/Commander-ws7-sandbox-failclosed`; do not modify `master`.

---

### Task 1: Repair the ESM baseline and align fail-closed tests

**Files:**
- Modify: `packages/core/src/sandbox/manager.ts`
- Modify: `packages/core/tests/sandbox-manager-hard-fail.test.ts`
- Modify: `packages/core/tests/sandbox-platforms.test.ts`
- Test: the two files above with `pnpm --dir packages/core exec tsx --test ...`

**Interfaces:**
- `SandboxManager.execute()` continues to return `SandboxExecutionResult`.
- Escape detector calls use the existing named exports `preCheckSandboxEscape` and `postCheckSandboxEscape` from `packages/core/src/security/sandboxEscapeDetector.ts`.

- [x] **Step 1: Keep the failing ESM reproduction and update only stale expectations.**

  Preserve coverage for a successful explicit `full-access` development fallback, but make the existing Noop `network: blocked` test assert exit code `126` and `violated: ['network_policy_not_enforceable']`. The ESM test must continue to exercise `SandboxManager.execute()` without setting `COMMANDER_ALLOW_UNCHECKED_EXEC`.

- [x] **Step 2: Run the focused tests and record the expected RED failure.**

  Run:

  ```bash
  pnpm --dir packages/core exec tsx --test tests/sandbox-manager-hard-fail.test.ts tests/sandbox-platforms.test.ts
  ```

  Expected before the implementation change: the explicit full-access test fails because `require is not defined` causes the detector gate to refuse execution.

- [x] **Step 3: Replace the CommonJS detector load with an ESM-safe static import.**

  Import the detector functions at module scope and remove the `require()` branch. Detector evaluation failures still call `blockedByDetector()` unless the existing development-only `COMMANDER_ALLOW_UNCHECKED_EXEC` flag is explicitly set.

- [x] **Step 4: Run the focused tests GREEN.**

  Run the command from Step 2. Expected: all tests in both files pass, including explicit Noop refusal and explicit full-access development fallback.

### Task 2: Add production policy resolution and the build-time gate

**Files:**
- Create: `packages/core/src/sandbox/productionPolicy.ts`
- Modify: `packages/core/src/sandbox/index.ts`
- Modify: `packages/core/src/index.ts`
- Create: `packages/core/tests/sandbox/productionPolicy.test.ts`
- Create: `scripts/check-production-sandbox.ts`
- Modify: `packages/core/package.json`
- Modify: `package.json`

**Interfaces:**
- `SandboxIsolation = 'process' | 'docker' | 'gvisor'`.
- `SandboxEnvironment = 'development' | 'test' | 'staging' | 'production'`.
- `resolveSandboxPolicy(env?: NodeJS.ProcessEnv): SandboxPolicy` returns the environment, requested isolation, and fail-closed flags.
- `assertProductionSandboxPolicy(policy: SandboxPolicy): void` throws `SandboxPolicyError` for forbidden production configuration.
- `assertProductionSandboxSource(root?: string): void` rejects a declared `ALLOW_NO_SANDBOX` constant or a production entrypoint that exposes host execution.
- `assertProductionSandboxReady(options?: { policy?: SandboxPolicy; availableMechanisms?: readonly string[] }): void` rejects missing selected backend and all production fallbacks.

- [x] **Step 1: Write policy RED tests.**

  Cover these exact cases:

  ```ts
  it('defaults production to docker', () => {
    assert.equal(resolveSandboxPolicy({ NODE_ENV: 'production' }).isolation, 'docker');
  });

  it('requires gVisor when explicitly selected', () => {
    assert.throws(() => assertProductionSandboxReady({
      policy: resolveSandboxPolicy({ NODE_ENV: 'production', COMMANDER_SANDBOX_ISOLATION: 'gvisor' }),
      availableMechanisms: ['docker'],
    }), /gvisor/);
  });

  it('rejects every no-sandbox production bypass', () => {
    assert.throws(() => resolveSandboxPolicy({ NODE_ENV: 'production', COMMANDER_ALLOW_NO_SANDBOX: 'true' }), /ALLOW_NO_SANDBOX/);
  });
  ```

  Also test production rejection of `COMMANDER_ALLOW_UNCHECKED_EXEC`, `COMMANDER_PLUGIN_SANDBOX=in_process`, `COMMANDER_PLUGIN_SANDBOX_SOFT`, and `COMMANDER_SANDBOX_ISOLATION=process`.

- [x] **Step 2: Run the policy tests to verify RED.**

  Run:

  ```bash
  pnpm --dir packages/core exec tsx --test tests/sandbox/productionPolicy.test.ts
  ```

  Expected: module/export failures because the policy module does not yet exist.

- [x] **Step 3: Implement the policy module without an `ALLOW_NO_SANDBOX` production constant.**

  Parse only the three supported isolation values, default production to Docker, reject truthy bypass flags, and require the selected mechanism in `availableMechanisms`. Keep development/test platform discovery and explicit test dependency injection separate from production policy.

- [x] **Step 4: Add the static production build check and package scripts.**

  `scripts/check-production-sandbox.ts` must scan the production policy, manager, router, and plugin sandbox sources for a declaration matching `(?:const|let|var)\\s+ALLOW_NO_SANDBOX\\b` and fail non-zero if found. It must also verify the policy module exports the production readiness guard.

  Add:

  ```json
  {
    "build:production": "tsx ../../scripts/check-production-sandbox.ts && tsc -p tsconfig.json && node ../../scripts/fix-esm-imports.mjs dist"
  }
  ```

  to `packages/core/package.json`, and add the root `build:production` script delegating to `@commander/core`.

- [x] **Step 5: Run policy tests and the production build check GREEN.**

  Run:

  ```bash
  pnpm --dir packages/core exec tsx --test tests/sandbox/productionPolicy.test.ts
  pnpm --filter @commander/core build:production
  ```

### Task 3: Enforce policy in SandboxManager and ExecutionRouter

**Files:**
- Modify: `packages/core/src/sandbox/types.ts`
- Modify: `packages/core/src/sandbox/manager.ts`
- Modify: `packages/core/src/sandbox/executionRouter.ts`
- Modify: `packages/core/src/sandbox/backends/localBackend.ts`
- Create: `packages/core/tests/sandbox/boot-refuse.test.ts`
- Modify: `packages/core/tests/execution-backends.test.ts`

**Interfaces:**
- `SandboxWorkloadContext = { tenantId: string; runId: string; stepId: string; workloadId: string }`.
- `PlatformSandbox.execute(command, profile, workdir?, context?): Promise<SandboxExecutionResult>`.
- `SandboxManager.execute(command, profile?, workdir?, mechanism?, context?): Promise<SandboxExecutionResult>`.
- `SandboxInitializationError` remains the startup failure type.

- [x] **Step 1: Write boot-refuse and host-bypass RED tests.**

  Add tests proving that a production manager with no Docker backend, a production manager with `allowNoSandbox: true`, a production `COMMANDER_ALLOW_NO_SANDBOX`, a production explicit SSH backend, and a production explicit host/local fallback all reject before command execution. Use fake backends and a `commandInvoked` boolean so the test proves the command was not run.

- [x] **Step 2: Run the boot-refuse tests to verify RED.**

  Run:

  ```bash
  pnpm --dir packages/core exec tsx --test tests/sandbox/boot-refuse.test.ts tests/execution-backends.test.ts
  ```

- [x] **Step 3: Resolve policy in SandboxManager construction.**

  Production construction must ignore no-sandbox fallback settings, choose Docker by default, choose only gVisor when explicitly requested, reject `process`, and throw before returning a manager when the selected mechanism is unavailable. Development/test behavior remains injectable for existing unit tests.

- [x] **Step 4: Propagate workload context and reject bypass backends.**

  Pass `SandboxWorkloadContext` from `SandboxManager` to the selected platform backend. In `ExecutionRouter.selectBackend()`, reject production SSH, arbitrary `docker_exec`, and user-selected host backend values with a policy error; the default local adapter is allowed only when it routes into the selected OS-level sandbox.

- [x] **Step 5: Run the focused tests GREEN.**

  Run the command from Step 2 and verify the refusal result has non-zero exit status, no backend invocation, and an explicit policy error.

### Task 4: Make Docker/gVisor executions workload-scoped

**Files:**
- Modify: `packages/core/src/sandbox/platforms.ts`
- Modify: `packages/core/src/tools/sandboxedExec.ts`
- Modify: `packages/core/src/tools/codeExecutionTool.ts`
- Modify: `packages/core/src/runtime/toolExecutionService.ts`
- Create: `packages/core/tests/sandbox/workload-context.test.ts`

**Interfaces:**
- Internal tool metadata keys are `_tenantId`, `_runId`, `_stepId`, and `_workloadId`; users cannot provide the generated workload ID.
- `SandboxWorkloadContext` is validated before a production Docker/gVisor invocation.

- [x] **Step 1: Write workload-context RED tests.**

  Test that `ToolExecutionService` passes server-generated tenant/run/step/workload metadata to shell/Python execution, that invalid or cross-tenant context is rejected, and that two contexts produce different container labels/names. Keep the Docker CLI invocation behind an injectable argument builder or fake spawn so CI does not require Docker.

- [x] **Step 2: Run the workload tests to verify RED.**

  Run:

  ```bash
  pnpm --dir packages/core exec tsx --test tests/sandbox/workload-context.test.ts
  ```

- [x] **Step 3: Propagate metadata through tool execution.**

  Add server-owned internal metadata to the sanitized execution arguments in `ToolExecutionService`; update Python and shell tools to forward the metadata to `execSandboxed()`. Do not trust user-supplied `_workloadId`; overwrite it from `(runId, toolCall.id)`.

- [x] **Step 4: Add Docker/gVisor labels and lifecycle flags.**

  Add generated `--name` and `--label commander.tenant_id=...`, `commander.run_id=...`, `commander.step_id=...`, and `commander.workload_id=...` to the existing `docker run --rm` paths. Preserve read-only rootfs, `cap-drop=ALL`, `no-new-privileges`, tmpfs, CPU/memory limits, filtered environment, and gVisor `--runtime runsc`; never add host PID/network/IPC or Docker socket mounts.

- [x] **Step 5: Run workload tests and existing sandbox tests GREEN.**

  Run the workload test, the two focused core sandbox suites, and the execution backend suite.

### Task 5: Gate Worker boot before registration and preserve lease fail-closed behavior

**Files:**
- Modify: `packages/worker-plane/src/types.ts`
- Modify: `packages/worker-plane/src/workerService.ts`
- Modify: `packages/worker-plane/src/bootstrap.ts`
- Create: `packages/worker-plane/src/sandboxReadiness.ts`
- Modify: `packages/worker-plane/src/workerService.test.ts`
- Modify: `packages/worker-plane/src/bootstrap.policy.test.ts`
- Create: `packages/worker-plane/src/boot-refuse.test.ts`

**Interfaces:**
- `WorkerSandboxReadiness = { assertReady(): Promise<void> }`.
- `WorkerServiceConfig.sandboxReadiness?: WorkerSandboxReadiness`.
- `createProductionWorkerSandboxReadiness(env?: NodeJS.ProcessEnv): WorkerSandboxReadiness` dynamically loads the core policy/manager only for production.

- [x] **Step 1: Write Worker RED tests.**

  Add a readiness fake that throws `SANDBOX_UNAVAILABLE`, assert `WorkerService.start()` rejects before `registry.initialize()` or `registry.register()`, and assert a normal fake readiness allows the existing claim/complete tests to pass. Add a boot-refuse test with production `COMMANDER_ALLOW_NO_SANDBOX=true` that rejects before database access.

- [x] **Step 2: Run Worker tests to verify RED.**

  Build workspace dependencies first, then run:

  ```bash
  pnpm --filter @commander/contracts build
  pnpm --filter @commander/plugin-sdk build
  pnpm --filter @commander/kernel build
  pnpm --filter @commander/effect-broker build
  pnpm --filter @commander/core build
  pnpm --filter @commander/worker-plane build
  pnpm exec tsx --test packages/worker-plane/src/boot-refuse.test.ts packages/worker-plane/src/workerService.test.ts packages/worker-plane/src/bootstrap.policy.test.ts
  ```

- [x] **Step 3: Call readiness before Worker registration.**

  In `WorkerService.start()`, call `sandboxReadiness.assertReady()` before registry initialization. In `createWorkerService()`, call `createProductionWorkerSandboxReadiness()` before opening PostgreSQL or constructing executors. A failed readiness check must throw `SANDBOX_UNAVAILABLE` and must not claim work.

- [x] **Step 4: Preserve lease failure semantics.**

  When the executor/sandbox reports `SANDBOX_UNAVAILABLE` after claim, `WorkerService.execute()` must call `failStep` with that code and must not call `completeStep`. Existing heartbeat and retry semantics remain unchanged.

- [x] **Step 5: Run Worker tests GREEN.**

  Re-run the command from Step 2 and verify both boot refusal and normal Worker execution.

### Task 6: Add CI gates and complete the audit

**Files:**
- Modify: `.github/workflows/ci.yml`
- Modify: `spec/ws7-sandbox-failclosed.md`

- [x] **Step 1: Add CI production build and boot-refuse steps.**

  Run the static production check/build and the core/worker boot-refuse tests in a job environment with `NODE_ENV=production` and `COMMANDER_ALLOW_NO_SANDBOX=true`; the test must pass only when the process rejects before command/registry execution. Do not make the existing development test step a production environment.

- [x] **Step 2: Run the full relevant verification locally.**

  Run:

  ```bash
  pnpm --filter @commander/core build:production
  pnpm --filter @commander/core exec tsx --test tests/sandbox-manager-hard-fail.test.ts tests/sandbox-platforms.test.ts tests/sandbox/productionPolicy.test.ts tests/sandbox/boot-refuse.test.ts tests/sandbox/workload-context.test.ts tests/execution-backends.test.ts
  pnpm --filter @commander/worker-plane build
  pnpm exec tsx --test packages/worker-plane/src/boot-refuse.test.ts packages/worker-plane/src/workerService.test.ts packages/worker-plane/src/bootstrap.policy.test.ts
  pnpm exec prettier --check packages/core/src/sandbox packages/core/tests/sandbox packages/worker-plane/src/sandboxReadiness.ts packages/worker-plane/src/boot-refuse.test.ts scripts/check-production-sandbox.ts
  ```

- [x] **Step 3: Audit the spec line by line.**

  Verify the default, forbidden configurations, boot refusal, no fallback, workload identity, Docker/gVisor flags, Worker integration, and CI evidence. Mark the spec `ACCEPTED` only after every checklist item has a test/build/CI artifact.

- [x] **Step 4: Review the diff and report residual risk.**

  Run `git diff --check`, inspect `git diff --stat` and the complete diff, and explicitly report any Docker daemon/gVisor integration that could not be live-tested in the current environment.
