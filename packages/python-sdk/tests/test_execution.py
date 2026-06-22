"""Tests for execution, plan, and streaming endpoints."""

from __future__ import annotations

import json

import pytest
import respx

from commander import CommanderClient, ExecutionResult, PlanResult


class TestRun:
    async def test_simple_run(self, mock_api: respx.MockRouter) -> None:
        mock_api.post("/api/v1/execute").respond(
            200,
            json={
                "status": "SUCCESS",
                "summary": "Done",
                "steps": [],
                "total_token_usage": 500,
                "total_duration_ms": 3000,
                "run_id": "run_001",
                "session_id": "session_001",
            },
        )
        async with CommanderClient(api_key="test") as client:
            async with mock_api:
                result = await client.run("hello")
        assert isinstance(result, ExecutionResult)
        assert result.status == "SUCCESS"
        assert result.summary == "Done"
        assert result.total_token_usage == 500
        assert result.run_id == "run_001"

    async def test_run_with_options(self, mock_api: respx.MockRouter) -> None:
        def check_body(request):
            data = json.loads(request.content)
            assert data["prompt"] == "test"
            assert data["provider"] == "anthropic"
            assert data["model"] == "claude-3"
            assert data["sessionId"] == "sess_001"
            return httpx.Response(200, json={"status": "SUCCESS", "summary": ""})

        import httpx

        mock_api.post("/api/v1/execute").mock(side_effect=check_body)
        async with CommanderClient(api_key="test") as client:
            async with mock_api:
                await client.run(
                    "test",
                    provider="anthropic",
                    model="claude-3",
                    session_id="sess_001",
                )

    async def test_run_with_output_schema(self, mock_api: respx.MockRouter) -> None:
        def check_body(request):
            data = json.loads(request.content)
            assert data["outputSchema"] == {"type": "object"}
            return httpx.Response(200, json={"status": "SUCCESS", "summary": ""})

        import httpx

        mock_api.post("/api/v1/execute").mock(side_effect=check_body)
        async with CommanderClient(api_key="test") as client:
            async with mock_api:
                await client.run("test", output_schema={"type": "object"})

    async def test_run_failure(self, mock_api: respx.MockRouter) -> None:
        mock_api.post("/api/v1/execute").respond(
            200,
            json={
                "status": "FAILED",
                "summary": "Error: timeout",
                "steps": [],
                "total_token_usage": 100,
                "total_duration_ms": 10000,
                "error": "Agent execution timed out",
            },
        )
        async with CommanderClient(api_key="test") as client:
            async with mock_api:
                result = await client.run("fail")
        assert result.status == "FAILED"
        assert result.error == "Agent execution timed out"


class TestPlan:
    async def test_plan_simple(self, mock_api: respx.MockRouter) -> None:
        mock_api.post("/api/v1/plan").respond(
            200,
            json={
                "task": "audit this repo",
                "topology": "PARALLEL",
                "complexity_score": 0.42,
                "estimated_steps": 5,
                "estimated_cost_band": "high",
                "estimated_tokens": 3200,
                "estimate": {
                    "time_budget_ms": 22000,
                    "cost_budget_usd": 0.55,
                },
                "plan_only": True,
                "note": "deliberation-only response",
            },
        )
        async with CommanderClient(api_key="test") as client:
            async with mock_api:
                plan = await client.plan("audit this repo")
        assert isinstance(plan, PlanResult)
        assert plan.topology == "PARALLEL"
        assert plan.estimated_cost_band == "high"
        assert plan.estimated_tokens == 3200
        assert plan.estimate.cost_budget_usd == 0.55
        assert plan.plan_only is True

    async def test_plan_with_provider_hint(self, mock_api: respx.MockRouter) -> None:
        def check_body(request):
            data = json.loads(request.content)
            assert data["task"] == "test"
            assert data["provider"] == "openai"
            return httpx.Response(
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

        import httpx

        mock_api.post("/api/v1/plan").mock(side_effect=check_body)
        async with CommanderClient(api_key="test") as client:
            async with mock_api:
                await client.plan("test", provider="openai")

    async def test_plan_empty_task(self, mock_api: respx.MockRouter) -> None:
        mock_api.post("/api/v1/plan").respond(400, text="plan requires a non-empty task string.")
        async with CommanderClient(api_key="test") as client:
            async with mock_api:
                from commander._exceptions import ValidationError

                with pytest.raises(ValidationError):
                    await client.plan("")


class TestStream:
    async def test_stream_yields_events(self, mock_api: respx.MockRouter) -> None:
        """Verify SSE event parsing in the correct structured format."""
        sse_lines = (
            "event: output.delta\n"
            'data: {"event":"output.delta","data":{"content":"Hello"},"timestamp":"2026-01-01T00:00:00Z","seq":1}\n'
            "\n"
            "event: agent.status\n"
            'data: {"event":"agent.status","data":{"status":"agent.started","detail":""},"timestamp":"2026-01-01T00:00:01Z","seq":2}\n'
            "\n"
            "event: output.delta\n"
            'data: {"event":"output.delta","data":{"content":" World"},"timestamp":"2026-01-01T00:00:02Z","seq":3}\n'
            "\n"
            'data: [DONE]\n'
            "\n"
        )
        mock_api.get("/api/v1/stream/test_session").respond(
            200,
            text=sse_lines,
            headers={"Content-Type": "text/event-stream"},
        )

        async with CommanderClient(api_key="test") as client:
            async with mock_api:
                events = []
                stream = await client.stream("test_session")
                async for event in stream:
                    events.append(event)

        assert len(events) == 3
        assert events[0].event == "output.delta"
        assert events[0].data["content"] == "Hello"
        assert events[0].seq == 1

        assert events[1].event == "agent.status"
        assert events[1].data["status"] == "agent.started"

        assert events[2].event == "output.delta"
        assert events[2].data["content"] == " World"
        assert events[2].seq == 3

    async def test_stream_empty(self, mock_api: respx.MockRouter) -> None:
        """Empty stream with immediate DONE marker yields no events."""
        mock_api.get("/api/v1/stream/test_session").respond(
            200,
            text="data: [DONE]\n\n",
            headers={"Content-Type": "text/event-stream"},
        )
        async with CommanderClient(api_key="test") as client:
            async with mock_api:
                events = []
                stream = await client.stream("test_session")
                async for event in stream:
                    events.append(event)
        assert events == []

    async def test_stream_heartbeat_ignored(self, mock_api: respx.MockRouter) -> None:
        """SSE comments (heartbeat lines starting with :) are ignored."""
        sse_lines = (
            ": heartbeat\n"
            "\n"
            'data: [DONE]\n'
            "\n"
        )
        mock_api.get("/api/v1/stream/test_session").respond(
            200,
            text=sse_lines,
            headers={"Content-Type": "text/event-stream"},
        )
        async with CommanderClient(api_key="test") as client:
            async with mock_api:
                events = []
                stream = await client.stream("test_session")
                async for event in stream:
                    events.append(event)
        assert events == []
