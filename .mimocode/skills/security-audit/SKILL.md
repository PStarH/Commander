---
name: security-audit
description: Perform structured security vulnerability analysis on TypeScript/JavaScript files, producing severity-rated reports with fix recommendations
version: 1.0
tags: [security, audit, vulnerability, analysis]
---

# Security Audit Skill

Perform structured security vulnerability analysis on code files, producing severity-rated reports with fix recommendations.

## When to Use

- Analyzing files for security vulnerabilities (injection, sandbox escape, input validation)
- Producing unified security reports across multiple files
- Creating actionable fix recommendations with priority ratings

## Workflow

### 1. Identify Scope

```bash
# List target files
ls -la packages/core/src/runtime/*.ts
```

### 2. Analyze Each File

For each target file, examine:
- Input validation and sanitization
- Injection risks (command injection, path traversal, prototype pollution)
- Sandbox escape possibilities
- Authentication/authorization bypasses
- Sensitive data exposure
- Race conditions in concurrent access

### 3. Spawn Explore Subagents (for multi-file audits)

Use the Agent tool to find related security-critical files:

```
subagent_type: Explore
description: Find security-relevant code
prompt: Search the codebase for security-relevant code related to [TARGET]. Look for:
1. ExecPolicyEngine and sandbox enforcement
2. Tool call validation
3. Authentication/authorization
4. Input sanitization
```

### 4. Generate Report

Write report to `/tmp/security-audit-[TARGET].md` with:

```markdown
# Security Audit Report: [TARGET]

**File:** [path]
**Date:** [date]
**Auditor:** [agent]
**Scope:** [scope]

---

## Executive Summary
[2-3 sentence overview]

## Severity Scale
- CRITICAL: Immediate exploitation risk
- HIGH: Significant vulnerability requiring prompt fix
- MEDIUM: Vulnerability requiring attention
- LOW: Minor issue or defense-in-depth improvement
- INFO: Observation or best practice recommendation

## Findings

### [F1] [Title]
**Severity:** [CRITICAL/HIGH/MEDIUM/LOW/INFO]
**Location:** [file:line]
**Description:** [detailed description]
**Impact:** [potential impact]
**Recommendation:** [specific fix]

[Repeat for each finding]

## Recommendations Summary
[Prioritized list of fixes]
```

### 5. Cross-Reference Findings

When auditing multiple files, merge findings into unified report:

```bash
# Combine reports
cat /tmp/security-audit-*.md > /tmp/security-audit-unified.md
```

## Example Prompts

**Single file:**
> Analyze the file packages/core/src/runtime/agentRuntime.ts for security vulnerabilities. Focus on: input validation, injection risks, sandbox escape possibilities.

**Multi-file:**
> Analyze ALL of these files for security vulnerabilities and produce a unified report:
> 1. packages/core/src/runtime/agentRuntime.ts
> 2. packages/core/src/sandbox/execPolicy.ts
> 3. packages/core/src/runtime/toolCallValidator.ts

## Output Location

- Individual reports: `/tmp/security-audit-[TARGET].md`
- Unified report: `/tmp/security-audit-unified.md`

## Validation

After generating report:
1. Verify all findings reference actual code locations
2. Ensure recommendations are specific and actionable
3. Check severity ratings align with CVSS-like assessment
4. Confirm no false positives (verify each finding against actual code)
