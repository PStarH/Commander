"""Pydantic models for Commander SDK request/response types."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel


# ============================================================================
# Execution
# ============================================================================

ExecutionStatus = Literal[
    "SUCCESS", "FAILED", "PARTIAL", "CANCELLED", "INTERRUPTED"
]


class StepSummary(BaseModel):
    """Summary of a single execution step."""

    step_number: int = 0
    action: str = ""
    status: str = ""
    token_usage: int = 0
    duration_ms: int = 0


class ExecutionResult(BaseModel):
    """Result of a Commander execution."""

    status: ExecutionStatus = "SUCCESS"
    summary: str = ""
    steps: list[StepSummary] = []
    total_token_usage: int = 0
    total_duration_ms: int = 0
    error: str | None = None
    run_id: str | None = None
    session_id: str | None = None


# ============================================================================
# Plan
# ============================================================================

Topology = Literal["SINGLE", "SEQUENTIAL", "PARALLEL", "HIERARCHICAL"]
CostBand = Literal["low", "medium", "high"]


class PlanBudget(BaseModel):
    """Estimated budget for a plan."""

    time_budget_ms: int = 0
    cost_budget_usd: float = 0.0


class PlanResult(BaseModel):
    """Result of a zero-cost deliberation (no LLM call)."""

    task: str = ""
    topology: Topology = "SINGLE"
    complexity_score: float = 0.0
    estimated_steps: int = 1
    estimated_cost_band: CostBand = "low"
    estimated_tokens: int = 0
    estimate: PlanBudget = PlanBudget()
    provider: str | None = None
    model: str | None = None
    tenant_id: str | None = None
    plan_only: bool = True
    note: str = ""


# ============================================================================
# Streaming
# ============================================================================


class SSEEvent(BaseModel):
    """A single SSE event from the Commander stream.

    Wire format::
        id: {seq}
        event: {eventType}
        data: {"event":"{eventType}","data":{...},"timestamp":"ISO","seq":{n}}
    """

    event: str = ""
    data: dict[str, Any] = {}
    timestamp: str = ""
    seq: int = 0


# ============================================================================
# Memory
# ============================================================================


class MemoryWriteResult(BaseModel):
    """Result of a memory write operation."""

    id: str | None = None
    rejected: bool = False
    rejection_reason: str | None = None


class MemoryEntry(BaseModel):
    """A single memory entry from a query result."""

    id: str = ""
    content: str = ""
    layer: str = ""
    importance: float = 0.0
    tags: list[str] = []
    context: str | None = None
    metadata: dict[str, Any] = {}
    created_at: str = ""
    last_accessed_at: str = ""
    access_count: int = 0


class MemoryQueryResult(BaseModel):
    """Result of a memory query."""

    items: list[MemoryEntry] = []
    total: int = 0


class MemoryStats(BaseModel):
    """Memory statistics."""

    total_entries: int = 0
    by_layer: dict[str, int] = {}
    average_importance: float = 0.0
    average_access_count: float = 0.0
    total_memory_used: int = 0


# ============================================================================
# Monitoring
# ============================================================================


class HealthStatus(BaseModel):
    """Server health check response."""

    status: str = ""
    uptime: float = 0.0
    active_sessions: int = 0
    bus_topics: int = 0
    timestamp: str = ""


class SystemStatus(BaseModel):
    """System status snapshot."""

    active_sessions: int = 0
    bus_topics: list[str] = []
    subscriber_counts: dict[str, int] = {}
