"""Tests for CommanderClient lifecycle and HTTP request handling."""

from __future__ import annotations

from unittest.mock import patch

import httpx
import pytest
import respx

from commander import CommanderClient
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
