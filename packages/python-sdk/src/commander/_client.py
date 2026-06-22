"""Async HTTP client for Commander."""

from __future__ import annotations

import asyncio
import os
from typing import Any

import httpx

from ._exceptions import (
    CommanderError,
    ConnectionError,
    RateLimitError,
    map_status_to_error,
)
from ._streaming import CommanderSSEStream
from ._types import (
    ExecutionResult,
    HealthStatus,
    MemoryQueryResult,
    MemoryStats,
    MemoryWriteResult,
    PlanResult,
    SystemStatus,
)

_DEFAULT_BASE_URL = "http://localhost:3001"
_DEFAULT_TIMEOUT = 300.0
_DEFAULT_MAX_RETRIES = 3


class CommanderClient:
    """Async HTTP client for Commander.

    Usage::

        async with CommanderClient(api_key="cmd-...") as client:
            result = await client.run("analyze this repo")
            print(result.summary)
    """

    def __init__(
        self,
        api_key: str | None = None,
        base_url: str = _DEFAULT_BASE_URL,
        timeout: float = _DEFAULT_TIMEOUT,
        max_retries: int = _DEFAULT_MAX_RETRIES,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._api_key = api_key or os.environ.get("COMMANDER_API_KEY")
        self._max_retries = max_retries
        self._http = httpx.AsyncClient(
            base_url=self._base_url,
            timeout=httpx.Timeout(timeout, connect=10.0),
            headers=self._build_headers(),
        )

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    async def __aenter__(self) -> CommanderClient:
        return self

    async def __aexit__(self, *args: object) -> None:
        await self.close()

    async def close(self) -> None:
        await self._http.aclose()

    # ------------------------------------------------------------------
    # Execution
    # ------------------------------------------------------------------

    async def run(
        self,
        prompt: str,
        *,
        session_id: str | None = None,
        provider: str | None = None,
        model: str | None = None,
        output_schema: dict[str, Any] | None = None,
    ) -> ExecutionResult:
        """Execute an agent task.

        Args:
            prompt: Task description for the agent.
            session_id: Reuse an existing runtime session.
            provider: LLM provider override.
            model: Model override.
            output_schema: Optional structured output schema.

        Returns:
            Execution result with status, summary, and token usage.
        """
        body: dict[str, Any] = {"prompt": prompt}
        if session_id is not None:
            body["sessionId"] = session_id
        if provider is not None:
            body["provider"] = provider
        if model is not None:
            body["model"] = model
        if output_schema is not None:
            body["outputSchema"] = output_schema
        data = await self._request("POST", "/api/v1/execute", json=body)
        return ExecutionResult(**data)

    async def plan(
        self,
        task: str,
        *,
        provider: str | None = None,
        model: str | None = None,
    ) -> PlanResult:
        """Run zero-cost deliberation (no LLM call).

        Returns complexity, topology, cost-band, and token estimates
        without executing anything.

        Args:
            task: Task description to analyze.
            provider: Optional provider hint for estimate.
            model: Optional model hint for estimate.

        Returns:
            Plan estimate with topology, complexity, budget.
        """
        body: dict[str, Any] = {"task": task}
        if provider is not None:
            body["provider"] = provider
        if model is not None:
            body["model"] = model
        data = await self._request("POST", "/api/v1/plan", json=body)
        return PlanResult(**data)

    async def stream(self, session_id: str) -> CommanderSSEStream:
        """Get an async generator of SSE events for a running session.

        Args:
            session_id: The runtime session ID (returned by ``run()``).

        Returns:
            An async iterable of ``SSEEvent`` objects.
        """
        return CommanderSSEStream(self._http, session_id, self._base_url)

    # ------------------------------------------------------------------
    # Memory
    # ------------------------------------------------------------------

    async def memory_write(
        self,
        content: str,
        *,
        importance: float = 0.5,
        tags: list[str] | None = None,
        layer: str = "episodic",
    ) -> MemoryWriteResult:
        """Write to memory.

        Args:
            content: The content to store.
            importance: Importance score 0-1 (higher = more likely recalled).
            tags: Tags for categorical recall.
            layer: Memory layer (working, episodic, longterm).

        Returns:
            Write result with entry id or rejection info.
        """
        body: dict[str, Any] = {
            "action": "write",
            "content": content,
            "importance": importance,
            "layer": layer,
        }
        if tags is not None:
            body["tags"] = tags
        data = await self._request("POST", "/api/v1/memory", json=body)
        return MemoryWriteResult(**data)

    async def memory_query(
        self,
        *,
        keywords: list[str] | None = None,
        layer: str | None = None,
        importance_threshold: float = 0.3,
        limit: int = 10,
    ) -> MemoryQueryResult:
        """Query memory.

        Args:
            keywords: Keywords for semantic search.
            layer: Filter by memory layer.
            importance_threshold: Minimum importance (0-1).
            limit: Maximum results.

        Returns:
            Matching memory entries.
        """
        body: dict[str, Any] = {
            "action": "query",
            "importanceThreshold": importance_threshold,
            "limit": limit,
        }
        if keywords is not None:
            body["keywords"] = keywords
        if layer is not None:
            body["layer"] = layer
        data = await self._request("POST", "/api/v1/memory", json=body)
        return MemoryQueryResult(**data)

    async def memory_stats(self) -> MemoryStats:
        """Get memory statistics.

        Returns:
            Stats including total entries, per-layer counts, avg importance.
        """
        body: dict[str, Any] = {"action": "stats"}
        data = await self._request("POST", "/api/v1/memory", json=body)
        return MemoryStats(**data)

    # ------------------------------------------------------------------
    # Monitoring
    # ------------------------------------------------------------------

    async def health(self) -> HealthStatus:
        """Liveness probe.

        Returns:
            Health status with uptime and active session count.
        """
        data = await self._request("GET", "/health")
        return HealthStatus(**data)

    async def health_detailed(self) -> dict[str, Any]:
        """Detailed health check with component statuses.

        Returns:
            Detailed health report including circuit breaker state,
            DLQ size, checkpoint staleness, etc.
        """
        return await self._request("GET", "/health/detailed")

    async def system_status(self) -> SystemStatus:
        """System status snapshot.

        Returns:
            Active sessions, bus topics, subscriber counts.
        """
        data = await self._request("GET", "/api/v1/status")
        return SystemStatus(**data)

    async def metrics(self) -> str:
        """Export metrics in OpenMetrics text format.

        Returns:
            Prometheus-compatible metrics text.
        """
        response = await self._http.get(
            "/metrics",
            headers={"Accept": "text/plain"},
        )
        response.raise_for_status()
        return response.text

    # ------------------------------------------------------------------
    # Internal
    # ------------------------------------------------------------------

    def _build_headers(self) -> dict[str, str]:
        headers: dict[str, str] = {"Content-Type": "application/json"}
        if self._api_key:
            headers["Authorization"] = f"Bearer {self._api_key}"
        return headers

    async def _request(
        self,
        method: str,
        path: str,
        **kwargs: Any,
    ) -> dict[str, Any]:
        for attempt in range(self._max_retries):
            try:
                response = await self._http.request(method, path, **kwargs)
                if response.status_code == 429:
                    retry_after = _parse_retry_after(response)
                    raise RateLimitError(
                        "Rate limited",
                        retry_after=retry_after,
                    )
                response.raise_for_status()
                result: dict[str, Any] = response.json()
                return result
            except httpx.HTTPStatusError as exc:
                body = exc.response.text
                raise map_status_to_error(exc.response.status_code, body) from exc
            except (httpx.ConnectError, httpx.ReadTimeout) as exc:
                if attempt < self._max_retries - 1:
                    await asyncio.sleep(2**attempt)
                    continue
                raise ConnectionError(
                    f"Failed after {self._max_retries} retries"
                ) from exc
        # Should not reach here, but satisfy the type checker
        raise CommanderError("Unexpected error in request retry loop")


def _parse_retry_after(response: httpx.Response) -> float | None:
    raw = response.headers.get("Retry-After")
    if raw is None:
        return None
    try:
        return float(raw)
    except ValueError:
        return None
