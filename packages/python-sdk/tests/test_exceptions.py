"""Tests for exception hierarchy and HTTP status mapping."""

from __future__ import annotations

import pytest

from commander._exceptions import (
    AuthenticationError,
    CommanderError,
    ConnectionError,
    NotFoundError,
    RateLimitError,
    ServerError,
    ValidationError,
    map_status_to_error,
)


class TestExceptionHierarchy:
    def test_all_inherit_commander_error(self) -> None:
        assert issubclass(AuthenticationError, CommanderError)
        assert issubclass(RateLimitError, CommanderError)
        assert issubclass(NotFoundError, CommanderError)
        assert issubclass(ServerError, CommanderError)
        assert issubclass(ConnectionError, CommanderError)
        assert issubclass(ValidationError, CommanderError)

    def test_raise_and_catch_base(self) -> None:
        with pytest.raises(CommanderError):
            raise AuthenticationError("bad key")

    def test_rate_limit_has_retry_after(self) -> None:
        err = RateLimitError("too fast", retry_after=30.0)
        assert err.retry_after == 30.0

    def test_rate_limit_default_retry_after(self) -> None:
        err = RateLimitError("too fast")
        assert err.retry_after is None


class TestMapStatusToError:
    @pytest.mark.parametrize(
        ("status", "expected"),
        [
            (400, ValidationError),
            (401, AuthenticationError),
            (404, NotFoundError),
            (413, ValidationError),
            (429, RateLimitError),
            (500, ServerError),
            (502, ServerError),
            (503, ServerError),
            (418, CommanderError),  # teapot → generic
        ],
    )
    def test_mapping(self, status: int, expected: type[CommanderError]) -> None:
        err = map_status_to_error(status, "msg")
        assert isinstance(err, expected)

    def test_429_concrete(self) -> None:
        err = map_status_to_error(429, "too many requests")
        assert isinstance(err, RateLimitError)
        assert str(err) == "too many requests"
