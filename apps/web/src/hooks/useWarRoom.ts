import { reportSilentFailure } from '../lib/silentFailure';
import { openAuthenticatedEventStream } from '../lib/authenticatedEventStream';
import { useState, useEffect, useCallback, useRef } from 'react';
import type {
  WarRoomSnapshot,
  ProjectMemoryItem,
  MemoryOverview,
  MemoryKindFilter,
} from '../types';
import {
  fetchWarRoomSnapshot,
  fetchMemoryItems,
  fetchMemoryOverview,
  API_BASE,
  PROJECT_ID,
  getAuthToken,
} from '../api';

export function useWarRoom() {
  const [snapshot, setSnapshot] = useState<WarRoomSnapshot | null>(null);
  const [memoryItems, setMemoryItems] = useState<ProjectMemoryItem[]>([]);
  const [memoryOverview, setMemoryOverview] = useState<MemoryOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<
    'connecting' | 'connected' | 'disconnected'
  >('connecting');
  const isFirstLoad = useRef(true);
  const loadAllRef = useRef<() => Promise<void> | undefined>(undefined);

  const loadAll = useCallback(async () => {
    try {
      if (isFirstLoad.current) setLoading(true);
      setError(null);

      const results = await Promise.allSettled([
        fetchWarRoomSnapshot(),
        fetchMemoryItems(),
        fetchMemoryOverview(),
      ]);

      if (results[0].status === 'fulfilled') {
        setSnapshot(results[0].value);
      } else {
        throw new Error('Failed to load war room snapshot');
      }

      if (results[1].status === 'fulfilled') {
        setMemoryItems(results[1].value);
      }
      if (results[2].status === 'fulfilled') {
        setMemoryOverview(results[2].value);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      if (isFirstLoad.current) {
        setLoading(false);
        isFirstLoad.current = false;
      }
    }
  }, []);

  loadAllRef.current = loadAll;

  useEffect(() => {
    loadAll();

    let eventStream: ReturnType<typeof openAuthenticatedEventStream> | null = null;
    try {
      eventStream = openAuthenticatedEventStream(
        `${API_BASE}/projects/${PROJECT_ID}/events`,
        getAuthToken(),
        {
          onOpen: () => setConnectionStatus('connected'),
          onEvent: (eventName) => {
            if (eventName === 'snapshot') loadAllRef.current?.();
          },
          onError: (err) => {
            reportSilentFailure(err, 'useWarRoom:82');
            setConnectionStatus('disconnected');
          },
        },
      );
      // The helper reports failures through onError; avoid an unhandled promise
      // while still allowing callers/tests to await `.ready` directly.
      void eventStream.ready.catch(() => undefined);
    } catch (err) {
      reportSilentFailure(err, 'useWarRoom:82');
      setConnectionStatus('disconnected');
    }

    const timer = window.setInterval(loadAll, 12000);

    return () => {
      window.clearInterval(timer);
      eventStream?.close();
    };
  }, [loadAll]);

  const handleSearchMemory = async (filters?: {
    query?: string;
    kind?: MemoryKindFilter;
    tags?: string;
  }) => {
    try {
      setError(null);
      const items = await fetchMemoryItems(filters);
      setMemoryItems(items);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    }
  };

  const dismissError = () => setError(null);

  return {
    snapshot,
    memoryItems,
    memoryOverview,
    loading,
    error,
    connectionStatus,
    dismissError,
    reload: loadAll,
    searchMemory: handleSearchMemory,
  };
}
