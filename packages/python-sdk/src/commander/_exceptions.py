"""Exception hierarchy for Commander SDK errors."""


class CommanderError(Exception):
    """Base exception for all Commander SDK errors."""


class AuthenticationError(CommanderError):
    """401 Unauthorized — invalid or missing API key."""


class RateLimitError(CommanderError):
    """429 Too Many Requests — rate limit exceeded."""

    def __init__(self, message: str, retry_after: float | None = None) -> None:
        super().__init__(message)
        self.retry_after = retry_after


class NotFoundError(CommanderError):
    """404 Not Found — resource does not exist."""


class ServerError(CommanderError):
    """5xx Server Error — Commander server issue."""


class ConnectionError(CommanderError):
    """Failed to connect to Commander server after all retries."""


class TimeoutError(CommanderError):
    """Request timed out."""


class ValidationError(CommanderError):
    """Request validation failed (400 Bad Request)."""


def map_status_to_error(status_code: int, body_text: str) -> CommanderError:
    """Map an HTTP status code to the appropriate CommanderError subclass.

    Args:
        status_code: The HTTP response status code.
        body_text: The response body text (usually a JSON error message).

    Returns:
        A CommanderError instance appropriate for the status code.
    """
    if status_code == 400:
        return ValidationError(body_text)
    if status_code == 401:
        return AuthenticationError(body_text)
    if status_code == 404:
        return NotFoundError(body_text)
    if status_code == 413:
        return ValidationError(body_text)
    if status_code == 429:
        return RateLimitError(body_text)
    if 500 <= status_code < 600:
        return ServerError(body_text)
    return CommanderError(f"HTTP {status_code}: {body_text}")
