import { Routes, Route } from 'react-router-dom';
import { useMemo } from 'react';
import { Sidebar } from './components/Sidebar';
import { Dashboard } from './pages/Dashboard';
import { AgentsPage } from './pages/AgentsPage';
import { MissionsPage } from './pages/MissionsPage';
import { ExecutionPage } from './pages/ExecutionPage';
import { MemoryPage } from './pages/MemoryPage';
import { GovernancePage } from './pages/GovernancePage';
import { SecurityPosturePage } from './pages/SecurityPosturePage';
import { useWarRoom } from './hooks/useWarRoom';

export default function App() {
  const {
    snapshot,
    memoryItems,
    memoryOverview,
    loading,
    error,
    dismissError,
    createMission,
    updateMissionStatus,
    approveMission,
    createLog,
    searchMemory,
  } = useWarRoom();

  const agentNameById = useMemo(() => {
    return new Map((snapshot?.agents ?? []).map((a) => [a.agentId, a.agentName]));
  }, [snapshot?.agents]);

  return (
    <div className="app-shell">
      <Sidebar />
      <main className="main-content">
        {error && (
          <div className="banner error">
            <span>{error}</span>
            <button type="button" className="banner-close" onClick={dismissError}>
              ×
            </button>
          </div>
        )}

        {loading && !snapshot && (
          <div className="loading-screen">
            <div className="loader" />
            <p>Establishing contact with Command...</p>
          </div>
        )}

        {snapshot && (
          <Routes>
            <Route
              path="/"
              element={
                <Dashboard
                  snapshot={snapshot}
                  memoryItems={memoryItems}
                  memoryOverview={memoryOverview}
                  loading={loading}
                  agentNameById={agentNameById}
                  onStatusChange={updateMissionStatus}
                  onApprove={approveMission}
                  onCreateMission={createMission}
                  onCreateLog={createLog}
                  onSearchMemory={searchMemory}
                />
              }
            />
            <Route path="/agents" element={<AgentsPage agents={snapshot.agents} />} />
            <Route
              path="/missions"
              element={
                <MissionsPage
                  missions={snapshot.missions}
                  agents={snapshot.agents}
                  agentNameById={agentNameById}
                  onStatusChange={updateMissionStatus}
                  onApprove={approveMission}
                  onCreateMission={createMission}
                />
              }
            />
            <Route
              path="/execution"
              element={
                <ExecutionPage
                  logs={snapshot.latestLogs}
                  missions={snapshot.missions}
                  agentNameById={agentNameById}
                  onCreateLog={createLog}
                />
              }
            />
            <Route
              path="/memory"
              element={
                <MemoryPage items={memoryItems} overview={memoryOverview} onSearch={searchMemory} />
              }
            />
            <Route
              path="/governance"
              element={
                <GovernancePage
                  missions={snapshot.missions}
                  battleReport={snapshot.battleReport}
                  onApprove={approveMission}
                  onStatusChange={updateMissionStatus}
                />
              }
            />
          </Routes>
        )}
        <Routes>
          <Route path="/security" element={<SecurityPosturePage />} />
        </Routes>
      </main>
    </div>
  );
}
