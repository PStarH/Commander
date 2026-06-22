"""Test fixtures — mock Commander HTTP server via respx."""

from __future__ import annotations

from collections.abc import AsyncGenerator

import pytest
import respx

from commander import CommanderClient


@pytest.fixture
def mock_api() -> respx.MockRouter:
    router = respx.mock(base_url="http://localhost:3001")
    return router


@pytest.fixture
async def client() -> AsyncGenerator[CommanderClient, None]:
    async with CommanderClient(api_key="", base_url="http://localhost:3001") as c:
        yield c
