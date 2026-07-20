# Deprecated Authorities

> Auto-generated from `config/deprecated-authorities.json`. Do not edit manually.

| ID | Status | Sunset | Delete After | Replacement | Metric |
|----|--------|--------|--------------|-------------|--------|
| legacy-api-runs | deprecated | 2026-10-15 | 2026-10-31 | /v1/runs | `commander_deprecated_path_requests_total{surface="legacy-api-runs"}` |
| legacy-api-openapi | deprecated | 2026-10-15 | 2026-10-31 | /v1/openapi.json | `commander_deprecated_path_requests_total{surface="legacy-api-openapi"}` |
| legacy-api-execute-surfaces | deprecated | 2026-10-31 | 2026-11-15 | /v1/runs | `commander_deprecated_path_requests_total{surface="legacy-api-execute-surfaces"}` |
| warroom-run-context | deprecated | 2026-11-30 | 2026-12-15 | /v1/runs/:runId | `commander_deprecated_path_requests_total{surface="warroom-run-context"}` |
| sdk-run-status-v1-alias | deleted | 2026-07-19 | 2026-07-19 | RunStateV1 | `commander_deprecated_path_requests_total{surface="sdk-run-status-v1-alias"}` |
| effect-envelope-snake | deprecated | 2027-03-31 | 2027-06-30 | EffectContractV2 | `commander_deprecated_path_requests_total{surface="effect-envelope-snake"}` |
| atr-run-ledger | deprecated | 2027-01-31 | 2027-02-28 | /v1/runs | `commander_deprecated_path_requests_total{surface="atr-run-ledger"}` |
| core-commander-http-server | deprecated | 2026-12-31 | 2027-01-15 | apps/api Gateway | `commander_deprecated_path_requests_total{surface="core-commander-http-server"}` |
