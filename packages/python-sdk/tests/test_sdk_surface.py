"""Tests aligning the Python SDK surface with the TypeScript SDK."""

from __future__ import annotations

import pytest
import respx

from commander import (
    Agent,
    AgentConfig,
    AgentSnapshot,
    CommanderClient,
    ExecutionEvent,
    ExecutionResult,
    SessionSummary,
    Task,
    TaskHandle,
    Topology,
)


class TestTopology:
    def test_topology_has_eight_values(self) -> None:
        values = {
            "SINGLE",
            "SEQUENTIAL",
            "PARALLEL",
            "HIERARCHICAL",
            "HYBRID",
            "DEBATE",
            "ENSEMBLE",
            "EVALUATOR_OPTIMIZER",
        }
        assert set(Topology.__args__) == values  # type: ignore[attr-defined]


class TestAgent:
    def test_agent_requires_name_and_role(self) -> None:
        with pytest.raises(ValueError, match="name"):
            Agent(AgentConfig(name="", role="role"))
        with pytest.raises(ValueError, match="role"):
            Agent(AgentConfig(name="name", role=""))

    def test_agent_auto_id(self) -> None:
        a1 = Agent(AgentConfig(name="a", role="r"))
        a2 = Agent(AgentConfig(name="b", role="r"))
        assert a1.id != a2.id
        assert a1.id.startswith("agent_")

    def test_agent_snapshot_roundtrip(self) -> None:
        agent = Agent(
            AgentConfig(
                id="custom_1",
                name="Reviewer",
                role="Review code",
                tools=["file_read"],
                topology="SINGLE",
            )
        )
        agent.run_count = 5
        agent.total_tokens_used = 1000
        snapshot = agent.snapshot()
        assert isinstance(snapshot, AgentSnapshot)
        assert snapshot.id == "custom_1"
        assert snapshot.run_count == 5
        assert snapshot.total_tokens_used == 1000

        restored = Agent.from_snapshot(snapshot)
        assert restored.id == agent.id
        assert restored.config.name == agent.config.name
        assert restored.run_count == agent.run_count
        assert restored.total_tokens_used == agent.total_tokens_used


class TestClientConnect:
    async def test_connect(self, mock_api: respx.MockRouter) -> None:
        mock_api.get("/ready").respond(200, json={"status": "ready"})
        async with CommanderClient(api_key="test") as client:
            assert not client.is_connected
            async with mock_api:
                await client.connect()
            assert client.is_connected

    async def test_connect_idempotent(self, mock_api: respx.MockRouter) -> None:
        mock_api.get("/ready").respond(200, json={"status": "ready"})
        async with CommanderClient(api_key="test") as client:
            async with mock_api:
                await client.connect()
                await client.connect()
            assert client.is_connected

    async def test_disconnect(self, mock_api: respx.MockRouter) -> None:
        mock_api.get("/ready").respond(200, json={"status": "ready"})
        client = CommanderClient(api_key="test")
        async with mock_api:
            await client.connect()
            assert client.is_connected
            await client.disconnect()
        assert not client.is_connected


class TestAgentManagement:
    async def test_create_list_remove_agents(self) -> None:
        async with CommanderClient(api_key="test") as client:
            agent = client.create_agent(
                AgentConfig(name="coder", role="Write code", tools=["file_write"])
            )
            assert agent in client.list_agents()
            assert client.get_agent(agent.id) is agent
            assert client.get_agent_snapshots()[0].name == "coder"
            assert client.remove_agent(agent.id) is True
            assert client.remove_agent(agent.id) is False
            assert client.list_agents() == []


class TestTaskSubmission:
    async def test_submit_await_task(self, mock_api: respx.MockRouter) -> None:
        mock_api.post("/api/v1/execute").respond(
            200,
            json={
                "status": "SUCCESS",
                "summary": "Done",
                "steps": [],
                "total_token_usage": 100,
                "total_duration_ms": 500,
                "run_id": "run_1",
            },
        )
        async with CommanderClient(api_key="test") as client:
            agent = client.create_agent(AgentConfig(name="a", role="r"))
            task = Task(goal="say hello")
            async with mock_api:
                handle = client.submit_task(agent, task)
                assert isinstance(handle, TaskHandle)
                assert handle.status == "pending"
                assert handle.agent_id == agent.id

                result = await client.await_task(handle.id, timeout_ms=2000)
            assert isinstance(result, ExecutionResult)
            assert result.status == "SUCCESS"
            assert agent.run_count == 1
            assert agent.total_tokens_used == 100

    async def test_await_missing_task_returns_none(self) -> None:
        async with CommanderClient(api_key="test") as client:
            result = await client.await_task("missing", timeout_ms=100)
            assert result is None

    async def test_cancel_task(self) -> None:
        async with CommanderClient(api_key="test") as client:
            agent = client.create_agent(AgentConfig(name="a", role="r"))
            task = Task(goal="slow")
            handle = client.submit_task(agent, task)
            assert client.cancel_task(handle.id) is True
            assert handle.status == "cancelled"
            assert client.cancel_task(handle.id) is False


