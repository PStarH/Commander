export interface AuthenticatedEventStreamHandlers {
  onOpen?: () => void;
  onEvent?: (eventName: string, data: string, id?: string) => void;
  onError?: (error: unknown) => void;
}

export interface AuthenticatedEventStream {
  /** Resolves after the server accepts the stream and rejects on HTTP/transport failure. */
  ready: Promise<void>;
  close(): void;
}

/**
 * Open an SSE stream using the same Bearer authority as ordinary API calls.
 *
 * Native EventSource cannot set Authorization headers, which led the old client
 * to put the access token in a cookie and then in the URL query string. Query
 * credentials are both a second authentication authority and a secret-leak
 * surface. This small fetch-based reader keeps the token in the request header
 * and parses the standard SSE framing without introducing another auth scheme.
 */
export function openAuthenticatedEventStream(
  url: string,
  token: string | null,
  handlers: AuthenticatedEventStreamHandlers = {},
): AuthenticatedEventStream {
  const controller = new AbortController();
  let closed = false;

  const ready = (async () => {
    if (!token || token.trim().length === 0) {
      throw new Error('Authentication required for event stream');
    }
    const response = await fetch(url, {
      headers: {
        Accept: 'text/event-stream',
        Authorization: `Bearer ${token}`,
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Event stream request failed with HTTP ${response.status}`);
    }
    if (!response.body) throw new Error('Event stream response has no body');

    handlers.onOpen?.();
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let eventName = 'message';
    let eventId: string | undefined;
    let dataLines: string[] = [];

    const dispatch = (): void => {
      if (dataLines.length === 0) {
        eventName = 'message';
        eventId = undefined;
        return;
      }
      handlers.onEvent?.(eventName, dataLines.join('\n'), eventId);
      eventName = 'message';
      eventId = undefined;
      dataLines = [];
    };

    while (!closed) {
      const chunk = await reader.read();
      if (chunk.done) {
        buffer += decoder.decode();
        break;
      }
      buffer += decoder.decode(chunk.value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line === '') {
          dispatch();
          continue;
        }
        if (line.startsWith(':')) continue;
        const separator = line.indexOf(':');
        const field = separator >= 0 ? line.slice(0, separator) : line;
        const value = separator >= 0 ? line.slice(separator + 1).replace(/^ /, '') : '';
        if (field === 'event') eventName = value;
        else if (field === 'id') eventId = value;
        else if (field === 'data') dataLines.push(value);
      }
    }
    dispatch();
  })();

  // The consumer receives failures through the callback; keep `ready` rejected
  // as well so callers that await it can distinguish a failed connection.
  void ready.catch((error) => {
    if (!closed) handlers.onError?.(error);
  });

  return {
    ready,
    close: () => {
      closed = true;
      controller.abort();
    },
  };
}
