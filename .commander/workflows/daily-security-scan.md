---
name: daily-security-scan
description: Scan all changed dependencies for known CVEs and audit code changes
topology: SEQUENTIAL
effort: high
trigger:
  cron: "0 6 * * 1-5"
---

## Steps

### 1. Dependency scan
goal: Scan all dependencies for known CVEs
tools: [Bash, Read]
model-tier: cheap
parallelizable: false

### 2. Code audit
goal: Audit changed files for OWASP Top 10 vulnerabilities
tools: [Read, Grep, Glob]
model-tier: best
parallelizable: true
depends-on: [dependency-scan]

### 3. Report generation
goal: Generate security report with findings, severity, and fix suggestions
tools: [Write]
model-tier: cheap
depends-on: [code-audit]
