# Commander: Agent Transaction Runtime (ATR)

Commander is the Agent Transaction Processing layer for production AI agents — the Temporal for LLM workflows, with policy-aware execution built in.

Standard agent frameworks focus on the orchestration of thoughts and tools. Commander focuses on what happens when those tools actually run in the real world. It provides the reliability, safety, and auditability required to move agents from experimental playgrounds into core production systems where failures have real consequences.

## The Cost of Unreliable Agents

### Brittle Long-Running Workflows
Your agent works for 5 minutes, then dies at step 48. Because standard frameworks lack durable execution, you have to restart from zero. Half the work is gone, tokens are wasted, and the user is left waiting for a process that should have resumed from the last known good state.

### Ghost Side Effects
When an agent calls a financial or infrastructure API and then crashes, you don't know if the action completed. You lack a reliable audit trail and a mechanism for automatic rollback. Without transaction management, your system is left in an inconsistent state that requires manual intervention.

### The CISO Wall
You can't run agents in production because you can't prove to your security team that a high-risk call won't fire on the wrong resource. Without per-step policy enforcement, agents are a black box. You need to guarantee that every database or cloud operation passes a risk-aware gate before it executes.

## Core Capabilities

### Saga Runtime
Agent steps can be rolled back individually rather than following an all-or-nothing approach.
Benefit: Ensures system consistency by automatically executing compensating actions when a complex workflow fails halfway through.

### Policy Engine
Risk-aware execution gates every step before it runs.
Benefit: Provides a verifiable security layer that prevents unauthorized or dangerous tool calls from ever reaching your production APIs.

### Reversibility Library
Access to 10+ pre-built compensations for common SaaS side effects like Stripe, GitHub, and AWS.
Benefit: Drastically reduces the engineering effort required to make your agent's real-world actions safe and undoable.

### Drift Insight
Detect when your agent's success rate silently drops due to model updates or API changes.
Benefit: Moves beyond basic logging to provide proactive alerts when the underlying logic of your agent begins to degrade in production.

## Feature Comparison

| Feature | LangGraph | Temporal | Commander |
| :--- | :--- | :--- | :--- |
| Step-level saga compensations | Manual | Partial | Built-in |
| Per-step policy evaluation | Manual | No | Native |
| Built-in reversibility library | No | No | Yes |
| LLM-aware drift detection | No | No | Yes |
| Existing-agent adapter | N/A | No | 3-line drop-in |

## Get Started

Wrap your existing LangGraph or AutoGen agent in 3 lines. Get Saga, Policy, and Reversibility without rewriting your agent code or changing your existing orchestration logic.

Visit our documentation to view the integration guide for your specific framework.

`npm install @commander/saga` (developer preview)
