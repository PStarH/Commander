"""Synchronous wrapper for CommanderClient.

⚠️  Not for Jupyter/notebooks — use ``CommanderClient`` with ``asyncio.run()`` there.
"""

from __future__ import annotations

import asyncio
from typing import Any

from ._client import CommanderClient as _CommanderClient
from ._types import ExecutionResult, HealthStatus, PlanResult


class CommanderClientSync:
    """Synchronous Commander client for scripts and simple automation.

    Usage::

        client = CommanderClientSync(api_key="cmd-...")
        result = client.run("analyze this")
        plan = client.plan("audit repo")
        client.close()
    """

    def __init__(self, **kwargs: Any) -> None:
        self._kwargs = kwargs
        self._client: _CommanderClient | None = None

    def _get_client(self) -> _CommanderClient:
        if self._client is None:
            self._client = _CommanderClient(**self._kwargs)
        return self._client

    def run(self, prompt: str, **kwargs: Any) -> ExecutionResult:
        return asyncio.run(self._get_client().run(prompt, **kwargs))

    def plan(self, task: str, **kwargs: Any) -> PlanResult:
        return asyncio.run(self._get_client().plan(task, **kwargs))

    def health(self) -> HealthStatus:
        return asyncio.run(self._get_client().health())

    def close(self) -> None:
        if self._client is not None:
            asyncio.run(self._client.close())
