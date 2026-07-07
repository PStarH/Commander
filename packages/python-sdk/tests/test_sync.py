"""Tests for the synchronous wrapper."""

from __future__ import annotations

import inspect

from commander import CommanderClient, CommanderClientSync


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
        mock_api.get("/health").respond(200, json={"status": "ok", "uptime": 100.0})
        client = CommanderClientSync(api_key="test")
        with mock_api:
            health = client.health()
        assert health.status == "ok"
        client.close()

    def test_sync_close_idempotent(self) -> None:
        client = CommanderClientSync(api_key="test")
        client.close()
        client.close()  # should not raise

    def test_sync_methods_mirror_async_client(self) -> None:
        """Every public async method on CommanderClient has a sync counterpart."""
        async_methods = {
            name
            for name, method in inspect.getmembers(
                CommanderClient, predicate=inspect.isfunction
            )
            if not name.startswith("_")
            and name not in {"close", "__aenter__", "__aexit__"}
            and inspect.iscoroutinefunction(method)
        }
        sync_methods = {
            name
            for name in dir(CommanderClientSync)
            if not name.startswith("_") and name not in {"close"}
        }
        missing = async_methods - sync_methods
        assert not missing, f"Missing sync methods: {missing}"

    def test_sync_runtime_execute(self, mock_api) -> None:
        mock_api.post("/api/runtime/execute").respond(
            200,
            json={
                "status": "SUCCESS",
                "summary": "Done",
                "steps": [],
                "total_token_usage": 200,
                "total_duration_ms": 1500,
                "run_id": "run_001",
            },
        )
        client = CommanderClientSync(api_key="test")
        with mock_api:
            result = client.runtime_execute(agent_id="agent-1", goal="test goal")
        assert result.status == "SUCCESS"
        assert result.run_id == "run_001"
        client.close()
