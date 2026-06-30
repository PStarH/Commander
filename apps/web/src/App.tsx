import { Routes, Route, useNavigate, useLocation } from 'react-router-dom';
import { useMemo, useEffect, useRef } from 'react';
import { Sidebar } from './components/Sidebar';
import { Dashboard } from './pages/Dashboard';
import { AgentsPage } from './pages/AgentsPage';
import { MissionsPage } from './pages/MissionsPage';
import { ExecutionPage } from './pages/ExecutionPage';
import { MemoryPage } from './pages/MemoryPage';
import { GovernancePage } from './pages/GovernancePage';
import { SecurityPosturePage } from './pages/SecurityPosturePage';
import { ChatPage } from './pages/ChatPage';
import { DlqPage } from './pages/DlqPage';
import { CostPage } from './pages/CostPage';
import { AuditLogPage } from './pages/AuditLogPage';
import { KnowledgeBasePage } from './pages/KnowledgeBasePage';
import { EvalPage } from './pages/EvalPage';
import { ReportingPage } from './pages/ReportingPage';
import { ConsensusPage } from './pages/ConsensusPage';
import { LoginPage } from './pages/LoginPage';
import { OnboardingPage } from './pages/OnboardingPage';
import { useWarRoom } from './hooks/useWarRoom';
import { useAuth } from './hooks/useAuth';
import { fetchOnboardingStatus } from './api';

export default function App() {
  const auth = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
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

  // ── 首次登录自动跳转到 onboarding 向导 ──────────────────────────────────
  // 用户登录成功后检查 onboarding 状态；若未完成且当前不在 /onboarding，
  // 自动跳转。使用 ref 保证每次登录会话只检查一次，避免循环跳转。
  const onboardingCheckedRef = useRef(false);
  useEffect(() => {
    // 未登录时重置标记，下次登录重新检查
    if (!auth.isLoggedIn) {
      onboardingCheckedRef.current = false;
      return;
    }
    // 已检查过则跳过
    if (onboardingCheckedRef.current) return;
    onboardingCheckedRef.current = true;

    fetchOnboardingStatus()
      .then((status) => {
        if (!status.isComplete && location.pathname !== '/onboarding') {
          navigate('/onboarding');
        }
      })
      .catch(() => {
        // 状态查询失败不阻塞主流程
      });
  }, [auth.isLoggedIn, location.pathname, navigate]);

  // Show a spinner while validating a stored token on initial load.
  if (auth.loading) {
    return (
      <div className="loading-screen">
        <div className="loader" />
        <p>Authenticating...</p>
      </div>
    );
  }

  // Not logged in — show the login / register page.
  if (!auth.isLoggedIn) {
    return <LoginPage />;
  }

  return (
    <div className="app-shell">
      <Sidebar currentUser={auth.currentUser} onLogout={auth.logout} />
      <main className="main-content">
        {error && (
          <div className="banner error">
            <span>{error}</span>
            <button type="button" className="banner-close" onClick={dismissError}>
              ×
            </button>
          </div>
        )}

        {loading && !snapshot && location.pathname !== '/onboarding' && (
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
          <Route path="/chat" element={<ChatPage />} />
          <Route path="/dlq" element={<DlqPage />} />
          <Route path="/audit" element={<AuditLogPage />} />
          <Route path="/cost" element={<CostPage />} />
          <Route path="/knowledge" element={<KnowledgeBasePage />} />
          <Route path="/onboarding" element={<OnboardingPage />} />
        </Routes>
      </main>
    </div>
  );
}
