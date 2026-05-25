# BFCL Subset Results

Commander currently reports three BFCL-compatible, unofficial subsets. These are
not official Berkeley Function Calling Leaderboard submissions.

| Dataset | Evidence | Tool selection | Parameter accuracy |
|---|---|---:|---:|
| 35-scenario general subset | `results_full.json` + `responses_full/` | 60.0% | 91.4% |
| 30-task Commander rerun | `../../docs/benchmark-results/bfcl/results.json` | 80.0% | 80.0% |
| 12-core subset | `results.json` + `responses/` | 91.7% | 91.7% |

Verify the checked-in score files:

```bash
pnpm --filter @commander/core benchmark:verify
```

The verifier recomputes tool-selection and parameter percentages from the raw
checked-in counts, then compares them with
`docs/benchmark-results/bfcl/summary.json`. Any mismatch exits non-zero and is
blocked by CI.

Before publishing a leaderboard claim, run the official BFCL full suite and add
the exact command, model, provider, date, and raw outputs here.
