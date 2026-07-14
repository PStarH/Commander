You are running ONE iteration of Commander module refinement.

Target module: {{MODULE}}

Goal:
Improve code quality and maintainability of this module without open-ended rewrites.

This iteration must do exactly this:
1. Audit the target module for maintainability / best-practice issues
2. Select only top 3 S1 issues, or top 5 combined S1/S2 if fewer than 3 S1
3. Implement fixes only for those selected issues
4. Run relevant tests / typecheck / lint / smoke checks
5. Re-audit the module
6. End by outputting exactly one of:
   STOP_MODULE_REFINEMENT
   CONTINUE_MODULE_REFINEMENT

Rules:
- Only work inside the target module unless a tiny compatibility fix is unavoidable
- Preserve public behavior
- No speculative rewrites
- No feature work
- No architecture redesign
- Prefer small safe refactors
- Add/update tests for touched code where appropriate

Output sections:
1. Initial backlog
2. Selected fixes
3. Changes made
4. Verification results
5. Remaining S1/S2
6. Final decision
