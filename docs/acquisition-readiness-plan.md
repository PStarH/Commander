# Commander Acquisition Readiness Plan

目标：把 Commander 打造成可被战略买方或企业客户认真尽调的 agent 产品，而不是只靠 demo 和 benchmark 叙事出售。

## North Star

Commander 的可出售资产必须同时成立：

1. Product: 有可部署、可试用、可观测、可计费的 agent 平台体验。
2. Moat: 有可复现 benchmark、独特 orchestration IP、跨 provider 执行能力和学习闭环。
3. Diligence: 安全、测试、许可证、CI、文档、基准数据经得起第三方审计。
4. Distribution: 有清晰 ICP、demo 路径、pricing、enterprise deployment story。

## 30-Day Ship List

| Priority | Outcome | Verification |
|---|---|---|
| P0 | BFCL/GAIA/PinchBench numbers have exact evidence paths and reproduction notes | `pnpm --filter @commander/core benchmark:verify` |
| P0 | HTTP API does not retain raw API keys after startup | `npx vitest run tests/httpServer.test.ts` |
| P0 | Sandbox full-access mode still filters secrets | `npx tsx --test tests/sandbox-security.test.ts` |
| P0 | Exec policy catches pipes, substitution, env-prefix commands, symlinked command paths | `npx tsx --test tests/sandbox-security.test.ts` |
| P0 | Provider streaming is real, not a method-name stub | `npx vitest run tests/telos/providerPool.test.ts` |
| P1 | Full core test suite is green in CI | `pnpm --filter @commander/core test` |
| P1 | CI proves no test runner config silently omits tests | `pnpm --filter @commander/core test:inventory` |
| P1 | Coverage report exists and is published as CI artifact | `pnpm --filter @commander/core test:coverage` |
| P1 | Enterprise deployment has a hardened compose path and health/readiness probes | `docker compose -f docker-compose.prod.yml config` |
| P1 | Product demo can be run from a clean clone in less than 10 minutes | `git clean -xfd && pnpm install && pnpm test && pnpm dev` |

## Product Packaging

### Buyer-Facing Positioning

Commander is an enterprise agent runtime for real-time, multi-provider, multi-agent task execution. The differentiator is not "another agent framework"; it is the combination of topology routing, live execution visibility, tenant-aware runtime controls, and benchmark-backed tool execution quality.

### Demo Tracks

1. Engineering copilot: inspect a repo, plan changes, apply patch, run tests, produce review.
2. Operations agent: execute a scheduled workflow with approval gates, audit logs, and SSE trace.
3. Enterprise runtime: multi-tenant API execution, rate limits, metrics, health checks, hashed API keys.
4. Research swarm: parallel workers synthesize a report with traceable intermediate outputs.

### Packaging Tiers

| Tier | Target | Must Have |
|---|---|---|
| OSS Core | Developers | CLI, provider adapters, local tools, benchmark evidence |
| Pro | Teams | Web dashboard, session history, persisted memory, project workspaces |
| Enterprise | Buyers | Tenant isolation, RBAC/API keys, audit logs, SSO-ready auth boundary, deployment guide |

## Diligence Gates

Run these before any investor/customer demo branch is cut:

```bash
git status --short
pnpm --filter @commander/core test
pnpm --filter @commander/core build
npx tsc --noEmit
docker compose -f docker-compose.prod.yml config
```

Cut a demo branch only from a clean tree:

```bash
git checkout -b release/acquisition-demo
git add README.md docs packages/core
git commit -m "Prepare acquisition-ready Commander demo"
git tag acquisition-demo-YYYYMMDD
```

## 90-Day Roadmap

| Window | Work | Exit Criteria |
|---|---|---|
| Week 1-2 | Close P0 security and benchmark credibility issues | No plaintext server API keys, reproducible benchmark docs, streaming implemented |
| Week 3-4 | Stabilize CI and tests | Core suite green, coverage artifact published, flaky tests documented or fixed |
| Month 2 | Productize enterprise runtime | RBAC-backed auth, tenant dashboard, audit exports, hardened deploy guide |
| Month 3 | Sales-ready demo and proof package | 4 demo tracks, benchmark replay scripts, architecture one-pager, security notes |

## Valuation Narrative

The 2000w story is credible only if the buyer can verify:

1. The benchmark claims are exact and reproducible.
2. The runtime has enterprise controls competitors lack.
3. The product can be deployed by a third party without founder hand-holding.
4. The codebase has enough tests and observability to survive acquisition integration.
5. The roadmap converts from OSS framework into paid enterprise runtime.

Do not pitch revenue multiples until the product has paying pilots. Until then, pitch strategic asset value: orchestration IP, provider-neutral runtime, benchmark-backed execution quality, and enterprise control plane.
