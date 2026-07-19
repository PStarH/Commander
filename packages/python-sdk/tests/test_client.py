"""Tests for CommanderClient lifecycle and HTTP request handling."""

from __future__ import annotations

from unittest.mock import patch

import httpx
import pytest
import respx

from commander import CommanderClient
from commander._gateway_client import CommanderGatewayClient
from commander._types import ActionApprovalInput, ProposeActionInput
from commander._exceptions import (
    AuthenticationError,
    ConnectionError,
    NotFoundError,
    RateLimitError,
    ServerError,
)


class TestClientLifecycle:
    async def test_enter_exit(self) -> None:
        async with CommanderClient(api_key="test") as client:
            assert client is not None
        # After exit, client should be closed

    async def test_close_idempotent(self) -> None:
        client = CommanderClient(api_key="test")
        await client.close()
        await client.close()  # should not raise

    async def test_default_base_url(self) -> None:
        client = CommanderClient()
        assert "localhost:3001" in str(client._base_url)
        await client.close()

    async def test_api_key_from_env(self) -> None:
        with patch.dict("os.environ", {"COMMANDER_API_KEY": "env-key"}):
            client = CommanderClient()
            assert client._api_key == "env-key"
            await client.close()

    async def test_no_auth_with_empty_key(self) -> None:
        async with CommanderClient(api_key="") as client:
            # empty key means no Authorization header
            assert "Authorization" not in client._build_headers()


class TestClientRequests:
    async def test_successful_request(self, mock_api: respx.MockRouter) -> None:
        mock_api.get("/health").respond(200, json={"status": "ok"})
        async with CommanderClient(api_key="test") as client:
            async with mock_api:
                data = await client._request("GET", "/health")
            assert data["status"] == "ok"

    async def test_401_maps_to_authentication_error(
        self, mock_api: respx.MockRouter
    ) -> None:
        mock_api.get("/health").respond(401, text="Unauthorized")
        async with CommanderClient(api_key="test") as client:
            async with mock_api:
                with pytest.raises(AuthenticationError):
                    await client._request("GET", "/health")

    async def test_404_maps_to_not_found(self, mock_api: respx.MockRouter) -> None:
        mock_api.get("/nowhere").respond(404, text="Not found")
        async with CommanderClient(api_key="test") as client:
            async with mock_api:
                with pytest.raises(NotFoundError):
                    await client._request("GET", "/nowhere")

    async def test_429_maps_to_rate_limit(self, mock_api: respx.MockRouter) -> None:
        mock_api.get("/health").respond(429, text="Too fast")
        async with CommanderClient(api_key="test") as client:
            async with mock_api:
                with pytest.raises(RateLimitError):
                    await client._request("GET", "/health")

    async def test_500_maps_to_server_error(self, mock_api: respx.MockRouter) -> None:
        mock_api.get("/health").respond(500, text="Internal error")
        async with CommanderClient(api_key="test") as client:
            async with mock_api:
                with pytest.raises(ServerError):
                    await client._request("GET", "/health")

    async def test_retry_on_connection_error(self, mock_api: respx.MockRouter) -> None:
        # Simulate 2 failures then success
        mock_api.get("/health").mock(
            side_effect=[
                httpx.ConnectError("connection refused"),
                httpx.ConnectError("connection refused"),
                httpx.Response(200, json={"status": "ok"}),
            ]
        )
        async with CommanderClient(api_key="test", max_retries=3) as client:
            async with mock_api:
                data = await client._request("GET", "/health")
            assert data["status"] == "ok"

    async def test_exhaust_retries(self, mock_api: respx.MockRouter) -> None:
        mock_api.get("/health").mock(
            side_effect=httpx.ConnectError("connection refused")
        )
        async with CommanderClient(api_key="test", max_retries=2) as client:
            async with mock_api:
                with pytest.raises(ConnectionError):
                    await client._request("GET", "/health")


