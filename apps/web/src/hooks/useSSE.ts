import { useEffect, useRef, useCallback } from 'react';
import { API_BASE, PROJECT_ID } from '../api';

type SSECallback = (data: string) => void;

export function useSSE(eventType: string, callback: SSECallback) {
  const callbackRef = useRef<SSECallback>(callback);
  callbackRef.current = callback;

  useEffect(() => {
    const url = `${API_BASE}/projects/${PROJECT_ID}/events`;
    let eventSource: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout>;
    let isMounted = true;

    function connect() {
      if (!isMounted) return;
      eventSource = new EventSource(url);

      eventSource.addEventListener(eventType, (event: MessageEvent) => {
        if (isMounted) {
          callbackRef.current(event.data);
        }
      });

      eventSource.onerror = () => {
        eventSource?.close();
        if (isMounted) {
          reconnectTimer = setTimeout(connect, 5000);
        }
      };
    }

    connect();

    return () => {
      isMounted = false;
      eventSource?.close();
      clearTimeout(reconnectTimer);
    };
  }, [eventType]);
}
