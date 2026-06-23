## Summary

<!-- One to two sentences describing the change. What problem does it solve?
     What is the motivation? -->

## Type of Change

<!-- Mark the relevant option(s) with an 'x'. -->

- [ ] Bug fix (non-breaking change that fixes an issue)
- [ ] New feature (non-breaking change that adds functionality)
- [ ] Breaking change (fix or feature that would cause existing functionality to change)
- [ ] Performance improvement
- [ ] Code quality / refactoring
- [ ] Documentation update
- [ ] Test improvement
- [ ] CI / build / dependency update

## Checklist

<!-- All items must be checked before the PR is ready for review. -->

- [ ] `cd packages/core && pnpm test` — all 2400+ tests pass
- [ ] `cd packages/core && npx tsc --noEmit` — zero compilation errors
- [ ] Code follows TypeScript strict mode; avoid `as any` and `@ts-ignore` in production code
- [ ] No empty `catch {}` blocks — all errors are logged via `getGlobalLogger()`
- [ ] No `console.*` calls in production code (use `getGlobalLogger()` instead)
- [ ] New functionality includes tests where applicable
- [ ] Documentation updated if public API changed

## Testing

<!-- Describe how you tested this change. Include reproduction steps for
     bug fixes, and expected behavior for new features. -->

## Additional Context

<!-- Any additional information, screenshots, or relevant links. -->