ACTION_FIXTURES = {
    "input": {
        "source": "sdk-test",
        "package": "demo.package",
        "model": "demo-model",
        "tool": "ticket.create",
        "destination": "demo://tickets",
        "effectType": "demo.ticket.create",
        "args": {"title": "Reset password"},
        "idempotencyKey": "action-key-0001",
    },
    "simulation": {
        "simulationId": "sim-1",
        "decisionId": "action-gateway-allow",
        "effect": "allow",
        "reason": "allowed",
        "policySnapshotId": "action-gateway-mvp-v1",
        "actionDigest": "a" * 64,
    },
    "action": {
        "runId": "run-action-1",
        "stepId": "step-1",
        "effectId": "effect-1",
        "state": "PENDING",
        "decision": {
            "effect": "allow",
            "decisionId": "action-gateway-allow",
            "reason": "allowed",
            "policySnapshotId": "action-gateway-mvp-v1",
        },
        "simulation": {
            "simulationId": "sim-1",
            "decisionId": "action-gateway-allow",
            "effect": "allow",
            "reason": "allowed",
            "policySnapshotId": "action-gateway-mvp-v1",
            "actionDigest": "a" * 64,
        },
        "actionDigest": "a" * 64,
        "policySnapshotId": "action-gateway-mvp-v1",
        "createdAt": "2026-07-18T00:00:00.000Z",
        "updatedAt": "2026-07-18T00:00:00.000Z",
    },
}


class TestGatewayClient:
    async def test_simulate_action_posts_envelope(self, mock_api: respx.MockRouter) -> None:
        route = mock_api.post("/v1/actions/simulate").respond(
            200, json={"simulation": ACTION_FIXTURES["simulation"]}
        )
        async with CommanderGatewayClient(
            base_url="http://localhost:3001", api_key="test"
        ) as client:
            async with mock_api:
                result = await client.simulate_action(ProposeActionInput(**ACTION_FIXTURES["input"]))
                assert route.called
                assert route.calls.last.request.url.path == "/v1/actions/simulate"
        assert result.simulation_id == "sim-1"

    async def test_propose_action_sends_idempotency_key(self, mock_api: respx.MockRouter) -> None:
        route = mock_api.post("/v1/actions").respond(
            202, json={"action": ACTION_FIXTURES["action"], "idempotentReplay": False}
        )
        async with CommanderGatewayClient(
            base_url="http://localhost:3001", api_key="test"
        ) as client:
            async with mock_api:
                action, replay, accepted = await client.propose_action(
                    ProposeActionInput(**ACTION_FIXTURES["input"])
                )
                assert route.calls.last.request.headers["Idempotency-Key"] == "action-key-0001"
        assert action.run_id == "run-action-1"
        assert replay is False
        assert accepted is True

    async def test_get_action_loads_run(self, mock_api: respx.MockRouter) -> None:
        route = mock_api.get("/v1/actions/run-action-1").respond(
            200, json={"action": ACTION_FIXTURES["action"]}
        )
        async with CommanderGatewayClient(
            base_url="http://localhost:3001", api_key="test"
        ) as client:
            async with mock_api:
                action = await client.get_action("run-action-1")
                assert route.called
        assert action.run_id == "run-action-1"

    async def test_approve_action_posts_bindings(self, mock_api: respx.MockRouter) -> None:
        route = mock_api.post("/v1/actions/run-action-1/approve").respond(
            200, json={"action": ACTION_FIXTURES["action"]}
        )
        approval = ActionApprovalInput(
            actionDigest=ACTION_FIXTURES["action"]["actionDigest"],
            simulationId=ACTION_FIXTURES["action"]["simulation"]["simulationId"],
            policySnapshotId=ACTION_FIXTURES["action"]["policySnapshotId"],
        )
        async with CommanderGatewayClient(
            base_url="http://localhost:3001", api_key="test"
        ) as client:
            async with mock_api:
                action = await client.approve_action("run-action-1", approval)
                assert route.called
        assert action.run_id == "run-action-1"

    async def test_reject_action_posts_reason(self, mock_api: respx.MockRouter) -> None:
        route = mock_api.post("/v1/actions/run-action-1/reject").respond(
            200,
            json={"action": {**ACTION_FIXTURES["action"], "state": "REJECTED"}},
        )
        async with CommanderGatewayClient(
            base_url="http://localhost:3001", api_key="test"
        ) as client:
            async with mock_api:
                action = await client.reject_action("run-action-1", reason="too risky")
                assert route.called
        assert action.state == "REJECTED"

    async def test_get_action_evidence(self, mock_api: respx.MockRouter) -> None:
        route = mock_api.get("/v1/actions/run-action-1/evidence").respond(
            200,
            json={
                "bundle": {"bundleId": "bundle-1", "runId": "run-action-1"},
                "verification": {"valid": True},
            },
        )
        async with CommanderGatewayClient(
            base_url="http://localhost:3001", api_key="test"
        ) as client:
            async with mock_api:
                evidence = await client.get_action_evidence("run-action-1")
                assert route.called
        assert evidence.bundle["bundleId"] == "bundle-1"
        assert evidence.verification["valid"] is True
