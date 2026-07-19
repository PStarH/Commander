"""HTTP client for the Architecture V2 Action Gateway."""

from __future__ import annotations

import os
from typing import Any

import httpx

from ._exceptions import map_status_to_error
from ._types import (
    ActionApprovalInput,
    ActionEvidenceBundle,
    ActionSimulation,
    GovernedAction,
    ProposeActionInput,
)


class CommanderGatewayClient:
    """Thin HTTP client for /v1/actions governed action endpoints."""

    def __init__(
        self,
        *,
        base_url: str | None = None,
        api_key: str | None = None,
        timeout: float = 60.0,
    ) -> None:
        self._base_url = (base_url or os.environ.get("COMMANDER_API_URL") or "http://127.0.0.1:4000").rstrip("/")
        self._api_key = api_key or os.environ.get("COMMANDER_API_KEY")
        self._http = httpx.AsyncClient(
            base_url=self._base_url,
            timeout=httpx.Timeout(timeout, connect=10.0),
            headers=self._build_headers(),
        )

    async def __aenter__(self) -> CommanderGatewayClient:
        return self

    async def __aexit__(self, *args: object) -> None:
        await self.close()

    async def close(self) -> None:
        await self._http.aclose()

    async def simulate_action(self, input: ProposeActionInput) -> ActionSimulation:
        data = await self._request(
            "POST",
            "/v1/actions/simulate",
            json=input.model_dump(by_alias=True),
        )
        return ActionSimulation(**data["simulation"])

    async def propose_action(
        self, input: ProposeActionInput
    ) -> tuple[GovernedAction, bool, bool]:
        response = await self._http.request(
            "POST",
            "/v1/actions",
            json=input.model_dump(by_alias=True),
            headers={"Idempotency-Key": input.idempotency_key},
        )
        if response.status_code >= 400:
            raise map_status_to_error(response.status_code, response.text)
        body = response.json()
        return (
            GovernedAction(**body["action"]),
            bool(body.get("idempotentReplay")),
            response.status_code == 202,
        )

    async def get_action(self, run_id: str) -> GovernedAction:
        data = await self._request("GET", f"/v1/actions/{run_id}")
        return GovernedAction(**data["action"])

    async def approve_action(
        self, run_id: str, input: ActionApprovalInput
    ) -> GovernedAction:
        data = await self._request(
            "POST",
            f"/v1/actions/{run_id}/approve",
            json=input.model_dump(by_alias=True),
        )
        return GovernedAction(**data["action"])

    async def reject_action(
        self, run_id: str, *, reason: str | None = None
    ) -> GovernedAction:
        body: dict[str, Any] = {}
        if reason is not None:
            body["reason"] = reason
        data = await self._request(
            "POST",
            f"/v1/actions/{run_id}/reject",
            json=body,
        )
        return GovernedAction(**data["action"])

    async def reconcile_action(self, run_id: str) -> dict[str, Any]:
        return await self._request("POST", f"/v1/actions/{run_id}/reconcile")

    async def get_action_evidence(self, run_id: str) -> ActionEvidenceBundle:
        data = await self._request("GET", f"/v1/actions/{run_id}/evidence")
        return ActionEvidenceBundle(**data)

    def _build_headers(self) -> dict[str, str]:
        headers = {"Accept": "application/json", "Content-Type": "application/json"}
        if self._api_key:
            headers["Authorization"] = f"Bearer {self._api_key}"
        return headers

    async def _request(self, method: str, path: str, **kwargs: Any) -> Any:
        response = await self._http.request(method, path, **kwargs)
        if response.status_code >= 400:
            raise map_status_to_error(response.status_code, response.text)
        if response.status_code in (204, 205) or response.content == b"":
            return {}
        return response.json()
