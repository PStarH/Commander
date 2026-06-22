"""Tests for memory and monitoring endpoints."""

from __future__ import annotations

import json

import httpx
import pytest
import respx

from commander import CommanderClient


class TestMemory:
    async def test_memory_write(self, mock_api: respx.MockRouter) -> None:
        def check_body(request):
            data = json.loads(request.content)
            assert data["action"] == "write"
            assert data["content"] == "test content"
            assert data["importance"] == 0.8
            assert data["layer"] == "episodic"
            assert data["tags"] == ["tag1"]
            return httpx.Response(
                201,
                json={
                    "id": "mem_123",
                    "rejected": False,
                    "layer": "episodic",
                    "importance": 0.8,
                },
            )

        mock_api.post("/api/v1/memory").mock(side_effect=check_body)
        async with CommanderClient(api_key="test") as client:
            async with mock_api:
                result = await client.memory_write(
                    "test content",
                    importance=0.8,
                    tags=["tag1"],
                    layer="episodic",
                )
        assert result.id == "mem_123"
        assert not result.rejected

    async def test_memory_write_rejected(self, mock_api: respx.MockRouter) -> None:
        mock_api.post("/api/v1/memory").respond(
            201,
            json={
                "id": None,
                "rejected": True,
                "rejection_reason": "quality_gate",
            },
        )
        async with CommanderClient(api_key="test") as client:
            async with mock_api:
                result = await client.memory_write("bad content")
        assert result.rejected
        assert result.rejection_reason == "quality_gate"

    async def test_memory_query(self, mock_api: respx.MockRouter) -> None:
        mock_api.post("/api/v1/memory").respond(
            200,
            json={
                "items": [
                    {
                        "id": "mem_1",
                        "layer": "episodic",
                        "content": "test",
                        "importance": 0.7,
                        "tags": ["sql"],
                        "metadata": {},
                        "created_at": "...",
                    }
                ],
                "total": 1,
            },
        )
        async with CommanderClient(api_key="test") as client:
            async with mock_api:
                result = await client.memory_query(
                    keywords=["sql"],
                    layer="episodic",
                    importance_threshold=0.3,
                    limit=10,
                )
        assert result.total == 1
        assert result.items[0].content == "test"
        assert result.items[0].importance == 0.7
        assert "sql" in result.items[0].tags

    async def test_memory_stats(self, mock_api: respx.MockRouter) -> None:
        mock_api.post("/api/v1/memory").respond(
            200,
            json={
                "total_entries": 100,
                "by_layer": {"episodic": 60, "longterm": 40},
                "average_importance": 0.65,
                "average_access_count": 3.2,
                "total_memory_used": 50000,
            },
        )
        async with CommanderClient(api_key="test") as client:
            async with mock_api:
                stats = await client.memory_stats()
        assert stats.total_entries == 100
        assert stats.by_layer["episodic"] == 60
        assert stats.average_importance == 0.65

    async def test_memory_write_empty_fails(self, mock_api: respx.MockRouter) -> None:
        def check_body(request):
            data = json.loads(request.content)
            assert data["action"] == "write"
            return httpx.Response(400, text="memory.write requires non-empty content.")

        mock_api.post("/api/v1/memory").mock(side_effect=check_body)
        async with CommanderClient(api_key="test") as client:
            async with mock_api:
                from commander._exceptions import ValidationError

                with pytest.raises(ValidationError):
                    await client.memory_write("")


class TestMonitoring:
    async def test_health(self, mock_api: respx.MockRouter) -> None:
        mock_api.get("/health").respond(
            200,
            json={
                "status": "ok",
                "uptime": 1234.5,
                "active_sessions": 3,
                "bus_topics": 5,
                "timestamp": "2026-01-01T00:00:00Z",
            },
        )
        async with CommanderClient(api_key="test") as client:
            async with mock_api:
                health = await client.health()
        assert health.status == "ok"
        assert health.active_sessions == 3

    async def test_health_detailed(self, mock_api: respx.MockRouter) -> None:
        mock_api.get("/health/detailed").respond(
            200,
            json={
                "status": "healthy",
                "components": [
                    {"name": "memory", "status": "ok"},
                    {"name": "circuit_breaker", "status": "ok"},
                ],
            },
        )
        async with CommanderClient(api_key="test") as client:
            async with mock_api:
                detailed = await client.health_detailed()
        assert detailed["status"] == "healthy"

    async def test_system_status(self, mock_api: respx.MockRouter) -> None:
        mock_api.get("/api/v1/status").respond(
            200,
            json={
                "active_sessions": 2,
                "bus_topics": ["agent.started", "tool.executed"],
                "subscriber_counts": {"agent.started": 3},
            },
        )
        async with CommanderClient(api_key="test") as client:
            async with mock_api:
                status = await client.system_status()
        assert status.active_sessions == 2
        assert "agent.started" in status.bus_topics

    async def test_metrics(self, mock_api: respx.MockRouter) -> None:
        mock_api.get("/metrics").respond(
            200,
            text="# HELP commander_executions_total Total executions\n# TYPE commander_executions_total counter\ncommander_executions_total{status=\"success\"} 42\n",
            headers={"Content-Type": "text/plain"},
        )
        async with CommanderClient(api_key="test") as client:
            async with mock_api:
                metrics = await client.metrics()
        assert "commander_executions_total" in metrics
