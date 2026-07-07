"""Tests for runtime and control endpoints."""

from __future__ import annotations

import json

import httpx
import respx

from commander import CommanderClient


class TestRuntimeExecute:
    async def test_runtime_execute(self, mock_api: respx.MockRouter) -> None:
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
        async with CommanderClient(api_key="test") as client:
            async with mock_api:
                result = await client.runtime_execute(
                    agent_id="agent-1",
                    goal="test goal",
                    project_id="proj-1",
                    mission_id="mission-1",
                    available_tools=["tool1"],
                    token_budget=4000,
                )
        assert result.status == "SUCCESS"
        assert result.run_id == "run_001"

    async def test_runtime_execute_body(self, mock_api: respx.MockRouter) -> None:
        def check_body(request: httpx.Request) -> httpx.Response:
            data = {}
            if request.content:
                data = json.loads(request.content)
            assert data["agentId"] == "agent-1"
            assert data["goal"] == "goal"
            assert data["projectId"] == "proj-1"
            assert data["missionId"] == "mission-1"
            assert data["availableTools"] == ["tool1"]
            assert data["tokenBudget"] == 4000
            return httpx.Response(200, json={"status": "SUCCESS", "summary": ""})

        mock_api.post("/api/runtime/execute").mock(side_effect=check_body)
        async with CommanderClient(api_key="test") as client:
            async with mock_api:
                await client.runtime_execute(
                    agent_id="agent-1",
                    goal="goal",
                    project_id="proj-1",
                    mission_id="mission-1",
                    available_tools=["tool1"],
                    token_budget=4000,
                )


class TestRuntimeRoute:
    async def test_runtime_route(self, mock_api: respx.MockRouter) -> None:
        mock_api.post("/api/runtime/route").respond(
            200, json={"provider": "openai", "model": "gpt-4"}
        )
        async with CommanderClient(api_key="test") as client:
            async with mock_api:
                decision = await client.runtime_route("goal")
        assert decision["provider"] == "openai"


class TestTraces:
    async def test_list_traces(self, mock_api: respx.MockRouter) -> None:
        mock_api.get("/api/runtime/traces").respond(
            200,
            json={
                "traces": [
                    {
                        "run_id": "run_1",
                        "agent_id": "agent-1",
                        "status": "SUCCESS",
                        "start_time": "2026-01-01T00:00:00Z",
                    }
                ],
                "count": 1,
            },
        )
        async with CommanderClient(api_key="test") as client:
            async with mock_api:
                result = await client.list_traces(agent_id="agent-1", limit=10)
        assert result.count == 1
        assert result.traces[0].run_id == "run_1"

    async def test_get_trace(self, mock_api: respx.MockRouter) -> None:
        mock_api.get("/api/runtime/traces/run_1").respond(
            200, json={"run_id": "run_1", "status": "SUCCESS"}
        )
        async with CommanderClient(api_key="test") as client:
            async with mock_api:
                trace = await client.get_trace("run_1")
        assert trace["run_id"] == "run_1"

    async def test_trace_summary(self, mock_api: respx.MockRouter) -> None:
        mock_api.get("/api/runtime/traces/summary").respond(
            200, json={"total": 5, "success": 4}
        )
        async with CommanderClient(api_key="test") as client:
            async with mock_api:
                summary = await client.trace_summary()
        assert summary["total"] == 5


class TestBusAndLearner:
    async def test_bus_topics(self, mock_api: respx.MockRouter) -> None:
        mock_api.get("/api/runtime/bus/topics").respond(
            200,
            json={
                "topics": ["agent.started"],
                "subscriber_counts": {"agent.started": 2},
            },
        )
        async with CommanderClient(api_key="test") as client:
            async with mock_api:
                result = await client.bus_topics()
        assert "agent.started" in result.topics
        assert result.subscriber_counts["agent.started"] == 2

    async def test_learner_stats(self, mock_api: respx.MockRouter) -> None:
        mock_api.get("/api/runtime/learner/stats").respond(
            200, json={"stats": {}, "suggestions": []}
        )
        async with CommanderClient(api_key="test") as client:
            async with mock_api:
                stats = await client.learner_stats()
        assert "stats" in stats


class TestRuntimeControl:
    async def test_pause_run(self, mock_api: respx.MockRouter) -> None:
        mock_api.post("/api/runtime/pause").respond(
            200, json={"status": "pause_signaled", "message": "paused"}
        )
        async with CommanderClient(api_key="test") as client:
            async with mock_api:
                result = await client.pause_run("run_1")
        assert result["status"] == "pause_signaled"

    async def test_resume_run(self, mock_api: respx.MockRouter) -> None:
        mock_api.post("/api/runtime/resume").respond(
            200,
            json={
                "status": "resumed",
                "message": "resumed",
                "from_phase": "phase_1",
                "step_number": 3,
                "injected_instructions": True,
            },
        )
        async with CommanderClient(api_key="test") as client:
            async with mock_api:
                result = await client.resume_run("run_1", user_instructions="continue")
        assert result.status == "resumed"
        assert result.step_number == 3
        assert result.injected_instructions is True

    async def test_rollback_run(self, mock_api: respx.MockRouter) -> None:
        mock_api.post("/api/runtime/rollback").respond(
            200,
            json={
                "status": "rollback_initiated",
                "message": "rollback",
                "from_step": 5,
                "to_step": 2,
                "injected_instructions": False,
            },
        )
        async with CommanderClient(api_key="test") as client:
            async with mock_api:
                result = await client.rollback_run("run_1", 2)
        assert result.status == "rollback_initiated"
        assert result.to_step == 2

    async def test_active_runs(self, mock_api: respx.MockRouter) -> None:
        mock_api.get("/api/runtime/active").respond(
            200,
            json={
                "runs": [
                    {
                        "run_id": "run_1",
                        "agent_id": "agent-1",
                        "status": "running",
                        "started_at": "2026-01-01T00:00:00Z",
                    }
                ],
                "total": 1,
            },
        )
        async with CommanderClient(api_key="test") as client:
            async with mock_api:
                result = await client.active_runs()
        assert result.total == 1
        assert result.runs[0].run_id == "run_1"
