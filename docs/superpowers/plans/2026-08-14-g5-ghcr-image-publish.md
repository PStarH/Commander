# G5 GHCR Image Publish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish the exact Gateway and Worker images for an operator-supplied immutable commit SHA to dedicated GHCR packages without changing existing CI/CD behavior.

**Architecture:** A dedicated manual GitHub Actions workflow validates a 40-character SHA, checks out that object, then builds and pushes the API and worker Docker contexts independently. Each image carries OCI source/revision labels; the workflow emits immutable digests and non-secret build provenance as both job summary and artifact.

**Tech Stack:** GitHub Actions, `docker/login-action`, `docker/build-push-action`, `actions/upload-artifact`, Node `node:test` workflow-source contract test.

## Global Constraints

- Create only `.github/workflows/g5-image-publish.yml` and `scripts/g5-image-publish-ci.test.ts` for the implementation.
- Do not modify `.github/workflows/ci.yml`, `.github/workflows/cd.yml`, product code, G5 runtime, Docker/Kind, or cluster state.
- Workflow permissions are exactly `contents: read` and `packages: write`.
- Accept only an immutable 40-character hexadecimal commit SHA; fail before checkout for any other input.
- Publish only `ghcr.io/pstarh/commander-g5-gateway` and `ghcr.io/pstarh/commander-g5-worker`, tagged with the validated SHA and `sha-<SHA>`.
- Artifact and job summary must include source SHA, Dockerfile/context, image reference, and produced digest without credentials.

---

### Task 1: Define the workflow contract

**Files:**

- Create: `scripts/g5-image-publish-ci.test.ts`
- Create: `.github/workflows/g5-image-publish.yml`

**Interfaces:**

- Consumes: manual `commit_sha` workflow input.
- Produces: two GHCR images identified by immutable OCI digest and an artifact named `g5-image-provenance`.

- [ ] **Step 1: Write the failing test**

```ts
assert.match(workflow, /workflow_dispatch:/);
assert.match(workflow, /contents:\s*read/);
assert.match(workflow, /packages:\s*write/);
assert.match(workflow, /\[\[ \"\$\{\{ inputs\.commit_sha \}\}" =~ \^\[0-9a-f\]\{40\}\$ \]\]/);
assert.match(workflow, /ghcr\.io\/pstarh\/commander-g5-gateway/);
assert.match(workflow, /ghcr\.io\/pstarh\/commander-g5-worker/);
assert.match(workflow, /actions\/upload-artifact@v4/);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec node --import tsx --test scripts/g5-image-publish-ci.test.ts`

Expected: FAIL because `.github/workflows/g5-image-publish.yml` does not exist.

- [ ] **Step 3: Write the minimal workflow**

```yaml
permissions:
  contents: read
  packages: write

on:
  workflow_dispatch:
    inputs:
      commit_sha:
        required: true
        type: string
```

Use one validation job for the immutable SHA and one publish job that checks out the validated SHA, logs into `ghcr.io` with `${{ github.token }}`, builds each known Dockerfile/context with OCI labels and `provenance: mode=max`, writes only non-secret image metadata to `g5-image-provenance.json`, uploads that file, and appends the same facts to `$GITHUB_STEP_SUMMARY`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec node --import tsx --test scripts/g5-image-publish-ci.test.ts`

Expected: PASS with all workflow-security and publication assertions green.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/g5-image-publish.yml scripts/g5-image-publish-ci.test.ts docs/superpowers/plans/2026-08-14-g5-ghcr-image-publish.md
git commit -m "ci: add G5 GHCR image publisher"
```

### Task 2: Validate the isolated change

**Files:**

- Verify: `.github/workflows/g5-image-publish.yml`
- Verify: `scripts/g5-image-publish-ci.test.ts`

**Interfaces:**

- Consumes: workflow source and the Node test runner.
- Produces: locally verified source contract, clean formatting, and a normal pre-commit scan.

- [ ] **Step 1: Run focused contract verification**

Run: `pnpm exec node --import tsx --test scripts/g5-image-publish-ci.test.ts`

Expected: PASS.

- [ ] **Step 2: Parse the workflow YAML without executing it**

Run: `pnpm exec tsx -e "import { readFileSync } from 'node:fs'; import { load } from 'js-yaml'; load(readFileSync('.github/workflows/g5-image-publish.yml', 'utf8')); console.log('workflow-yaml-ok')"`

Expected: `workflow-yaml-ok`.

- [ ] **Step 3: Check formatting and diff whitespace**

Run: `pnpm exec prettier --check .github/workflows/g5-image-publish.yml scripts/g5-image-publish-ci.test.ts docs/superpowers/plans/2026-08-14-g5-ghcr-image-publish.md && git diff --check`

Expected: exit 0.

- [ ] **Step 4: Run the normal staged-file hook**

Run: `git add .github/workflows/g5-image-publish.yml scripts/g5-image-publish-ci.test.ts docs/superpowers/plans/2026-08-14-g5-ghcr-image-publish.md && .githooks/pre-commit`

Expected: exit 0 with the staged workflow and test accepted.
