# Architecture Decision Records (ADR)

This directory contains approved architectural decisions for Commander Architecture V2.

## Index

| ADR | Title | Status |
|---|---|---|
| 001 | Resource Model | Approved |
| 002 | Run/Step State Machine | Approved |
| 003 | Persistence and Event Sourcing | Approved |
| 004 | Identity and Capability | Approved |
| 005 | Policy and Effect Broker | Approved |
| 006 | Worker Protocol | Approved |
| 007 | Event Semantics | Approved |

## Status Definitions

- **Proposed**: Under discussion, not yet binding.
- **Approved**: Binding for all new code. Old code must migrate during WP7.
- **Deprecated**: Replaced by a newer ADR.
- **Superseded**: See replacement ADR.

## Feature Freeze Rules

Until WP7 is complete, the following are frozen:

1. No new endpoint families in `apps/api` except `/v1/*` replacements.
2. No new orchestrator implementations in `packages/core`.
3. No new storage backends using SQLite/Map/filesystem as production authority.
4. No new runtime registries or process singletons.
5. All new public types must be defined in `packages/contracts` first.
