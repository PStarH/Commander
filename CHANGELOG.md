# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- CHANGELOG.md, CODE_OF_CONDUCT.md, SECURITY.md for project governance
- Dependabot configuration for automated dependency updates
- Pull request template for consistent PR descriptions
- npm audit and test coverage checks in CI pipeline

## [0.2.0] — 2026-05-19

### Added
- Agent War Room dashboard GUI (`commander gui` command)
- OpenAPI 3.0 specification served at `/openapi.json`
- Readiness probe (`/ready`) for Kubernetes-style deployment checks
- OpenMetrics/Prometheus-compatible metrics format at `/metrics`
- Multi-tenant isolation with per-tenant rate limits, concurrency, storage, memory
- Circuit breaker for provider failures (threshold → open → half-open → recovery)
- Dead letter queue for unrecoverable errors
- Compensation registry for mutation tool rollback
- Graceful shutdown support in HTTP server
- Dependabot configuration for automated dependency updates

### Changed
- HTTP server binds to localhost by default (security hardening)
- All empty catch blocks replaced with structured logging
- All `console.*` calls replaced with structured logger (zero in production code)
- `as any` usage reduced from 21 to 16 in production code
- Package.json prepared for npm publish (main, types, exports, files, publishConfig)
- CI expanded to 3 jobs: quality, docker, web-gui
- Dockerfile: 6-stage multi-architecture build with health checks

### Fixed
- agentRuntime.ts corruption from earlier catch-block edits (373 lines restored)
- httpServer.ts type errors (3 `string | undefined` → `string` fallbacks)
- `getDefaultProvider` return type (`any` → `LLMProvider`)
- Dynamic `require()` replaced with top-level ESM imports
- Silent catch blocks in skills, codeFixer, JSON.parse, LSP rejection handlers
- GAIA evidence audit trail (broken 10-task run replaced with real 165-task results)

## [0.1.0] — 2026-05-18

### Added
- GAIA 69.7% benchmark (+48.5pp over bare MiMo 21.2%)
- PinchBench 100.0% on core tasks (beat OpenClaw 89.5%)
- BFCL full 35-scenario evaluation (91.4% parameter accuracy)
- MT-Bench 80-question evaluation (6.6/10)
- Unified benchmark runner with YAML config
- CLI: `commander run`, `plan`, `watch`, `status`, `config`, `doctor`, `workers`
- Adaptive temperature controller and codeFixer for syntax repair
- Numeric plausibility check + task-aware confidence thresholds in UnifiedVerification
- Pre-LLM tool provisioning (auto-detect calculation/web search needs)
- MiMo text-format tool call parsing (`<tool_call><function=name>`)
- VerificationLoop with zero-token verifiers (syntax/schema/tool-result) + cache + budget
- 8 providers: OpenAI, Anthropic, Google, DeepSeek, GLM, MiMo, Xiaomi, OpenRouter
- 8 topologies: SINGLE, SEQUENTIAL, PARALLEL, HIERARCHICAL, HYBRID, DEBATE, ENSEMBLE, EVALUATOR-OPT
- ROMA-style task decomposition through atomizer
- Docker multi-stage build (6 stages) and docker-compose deployment
- Nginx configuration for web GUI SPA with API reverse proxy
- MetaLearner with Thompson Sampling and Reflexion
- HTTP API server for runtime management and task execution
- Span-based execution tracing with persistent storage
- Concurrent tool execution and AgentTool with result budgeting
- Commander Arena: 5-agent parallel battle (4.1x speedup)
- TaskPool: parallel multi-agent execution engine

### Changed
- All benchmark reports updated with evidence chains and verified results
- module audit marking `@experimental` components

### Fixed
- Silent catch blocks in authentication provider, HTTP server
- JSON.parse crash in edge cases
- unhandled LSP rejection
- tool call parsing in Xiaomi provider
- multi-turn tool loop for MiMo reasoning models

## [0.0.2] — 2026-05-15

### Added
- Browser search and fetch using stealth Playwright (DuckDuckGo/Brave)
- Public benchmark comparison report
- Transparent performance comparison methodology
- CI workflow setup

### Fixed
- Multi-turn tool loop for MiMo reasoning models
- Skill system integration from OpenClaw/Hermes

## [0.0.1] — 2026-05-14

### Added
- Initial multi-agent orchestration system
- AgentRuntime with LLM → tools → verification → retry loop
- 6 providers (OpenAI, Anthropic, Google, DeepSeek, GLM, Xiaomi)
- MessageBus pub/sub for inter-agent + system events
- Tool system with 15+ built-in tools
- State checkpointer with crash-safe snapshots
- contentScanner for safety checks
- Multi-tenant isolation (NullTenantProvider, SimpleTenantProvider)
- Three-layer memory (working, episodic, long-term)
- Plugin system with hook-based lifecycle
- Hallucination detector with signal-based detection
- Reflection engine for post-execution self-evaluation
- CLI framework with basic command support
- 233+ tests across module, integration, E2E, and chaos tests
- MIT License

[Unreleased]: https://github.com/PStarH/Commander/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/PStarH/Commander/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/PStarH/Commander/compare/v0.0.2...v0.1.0
[0.0.2]: https://github.com/PStarH/Commander/compare/v0.0.1...v0.0.2
[0.0.1]: https://github.com/PStarH/Commander/releases/tag/v0.0.1
