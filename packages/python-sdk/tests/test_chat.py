"""Tests for chat endpoints."""

from __future__ import annotations

import json

import httpx
import respx

from commander import CommanderClient


class TestChat:
    async def test_chat(self, mock_api: respx.MockRouter) -> None:
        mock_api.post("/api/chat").respond(
            200,
            json={
                "reply": "Hello!",
                "agent_id": "agent-commander",
                "run_id": "run_1",
                "timestamp": "2026-01-01T00:00:00Z",
            },
        )
        async with CommanderClient(api_key="test") as client:
            async with mock_api:
                result = await client.chat(
                    "hi",
                    agent_id="agent-commander",
                    project_id="project-war-room",
                )
        assert result.reply == "Hello!"
        assert result.agent_id == "agent-commander"

    async def test_chat_body(self, mock_api: respx.MockRouter) -> None:
        def check_body(request: httpx.Request) -> httpx.Response:
            data = json.loads(request.content)
            assert data["message"] == "hi"
            assert data["agentId"] == "agent-commander"
            assert data["projectId"] == "project-war-room"
            return httpx.Response(
                200, json={"reply": "ok", "agent_id": "agent-commander"}
            )

        mock_api.post("/api/chat").mock(side_effect=check_body)
        async with CommanderClient(api_key="test") as client:
            async with mock_api:
                await client.chat(
                    "hi",
                    agent_id="agent-commander",
                    project_id="project-war-room",
                )

    async def test_chat_history(self, mock_api: respx.MockRouter) -> None:
        mock_api.get("/api/chat/history").respond(
            200,
            json=[
                {
                    "role": "user",
                    "content": "hi",
                    "timestamp": "2026-01-01T00:00:00Z",
                }
            ],
        )
        async with CommanderClient(api_key="test") as client:
            async with mock_api:
                history = await client.chat_history(project_id="project-war-room")
        assert len(history.messages) == 1
        assert history.messages[0].content == "hi"


class TestChatStream:
    async def test_chat_stream(self, mock_api: respx.MockRouter) -> None:
        sse = (
            "event: start\n"
            'data: {"agentId":"agent-commander","timestamp":"2026-01-01T00:00:00Z"}\n\n'
            "event: step\n"
            'data: {"type":"thought","content":"thinking"}\n\n'
            "event: done\n"
            "data: {}\n\n"
            "data: [DONE]\n\n"
        )
        mock_api.post("/api/chat?stream=true").respond(
            200, text=sse, headers={"Content-Type": "text/event-stream"}
        )
        async with CommanderClient(api_key="test") as client:
            async with mock_api:
                stream = await client.chat_stream("hi")
                events = [e async for e in stream]

        assert len(events) == 3
        assert events[0].event == "start"
        assert events[1].event == "step"
        assert events[1].data["content"] == "thinking"
        assert events[2].event == "done"
