import { NavLink } from 'react-router-dom';
import {
  LayoutDashboard,
  Users,
  Kanban,
  ScrollText,
  BookOpen,
  ShieldCheck,
  Fingerprint,
  MessageSquare,
  AlertTriangle,
  DollarSign,
  Library,
  ClipboardList,
  ChevronRight,
  LogOut,
  User as UserIcon,
  Rocket,
} from 'lucide-react';
import type { AuthUser } from '../api';

const NAV_ITEMS = [
  { to: '/', icon: LayoutDashboard, label: 'Dashboard' },
  { to: '/chat', icon: MessageSquare, label: 'Chat' },
  { to: '/agents', icon: Users, label: 'Agents' },
  { to: '/missions', icon: Kanban, label: 'Missions' },
  { to: '/execution', icon: ScrollText, label: 'Execution' },
  { to: '/memory', icon: BookOpen, label: 'Memory' },
  { to: '/governance', icon: ShieldCheck, label: 'Governance' },
  { to: '/dlq', icon: AlertTriangle, label: 'DLQ' },
  { to: '/security', icon: Fingerprint, label: 'Security' },
  { to: '/audit', icon: ClipboardList, label: '审计日志' },
  { to: '/knowledge', icon: Library, label: '知识库' },
  { to: '/cost', icon: DollarSign, label: 'Cost' },
  { to: '/onboarding', icon: Rocket, label: '上手引导' },
];

interface SidebarProps {
  currentUser?: AuthUser | null;
  onLogout?: () => void;
}

export function Sidebar({ currentUser, onLogout }: SidebarProps) {
  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <div className="sidebar-logo">
          <ChevronRight size={20} />
        </div>
        <div>
          <div className="sidebar-title">Commander</div>
          <div className="sidebar-ver">v0 · War Room</div>
        </div>
      </div>

      <nav className="sidebar-nav">
        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === '/'}
            className={({ isActive }) => `sidebar-link ${isActive ? 'active' : ''}`}
          >
            <item.icon size={16} />
            <span>{item.label}</span>
          </NavLink>
        ))}
      </nav>

      <div className="sidebar-footer">
        {currentUser ? (
          <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <div
                style={{
                  width: '24px',
                  height: '24px',
                  borderRadius: '50%',
                  border: '1px solid var(--accent-green-border)',
                  background: 'var(--accent-green-bg)',
                  color: 'var(--accent-green)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                }}
              >
                <UserIcon size={12} />
              </div>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div
                  style={{
                    fontSize: '0.78rem',
                    color: 'var(--text-secondary)',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                >
                  {currentUser.username}
                </div>
                <div style={{ fontSize: '0.64rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                  {currentUser.role}
                </div>
              </div>
            </div>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={onLogout}
              style={{ width: '100%' }}
            >
              <LogOut size={12} />
              Sign Out
            </button>
          </div>
        ) : (
          <>
            <div className="sidebar-status" />
            <span>All systems nominal</span>
          </>
        )}
      </div>
    </aside>
  );
}
