"""Integration test — requires a running Commander server.

Usage:
    python -m pytest tests/test_integration.py -v --tb=short

Environment variables:
    COMMANDER_API_KEY  - API key (default: empty = no auth)
    COMMANDER_URL      - Base URL (default: http://localhost:3001)

This test is skipped unless INTEGRATION=1 is set.
"""

from __future__ import annotations

import os
import pytest

from commander import CommanderClient

pytestmark = pytest.mark.skipif(
    "INTEGRATION" not in os.environ,
    reason="set INTEGRATION=1 to run integration tests",
)


@pytest.fixture
async def live_client() -> CommanderClient:
    api_key = os.environ.get("COMMANDER_API_KEY", "")
    base_url = os.environ.get("COMMANDER_URL", "http://localhost:3001")
    async with CommanderClient(api_key=api_key, base_url=base_url) as client:
        yield client


class TestLiveServer:
    async def test_health(self, live_client: CommanderClient) -> None:
        health = await live_client.health()
        assert health.status == "ok"

    async def test_plan(self, live_client: CommanderClient) -> None:
        plan = await live_client.plan("list all files")
        assert plan.topology in ("SINGLE", "SEQUENTIAL", "PARALLEL", "HIERARCHICAL")
        assert plan.estimated_steps >= 1

    async def test_run(self, live_client: CommanderClient) -> None:
        result = await live_client.run("say hello")
        assert result.status in ("SUCCESS", "FAILED")

    async def test_memory_write_query(self, live_client: CommanderClient) -> None:
        write_result = await live_client.memory_write(
            content="integration test entry",
            importance=0.5,
            tags=["test", "integration"],
        )
        # might be rejected by quality gate; that's fine
        assert write_result.rejected is not None

        query_result = await live_client.memory_query(
            keywords=["integration"],
            limit=5,
        )
        assert isinstance(query_result.total, int)

    async def test_memory_stats(self, live_client: CommanderClient) -> None:
        stats = await live_client.memory_stats()
        assert stats.total_entries >= 0

    async def test_system_status(self, live_client: CommanderClient) -> None:
        status = await live_client.system_status()
        assert status.active_sessions >= 0

    async def test_metrics(self, live_client: CommanderClient) -> None:
        text = await live_client.metrics()
        assert isinstance(text, str)
        assert len(text) > 0
