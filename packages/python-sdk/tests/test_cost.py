"""Tests for cost endpoints."""

from __future__ import annotations

import respx

from commander import CommanderClient


class TestCost:
    async def test_cost_summary(self, mock_api: respx.MockRouter) -> None:
        mock_api.get("/api/cost/summary").respond(
            200,
            json={
                "total_calls": 10,
                "total_tokens": 5000,
                "total_cost_usd": 0.75,
                "by_model": [
                    {
                        "model": "gpt-4",
                        "provider": "openai",
                        "calls": 5,
                        "tokens": 2500,
                        "cost_usd": 0.5,
                    }
                ],
                "by_agent": [
                    {
                        "agent_id": "agent-1",
                        "calls": 10,
                        "tokens": 5000,
                        "cost_usd": 0.75,
                    }
                ],
            },
        )
        async with CommanderClient(api_key="test") as client:
            async with mock_api:
                summary = await client.cost_summary()
        assert summary.total_calls == 10
        assert summary.total_cost_usd == 0.75
        assert summary.by_model[0].model == "gpt-4"
        assert summary.by_agent[0].agent_id == "agent-1"

    async def test_cost_records(self, mock_api: respx.MockRouter) -> None:
        mock_api.get("/api/cost/records").respond(
            200,
            json={
                "records": [
                    {
                        "run_id": "run_1",
                        "agent_id": "agent-1",
                        "model": "gpt-4",
                        "provider": "openai",
                        "prompt_tokens": 100,
                        "completion_tokens": 50,
                        "total_tokens": 150,
                        "cost_usd": 0.01,
                        "timestamp": "2026-01-01T00:00:00Z",
                    }
                ],
                "total": 1,
            },
        )
        async with CommanderClient(api_key="test") as client:
            async with mock_api:
                result = await client.cost_records(run_id="run_1", limit=10)
        assert result.total == 1
        assert result.records[0].run_id == "run_1"

    async def test_cost_budget(self, mock_api: respx.MockRouter) -> None:
        mock_api.get("/api/cost/budget").respond(
            200,
            json={
                "monthly_used": 5.0,
                "monthly_limit": 100.0,
                "usage_percent": 5,
                "alert_count": 0,
                "alerts": [],
            },
        )
        async with CommanderClient(api_key="test") as client:
            async with mock_api:
                budget = await client.cost_budget()
        assert budget.monthly_used == 5.0
        assert budget.usage_percent == 5
