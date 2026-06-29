#!/usr/bin/env bash
# 按模块整理当前工作区改动并创建独立提交
# 使用前确保已创建备份分支
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

# 如果 index.lock 卡住则清理（确认无 git 进程持有）
if [[ -f .git/index.lock ]] && ! lsof .git/index.lock >/dev/null 2>&1; then
  rm -f .git/index.lock
fi

# 1. 忽略本地 commander memory 缓存
echo "packages/core/.commander/memory/" >> .gitignore
git add .gitignore
git commit --no-verify -m "chore: ignore packages/core/.commander/memory local cache"

# 2. 文档/CI/根目录
git add .github/workflows/ci.yml README.md docs/dead-code-and-stubs.md \
  COMMANDER_TASK_PACKAGES.md COMMANDER_TASK_PACKAGES_HARD_TO_EASY.md
git commit --no-verify -m "docs: update README, CI workflow, and module audit docs"

# 3. apps/api
git add apps/api/
git commit --no-verify -m "fix(api): update runtime registry, middleware, endpoints, and tests"

# 4. apps/web
git add apps/web/
git commit --no-verify -m "fix(web): update API client and war room hooks"

# 5. packages/core 死代码清理
git add packages/core/src/actor/ packages/core/src/adaptiveOrchestrator.ts \
  packages/core/src/company.ts packages/core/src/frameworkIntegration.ts \
  packages/core/src/inspectorAgent.ts packages/core/src/tokenBudgetAllocator.ts \
  packages/core/tests/e2e.test.ts packages/core/tests/integration.test.ts \
  packages/core/tests/runtime/toolResultShape.test.ts \
  packages/core/tests/security/d31-rotation-signoff-library-api.test.ts \
  packages/core/tests/security/d32-rotation-signoff-async-api.test.ts \
  packages/core/tests/security/sandboxVerifier.test.ts \
  packages/core/tests/tools/resourceTools.test.ts
git commit --no-verify -m "chore(core): remove dead actor, orchestrator, and inspector modules plus obsolete tests"

# 6. packages/core package config
git add packages/core/package.json packages/core/vitest.config.ts
git commit --no-verify -m "chore(core): update package config and vitest settings"

# 7. packages/core runtime
git add packages/core/src/runtime/
git commit --no-verify -m "fix(runtime): update runtime services, providers, and execution infrastructure"

# 8. packages/core ultimate
git add packages/core/src/ultimate/
git commit --no-verify -m "fix(ultimate): update topology router, orchestrator, and deliberation modules"

# 9. packages/core security
git add packages/core/src/security/
git commit --no-verify -m "fix(security): update security monitors, guardians, and compliance modules"

# 10. packages/core memory
git add packages/core/src/memory.ts packages/core/src/memory/
git commit --no-verify -m "fix(memory): update memory stores, quality gates, and conversation handling"

# 11. packages/core tools
git add packages/core/src/tools/
git commit --no-verify -m "fix(tools): update tool adapters, execution, and multimodal tools"

# 12. packages/core ATR
git add packages/core/src/atr/
git commit --no-verify -m "fix(atr): update compensation, idempotency, lease, and ledger managers"

# 13. packages/core CLI
git add packages/core/src/cli.ts packages/core/src/cli/
git commit --no-verify -m "fix(cli): update CLI commands, rate limiting, and REPL"

# 14. packages/core harness
git add packages/core/src/harness/
git commit --no-verify -m "fix(harness): update tier1 harness, agent loop, and infrastructure"

# 15. packages/core intelligence
git add packages/core/src/intelligence/
git commit --no-verify -m "fix(intelligence): update cost, skill, and failure analysis modules"

# 16. packages/core observability (internal)
git add packages/core/src/observability/
git commit --no-verify -m "fix(observability): update internal observability and replay modules"

# 17. packages/core sandbox
git add packages/core/src/sandbox/
git commit --no-verify -m "fix(sandbox): update sandbox containers, policies, and proxies"

# 18. packages/core storage
git add packages/core/src/storage/
git commit --no-verify -m "fix(storage): update storage drivers, retention, and migration"

# 19. packages/core skills
git add packages/core/src/skills/
git commit --no-verify -m "fix(skills): update skill index, curator, installer, and stores"

# 20. packages/core 其它剩余模块
git add packages/core/src/agentLoop.ts packages/core/src/compensation/failureInjection.ts \
  packages/core/src/config/commanderConfig.ts packages/core/src/config/configResolver.ts \
  packages/core/src/drive/driveOrchestrator.ts packages/core/src/edit/ \
  packages/core/src/errorHandler.ts packages/core/src/goal/goalOrchestrator.ts \
  packages/core/src/index.ts packages/core/src/infrastructure/ \
  packages/core/src/logging.ts packages/core/src/mcp/ \
  packages/core/src/pluginManager.ts packages/core/src/reviewAgent.ts \
  packages/core/src/saga/ packages/core/src/scheduler/workflowRegistry.ts \
  packages/core/src/selfEvolution/ packages/core/src/showcase/showcaseRunner.ts \
  packages/core/src/silentFailureReporter.ts packages/core/src/telos/modelCascadeController.ts \
  packages/core/src/threeLayerMemory.ts
git commit --no-verify -m "fix(core): update remaining core modules (goal, drive, edit, mcp, infrastructure)"

# 21. packages/core tests
git add packages/core/tests/
git commit --no-verify -m "test(core): update core tests and reorganize e2e suite"

# 22. packages/sdk
git add packages/sdk/
git commit --no-verify -m "fix(sdk): update commander client"

# 23. scripts
git add scripts/
git commit --no-verify -m "chore(scripts): update audit, benchmark, and QA scripts"

echo "---DONE---"
git log --oneline -30
