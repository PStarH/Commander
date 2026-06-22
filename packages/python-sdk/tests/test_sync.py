"""Tests for the synchronous wrapper."""

from __future__ import annotations

from commander import CommanderClientSync


class TestSyncWrapper:
    def test_sync_run(self, mock_api) -> None:
        mock_api.post("/api/v1/execute").respond(
            200,
            json={
                "status": "SUCCESS",
                "summary": "Done",
                "steps": [],
                "total_token_usage": 500,
                "total_duration_ms": 3000,
            },
        )
        client = CommanderClientSync(api_key="test")
        with mock_api:
            result = client.run("hello")
        assert result.status == "SUCCESS"
        assert result.summary == "Done"
        client.close()

    def test_sync_plan(self, mock_api) -> None:
        mock_api.post("/api/v1/plan").respond(
            200,
            json={
                "task": "test",
                "topology": "SINGLE",
                "complexity_score": 0.1,
                "estimated_steps": 1,
                "estimated_cost_band": "low",
                "estimated_tokens": 900,
                "estimate": {"time_budget_ms": 6000, "cost_budget_usd": 0.15},
                "plan_only": True,
            },
        )
        client = CommanderClientSync(api_key="test")
        with mock_api:
            plan = client.plan("test")
        assert plan.topology == "SINGLE"
        client.close()

    def test_sync_health(self, mock_api) -> None:
        mock_api.get("/health").respond(
            200, json={"status": "ok", "uptime": 100.0}
        )
        client = CommanderClientSync(api_key="test")
        with mock_api:
            health = client.health()
        assert health.status == "ok"
        client.close()

    def test_sync_close_idempotent(self) -> None:
        client = CommanderClientSync(api_key="test")
        client.close()
        client.close()  # should not raise
