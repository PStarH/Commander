---
name: quality-comparison
description: Run quality comparison tests across different model configurations, analyzing success rates, token usage, and cost efficiency
version: 1.0
tags: [quality, comparison, testing, benchmark, models]
---

# Quality Comparison Skill

Run quality comparison tests across different model configurations, analyzing success rates, token usage, and cost efficiency.

## When to Use

- Comparing performance of different LLM models on the same task
- Testing impact of prompt modifications (system prompts, structured output, etc.)
- Benchmarking cost efficiency across configurations
- Validating quality improvements before production deployment

## Workflow

### 1. Create Test Script

Write test script to `packages/core/tests/quality-comparison.ts`:

```typescript
#!/usr/bin/env npx tsx
import * as fs from 'fs';
import { execSync } from 'child_process';

const TASK = `[YOUR_TASK_HERE]`;

async function runComparison() {
  const results = [];
  
  // Run with different configurations
  for (const config of configurations) {
    const start = Date.now();
    // ... run test
    results.push({ config, duration: Date.now() - start, ... });
  }
  
  // Analyze results
  console.log(JSON.stringify(results, null, 2));
}

runComparison();
```

### 2. Run Test

```bash
npx tsx packages/core/tests/quality-comparison.ts 2>&1
```

### 3. Analyze Results

Parse output for:
- Success rate per configuration
- Average token usage
- Cost per successful task
- Duration and latency

### 4. Clean Up

```bash
rm -f packages/core/tests/quality-comparison.ts
```

## Common Test Patterns

### Model Comparison
```typescript
const configurations = [
  { name: 'gpt-4o', model: 'gpt-4o' },
  { name: 'claude-opus', model: 'claude-opus-4-20250514' },
  { name: 'gemini-pro', model: 'gemini-pro' },
];
```

### Prompt Variation
```typescript
const configurations = [
  { name: 'baseline', systemPrompt: DEFAULT },
  { name: 'with-structured-output', systemPrompt: STRUCTURED },
  { name: 'with-template-analysis', systemPrompt: TEMPLATE },
];
```

### Cost Efficiency
```typescript
// Track cost per successful task
const costPerSuccess = totalCost / successfulTasks;
```

## Output Location

- Results: `benchmarks/pinchbench/results/` or `/tmp/quality-results.json`
- Summary: Console output (capture with `2>&1`)

## Validation

After running:
1. Verify all configurations completed successfully
2. Check for statistical significance (multiple runs)
3. Validate cost calculations against provider pricing
4. Ensure results are reproducible

## Example Usage

**Compare models:**
> Run quality comparison between gpt-4o and claude-opus on security audit task

**Test prompt improvement:**
> Test if structured output prompt improves success rate on multi-file analysis

**Cost optimization:**
> Compare cost efficiency of different model configurations for the same task
