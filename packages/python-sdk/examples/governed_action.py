"""Governed action example — simulate, propose, approve via /v1/actions."""

from __future__ import annotations

import asyncio
import os
import time

from commander._gateway_client import CommanderGatewayClient
from commander._types import ActionApprovalInput, ProposeActionInput


async def main() -> None:
    api_key = os.environ.get("COMMANDER_API_KEY")
    if not api_key:
        raise SystemExit("Set COMMANDER_API_KEY to call /v1/actions")

    base_url = os.environ.get("COMMANDER_API_URL", "http://127.0.0.1:4000")
    action_input = ProposeActionInput(
        source="python-sdk-example",
        package="demo.package",
        model="demo-model",
        tool="ticket.create",
        destination="demo://tickets/approval",
        effect_type="demo.ticket.create",
        args={"title": "Reset password"},
        idempotency_key=f"python-example-{int(time.time())}",
    )

    async with CommanderGatewayClient(base_url=base_url, api_key=api_key) as client:
        simulation = await client.simulate_action(action_input)
        print("simulate", simulation.effect, simulation.action_digest)

        action, _replay, accepted = await client.propose_action(action_input)
        print("propose", action.state, accepted)

        if action.decision.effect == "require_approval":
            approved = await client.approve_action(
                action.run_id,
                ActionApprovalInput(
                    action_digest=simulation.action_digest,
                    simulation_id=simulation.simulation_id,
                    policy_snapshot_id=simulation.policy_snapshot_id,
                ),
            )
            print("approve", approved.state)

        evidence = await client.get_action_evidence(action.run_id)
        print("evidence", evidence.verification)


if __name__ == "__main__":
    asyncio.run(main())
