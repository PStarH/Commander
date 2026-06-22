"""Tests for Pydantic model construction and serialization."""

from __future__ import annotations

from commander import (
    ExecutionResult,
    HealthStatus,
    MemoryEntry,
    MemoryQueryResult,
    MemoryStats,
    MemoryWriteResult,
    PlanResult,
    SSEEvent,
    StepSummary,
    SystemStatus,
)


def test_execution_result_defaults() -> None:
    result = ExecutionResult()
    assert result.status == "SUCCESS"
    assert result.summary == ""
    assert result.steps == []
    assert result.total_token_usage == 0
    assert result.total_duration_ms == 0
    assert result.error is None
    assert result.run_id is None


def test_execution_result_full() -> None:
    result = ExecutionResult(
        status="FAILED",
        summary="Something went wrong",
        steps=[StepSummary(step_number=1, action="test", status="completed")],
        total_token_usage=5000,
        total_duration_ms=12000,
        error="timeout",
        run_id="run_abc123",
    )
    assert result.status == "FAILED"
    assert len(result.steps) == 1
    assert result.steps[0].action == "test"


def test_execution_result_from_dict() -> None:
    data = {
        "status": "SUCCESS",
        "summary": "All good",
        "steps": [],
        "total_token_usage": 1500,
        "total_duration_ms": 8000,
    }
    result = ExecutionResult(**data)
    assert result.summary == "All good"
    assert result.total_token_usage == 1500


def test_plan_result_defaults() -> None:
    plan = PlanResult()
    assert plan.topology == "SINGLE"
    assert plan.estimated_steps == 1
    assert plan.plan_only is True


def test_plan_result_from_server() -> None:
    data = {
        "task": "audit this repo",
        "topology": "PARALLEL",
        "complexity_score": 0.42,
        "estimated_steps": 5,
        "estimated_cost_band": "high",
        "estimated_tokens": 3200,
        "estimate": {"time_budget_ms": 22000, "cost_budget_usd": 0.55},
        "plan_only": True,
        "note": "deliberation-only response",
    }
    plan = PlanResult(**data)
    assert plan.topology == "PARALLEL"
    assert plan.estimate.cost_budget_usd == 0.55


def test_sse_event_from_envelope() -> None:
    event = SSEEvent(
        event="output.delta",
        data={"content": "Hello"},
        timestamp="2026-01-01T00:00:00Z",
        seq=1,
    )
    assert event.event == "output.delta"
    assert event.data["content"] == "Hello"


def test_health_status() -> None:
    health = HealthStatus(
        status="ok",
        uptime=1234.5,
        active_sessions=3,
        bus_topics=5,
        timestamp="2026-01-01T00:00:00Z",
    )
    assert health.status == "ok"
    assert health.active_sessions == 3


def test_system_status() -> None:
    status = SystemStatus(
        active_sessions=2,
        bus_topics=["agent.started", "tool.executed"],
        subscriber_counts={"agent.started": 3},
    )
    assert status.active_sessions == 2
    assert "agent.started" in status.bus_topics


def test_memory_write_result() -> None:
    result = MemoryWriteResult(id="mem_123", rejected=False)
    assert result.id == "mem_123"
    assert not result.rejected


def test_memory_write_result_rejected() -> None:
    result = MemoryWriteResult(id=None, rejected=True, rejection_reason="quality_gate")
    assert result.rejected
    assert result.rejection_reason == "quality_gate"


def test_memory_entry() -> None:
    entry = MemoryEntry(
        id="mem_1",
        content="test content",
        layer="episodic",
        importance=0.8,
        tags=["tag1"],
    )
    assert entry.content == "test content"
    assert entry.importance == 0.8


def test_memory_query_result() -> None:
    items = [
        MemoryEntry(id="mem_1", content="a", layer="episodic", importance=0.5),
        MemoryEntry(id="mem_2", content="b", layer="episodic", importance=0.7),
    ]
    result = MemoryQueryResult(items=items, total=2)
    assert result.total == 2
    assert len(result.items) == 2


def test_memory_stats() -> None:
    stats = MemoryStats(
        total_entries=100,
        by_layer={"episodic": 60, "longterm": 40},
        average_importance=0.65,
        average_access_count=3.2,
        total_memory_used=50000,
    )
    assert stats.total_entries == 100
    assert stats.by_layer["episodic"] == 60
