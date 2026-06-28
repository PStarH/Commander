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
  ChevronRight,
} from 'lucide-react';

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
];

export function Sidebar() {
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
        <div className="sidebar-status" />
        <span>All systems nominal</span>
      </div>
    </aside>
  );
}
