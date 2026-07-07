"""Tests for governance checkpoint endpoints."""

from __future__ import annotations

import json

import httpx
import respx

from commander import CheckpointStatus, CommanderClient


class TestGovernance:
    async def test_create_checkpoint(self, mock_api: respx.MockRouter) -> None:
        def check_body(request: httpx.Request) -> httpx.Response:
            data = json.loads(request.content)
            assert data["missionId"] == "m1"
            assert data["taskId"] == "t1"
            assert data["agentId"] == "a1"
            assert data["taskDescription"] == "desc"
            assert data["governanceMode"] == "SINGLE"
            return httpx.Response(
                201,
                json={
                    "id": "cp_1",
                    "mission_id": "m1",
                    "task_id": "t1",
                    "agent_id": "a1",
                    "task_description": "desc",
                    "status": "pending",
                },
            )

        mock_api.post("/api/governance/checkpoints").mock(side_effect=check_body)
        async with CommanderClient(api_key="test") as client:
            async with mock_api:
                checkpoint = await client.create_checkpoint(
                    mission_id="m1",
                    task_id="t1",
                    agent_id="a1",
                    task_description="desc",
                )
        assert checkpoint.id == "cp_1"
        assert checkpoint.status == CheckpointStatus("pending")

    async def test_get_checkpoint(self, mock_api: respx.MockRouter) -> None:
        mock_api.get("/api/governance/checkpoints/cp_1").respond(
            200,
            json={
                "id": "cp_1",
                "mission_id": "m1",
                "task_id": "t1",
                "agent_id": "a1",
                "task_description": "desc",
                "status": "pending",
            },
        )
        async with CommanderClient(api_key="test") as client:
            async with mock_api:
                checkpoint = await client.get_checkpoint("cp_1")
        assert checkpoint.id == "cp_1"

    async def test_list_checkpoints(self, mock_api: respx.MockRouter) -> None:
        mock_api.get("/api/governance/checkpoints").respond(
            200,
            json={
                "checkpoints": [
                    {
                        "id": "cp_1",
                        "mission_id": "m1",
                        "task_id": "t1",
                        "agent_id": "a1",
                        "task_description": "desc",
                        "status": "pending",
                    }
                ],
                "count": 1,
            },
        )
        async with CommanderClient(api_key="test") as client:
            async with mock_api:
                result = await client.list_checkpoints(mission_id="m1")
        assert result.count == 1
        assert result.checkpoints[0].mission_id == "m1"

    async def test_approve_checkpoint(self, mock_api: respx.MockRouter) -> None:
        def check_body(request: httpx.Request) -> httpx.Response:
            data = json.loads(request.content)
            assert data["reviewerId"] == "reviewer_1"
            assert data["reason"] == "looks good"
            return httpx.Response(
                200,
                json={
                    "id": "cp_1",
                    "status": "approved",
                    "approved_by": ["reviewer_1"],
                },
            )

        mock_api.post("/api/governance/checkpoints/cp_1/approve").mock(
            side_effect=check_body
        )
        async with CommanderClient(api_key="test") as client:
            async with mock_api:
                checkpoint = await client.approve_checkpoint(
                    "cp_1", "reviewer_1", reason="looks good"
                )
        assert checkpoint.status == CheckpointStatus("approved")

    async def test_reject_checkpoint(self, mock_api: respx.MockRouter) -> None:
        mock_api.post("/api/governance/checkpoints/cp_1/reject").respond(
            200,
            json={
                "id": "cp_1",
                "status": "rejected",
                "rejected_by": "reviewer_1",
                "rejection_reason": "risky",
            },
        )
        async with CommanderClient(api_key="test") as client:
            async with mock_api:
                checkpoint = await client.reject_checkpoint(
                    "cp_1", "reviewer_1", "risky"
                )
        assert checkpoint.status == CheckpointStatus("rejected")
        assert checkpoint.rejection_reason == "risky"
