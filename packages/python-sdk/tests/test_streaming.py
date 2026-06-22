"""Tests for low-level SSE stream parsing."""

from __future__ import annotations

import httpx
import pytest
import respx

from commander._streaming import CommanderSSEStream


@pytest.mark.asyncio
async def test_parse_structured_event():
    """Parse a single structured SSE event."""
    sse = (
        "event: output.delta\n"
        'data: {"event":"output.delta","data":{"content":"Hello"},"timestamp":"2026-01-01T00:00:00Z","seq":1}\n'
        "\n"
        'data: [DONE]\n'
        "\n"
    )
    async with httpx.AsyncClient() as client:
        stream = CommanderSSEStream(client, "sid", "http://localhost:3001")
        # Mock the inner URL
        with respx.mock(base_url="http://localhost:3001") as mock:
            mock.get("/api/v1/stream/sid").respond(
                200, text=sse, headers={"Content-Type": "text/event-stream"}
            )
            events = [e async for e in stream]
    assert len(events) == 1
    assert events[0].event == "output.delta"
    assert events[0].data["content"] == "Hello"
    assert events[0].seq == 1


@pytest.mark.asyncio
async def test_parse_raw_event_fallback():
    """Parse raw SSE event (no 'event:' line, just 'data:')."""
    sse = (
        'data: {"event":"output.delta","data":{"content":"raw"},"timestamp":"...","seq":1}\n'
        "\n"
        'data: [DONE]\n'
        "\n"
    )
    async with httpx.AsyncClient() as client:
        stream = CommanderSSEStream(client, "sid", "http://localhost:3001")
        with respx.mock(base_url="http://localhost:3001") as mock:
            mock.get("/api/v1/stream/sid").respond(
                200, text=sse, headers={"Content-Type": "text/event-stream"}
            )
            events = [e async for e in stream]
    assert len(events) == 1
    assert events[0].event == "output.delta"


@pytest.mark.asyncio
async def test_parse_multiple_events():
    """Parse multiple structured events in one stream."""
    sse = (
        'data: {"event":"agent.thinking","data":{"content":"hmm"},"timestamp":"...","seq":1}\n'
        "\n"
        'data: {"event":"tool_call.started","data":{"toolName":"grep"},"timestamp":"...","seq":2}\n'
        "\n"
        'data: [DONE]\n'
        "\n"
    )
    async with httpx.AsyncClient() as client:
        stream = CommanderSSEStream(client, "sid", "http://localhost:3001")
        with respx.mock(base_url="http://localhost:3001") as mock:
            mock.get("/api/v1/stream/sid").respond(
                200, text=sse, headers={"Content-Type": "text/event-stream"}
            )
            events = [e async for e in stream]
    assert len(events) == 2
    assert events[0].event == "agent.thinking"
    assert events[1].event == "tool_call.started"


@pytest.mark.asyncio
async def test_malformed_json_skipped():
    """Malformed JSON in data field is silently skipped."""
    sse = (
        'data: {invalid json}\n'
        "\n"
        'data: {"event":"ok","data":{},"timestamp":"...","seq":1}\n'
        "\n"
        'data: [DONE]\n'
        "\n"
    )
    async with httpx.AsyncClient() as client:
        stream = CommanderSSEStream(client, "sid", "http://localhost:3001")
        with respx.mock(base_url="http://localhost:3001") as mock:
            mock.get("/api/v1/stream/sid").respond(
                200, text=sse, headers={"Content-Type": "text/event-stream"}
            )
            events = [e async for e in stream]
    assert len(events) == 1


@pytest.mark.asyncio
async def test_stream_from_response():
    """Static iter_from_response works with pre-opened httpx response."""
    sse = (
        'data: {"event":"test","data":{"x":1},"timestamp":"...","seq":1}\n'
        "\n"
        'data: [DONE]\n'
        "\n"
    )
    async with httpx.AsyncClient() as client:
        async with respx.mock(base_url="http://localhost:3001") as mock:
            mock.get("/api/v1/stream/sid").respond(
                200, text=sse, headers={"Content-Type": "text/event-stream"}
            )
            response = await client.get("http://localhost:3001/api/v1/stream/sid")
            events = [e async for e in CommanderSSEStream.iter_from_response(response)]
    assert len(events) == 1
    assert events[0].data["x"] == 1
