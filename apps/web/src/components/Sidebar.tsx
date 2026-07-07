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
  FlaskConical,
  FileText,
  Network,
  Workflow,
  Settings,
  Key,
} from 'lucide-react';
import type { AuthUser } from '../api';
import { t } from '../i18n';

const NAV_ITEMS = [
  { to: '/', icon: LayoutDashboard, label: t('nav.dashboard') },
  { to: '/chat', icon: MessageSquare, label: t('nav.chat') },
  { to: '/agents', icon: Users, label: t('nav.agents') },
  { to: '/missions', icon: Kanban, label: t('nav.missions') },
  { to: '/execution', icon: ScrollText, label: t('nav.execution') },
  { to: '/memory', icon: BookOpen, label: t('nav.memory') },
  { to: '/governance', icon: ShieldCheck, label: t('nav.governance') },
  { to: '/workflows', icon: Workflow, label: t('nav.workflows') },
  { to: '/dlq', icon: AlertTriangle, label: t('nav.dlq') },
  { to: '/security', icon: Fingerprint, label: t('nav.security') },
  { to: '/audit', icon: ClipboardList, label: t('nav.audit') },
  { to: '/knowledge', icon: Library, label: t('nav.knowledge') },
  { to: '/eval', icon: FlaskConical, label: 'Eval' },
  { to: '/reporting', icon: FileText, label: 'Reporting' },
  { to: '/consensus', icon: Network, label: 'Consensus' },
  { to: '/cost', icon: DollarSign, label: t('nav.cost') },
  { to: '/settings', icon: Settings, label: t('nav.settings') },
  { to: '/onboarding', icon: Rocket, label: t('nav.onboarding') },
  { to: '/settings/sso', icon: Key, label: t('nav.sso') },
];

const ADMIN_ONLY_PATHS = new Set(['/users', '/settings', '/settings/sso']);

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
        {NAV_ITEMS.filter(
          (item) => !ADMIN_ONLY_PATHS.has(item.to) || currentUser?.role === 'admin',
        ).map((item) => (
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
          <div className="sidebar-user">
            <div className="sidebar-user-row">
              <div className="sidebar-user-avatar">
                <UserIcon size={12} />
              </div>
              <div className="sidebar-user-info">
                <div className="sidebar-user-name">{currentUser.username}</div>
                <div className="sidebar-user-role">{currentUser.role}</div>
              </div>
            </div>
            <button
              type="button"
              className="btn btn-ghost btn-sm sidebar-signout"
              onClick={onLogout}
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
