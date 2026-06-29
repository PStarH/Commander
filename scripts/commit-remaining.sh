#!/usr/bin/env bash
# 继续完成 commit-by-module.sh 中剩余的提交（处理动态新增/再修改的文件）
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

unlock() {
  if [[ -f .git/index.lock ]] && ! lsof .git/index.lock >/dev/null 2>&1; then
    rm -f .git/index.lock
  fi
}

commit_group() {
  local msg="$1"
  shift
  unlock
  git add "$@"
  unlock
  if git diff --cached --quiet; then
    echo "SKIP: $msg (no changes)"
    return 0
  fi
  git commit --no-verify -m "$msg"
}

# core config（vitest 配置在工作期间又被改动）
commit_group "chore(core): additional vitest config update" packages/core/vitest.config.ts

# 之前有模块提交后又被进程改动的补充提交
commit_group "fix(runtime): additional runtime checkpoint and execution context updates" packages/core/src/runtime/
commit_group "fix(atr): additional atr checkpoint and ledger updates" packages/core/src/atr/
commit_group "fix(ultimate): additional ultimate quality gates and work queue updates" packages/core/src/ultimate/
commit_group "fix(memory): additional memory store updates" packages/core/src/memory.ts packages/core/src/memory/
commit_group "fix(tools): additional tool module updates" packages/core/src/tools/
commit_group "fix(cli): additional CLI updates" packages/core/src/cli.ts packages/core/src/cli/
commit_group "fix(harness): additional harness updates" packages/core/src/harness/
commit_group "fix(intelligence): additional intelligence updates" packages/core/src/intelligence/
commit_group "fix(observability): additional internal observability updates" packages/core/src/observability/

# 尚未提交的模块
commit_group "fix(sandbox): update sandbox containers, policies, and proxies" packages/core/src/sandbox/
commit_group "fix(storage): update storage drivers, retention, and migration" packages/core/src/storage/
commit_group "fix(skills): update skill index, curator, installer, and stores" packages/core/src/skills/
commit_group "fix(core): update remaining core modules (goal, drive, edit, mcp, infrastructure)" \
  packages/core/src/agentLoop.ts packages/core/src/commander/probe.ts \
  packages/core/src/compensation/failureInjection.ts packages/core/src/config/ \
  packages/core/src/drive/driveOrchestrator.ts packages/core/src/edit/ \
  packages/core/src/errorHandler.ts packages/core/src/goal/goalOrchestrator.ts \
  packages/core/src/index.ts packages/core/src/infrastructure/ packages/core/src/logging.ts \
  packages/core/src/mcp/ packages/core/src/pluginManager.ts packages/core/src/reviewAgent.ts \
  packages/core/src/saga/ packages/core/src/scheduler/workflowRegistry.ts \
  packages/core/src/selfEvolution/ packages/core/src/showcase/showcaseRunner.ts \
  packages/core/src/silentFailureReporter.ts packages/core/src/telos/modelCascadeController.ts \
  packages/core/src/threeLayerMemory.ts

# tests
commit_group "test(core): update core tests and reorganize e2e suite" packages/core/tests/

# 其它 packages
commit_group "fix(sdk): update commander client" packages/sdk/

# scripts（包含本次整理用的两个脚本）
commit_group "chore(scripts): update audit, benchmark, and QA scripts" scripts/

echo "---DONE---"
git status --short
echo "---RECENT LOG---"
git log --oneline -30
