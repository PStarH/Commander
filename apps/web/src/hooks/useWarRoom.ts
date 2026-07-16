import { reportSilentFailure } from '../lib/silentFailure';
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
  createMission,
  updateMissionStatus,
  approveMission,
  createLog,
  ApprovalRequiredError,
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

    let eventSource: EventSource | null = null;
    try {
      const params = new URLSearchParams();
      const token = getAuthToken();
      if (token) {
        // Cookie preferred when API is same-site; query kept as cross-origin fallback
        // (server strips access_token from req.url before logging).
        document.cookie = `commander_access_token=${encodeURIComponent(token)}; path=/; SameSite=Lax`;
        params.set('access_token', token);
      }
      const qs = params.toString();
      eventSource = new EventSource(
        `${API_BASE}/projects/${PROJECT_ID}/events${qs ? `?${qs}` : ''}`,
        { withCredentials: true },
      );
      eventSource.onopen = () => setConnectionStatus('connected');
      eventSource.addEventListener('snapshot', () => {
        loadAllRef.current?.();
      });
      eventSource.onerror = () => {
        setConnectionStatus('disconnected');
      };
    } catch (err) {
      reportSilentFailure(err, 'useWarRoom:82');
      setConnectionStatus('disconnected');
    }

    const timer = window.setInterval(loadAll, 12000);

    return () => {
      window.clearInterval(timer);
      eventSource?.close();
    };
  }, [loadAll]);

  const handleCreateMission = async (payload: Parameters<typeof createMission>[0]) => {
    try {
      setError(null);
      await createMission(payload);
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    }
  };

  const handleUpdateMissionStatus = async (missionId: string, status: string) => {
    try {
      setError(null);
      await updateMissionStatus(missionId, status);
      await loadAll();
    } catch (err) {
      if (err instanceof ApprovalRequiredError) {
        setError(err.message);
        return;
      }
      setError(err instanceof Error ? err.message : 'Unknown error');
    }
  };

  const handleApproveMission = async (missionId: string) => {
    try {
      setError(null);
      await approveMission(missionId);
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    }
  };

  const handleCreateLog = async (missionId: string, payload: Parameters<typeof createLog>[1]) => {
    try {
      setError(null);
      await createLog(missionId, payload);
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    }
  };

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
    createMission: handleCreateMission,
    updateMissionStatus: handleUpdateMissionStatus,
    approveMission: handleApproveMission,
    createLog: handleCreateLog,
    searchMemory: handleSearchMemory,
  };
}