class TestEvents:
    async def test_on_event_receives_lifecycle_events(
        self, mock_api: respx.MockRouter
    ) -> None:
        mock_api.post("/api/v1/execute").respond(
            200,
            json={
                "status": "SUCCESS",
                "summary": "Done",
                "steps": [],
                "total_token_usage": 10,
                "total_duration_ms": 50,
                "run_id": "run_e",
            },
        )
        async with CommanderClient(api_key="test") as client:
            events: list[ExecutionEvent] = []
            unsub = client.on_event(events.append)
            agent = client.create_agent(AgentConfig(name="a", role="r"))
            task = Task(goal="hello")
            async with mock_api:
                handle = client.submit_task(agent, task)
                await client.await_task(handle.id, timeout_ms=2000)
                assert any(e.type == "agent.started" for e in events)
                assert any(e.type == "agent.completed" for e in events)
            unsub()

    async def test_event_handler_unsubscribe(self) -> None:
        async with CommanderClient(api_key="test") as client:
            events: list[ExecutionEvent] = []
            unsub = client.on_event(events.append)
            unsub()
            # Force dispatch a private event; handler should not be called.
            client._dispatch_event(ExecutionEvent(type="agent.message"))
            assert events == []


class TestSessions:
    async def test_list_sessions(self, mock_api: respx.MockRouter) -> None:
        mock_api.post("/api/v1/execute").respond(
            200,
            json={
                "status": "SUCCESS",
                "summary": "Done",
                "steps": [],
                "total_token_usage": 10,
                "total_duration_ms": 50,
                "run_id": "run_s",
            },
        )
        async with CommanderClient(api_key="test") as client:
            agent = client.create_agent(AgentConfig(name="a", role="r"))
            async with mock_api:
                client.submit_task(agent, Task(goal="task"))
                await client.await_task("task_1", timeout_ms=2000)
                sessions = client.list_sessions()
            assert len(sessions) == 1
            assert isinstance(sessions[0], SessionSummary)
            assert sessions[0].run_id == "run_s"
            assert sessions[0].agent_id == agent.id


class TestStatsAndStatus:
    async def test_get_stats(self, mock_api: respx.MockRouter) -> None:
        mock_api.post("/api/v1/memory").respond(
            200,
            json={
                "total_entries": 3,
                "by_layer": {"episodic": 3},
                "average_importance": 0.5,
                "average_access_count": 1.0,
                "total_memory_used": 100,
            },
        )
        async with CommanderClient(api_key="test") as client:
            async with mock_api:
                stats = await client.get_stats()
            assert stats.total_entries == 3

    async def test_get_status(self, mock_api: respx.MockRouter) -> None:
        mock_api.get("/api/v1/status").respond(
            200,
            json={
                "active_sessions": 1,
                "bus_topics": ["agent.started"],
                "subscriber_counts": {},
            },
        )
        async with CommanderClient(api_key="test") as client:
            client.create_agent(AgentConfig(name="a", role="r"))
            async with mock_api:
                status = await client.get_status()
            assert status.active_sessions == 1
            assert status.subscriber_counts.get("agents") == 1

    async def test_get_reliability_stats(self, mock_api: respx.MockRouter) -> None:
        mock_api.get("/api/dlq/stats").respond(
            200,
            json={
                "total_entries": 2,
                "total_unrecovered": 1,
                "total_recovered": 1,
                "categories": [],
            },
        )
        mock_api.get("/api/v1/compensation").respond(200, json={"pending": 3})
        mock_api.get("/api/governance/checkpoints").respond(
            200, json={"checkpoints": [], "count": 4}
        )
        mock_api.get("/health/detailed").respond(
            200,
            json={
                "components": [
                    {"name": "circuit_breaker", "status": "open", "failures": 5}
                ]
            },
        )
        async with CommanderClient(api_key="test") as client:
            async with mock_api:
                stats = await client.get_reliability_stats()
            assert stats.dlq_total_entries == 2
            assert stats.pending_compensations == 3
            assert stats.checkpoint_count == 4
            assert stats.circuit_state == "OPEN"
            assert stats.circuit_failures == 5
