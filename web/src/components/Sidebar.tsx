import {
  BookText,
  Gauge,
  Globe2,
  Inbox,
  Network,
  ScrollText,
  Settings,
  ShieldAlert,
  SlidersHorizontal,
  Users,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import type { PageId } from '../hooks/useHashPage';
import { usePendingApprovals } from '../hooks/useApprovals';
import { useTable, tag } from '../hooks/useTable';
import './Sidebar.css';

export type { PageId };

interface NavItem {
  id: PageId;
  label: string;
  icon: LucideIcon;
  enabled: boolean;
}

const navItems: NavItem[] = [
  { id: 'overview', label: 'Overview', icon: Globe2, enabled: true },
  { id: 'claims', label: 'Claims', icon: Zap, enabled: true },
  { id: 'approvals', label: 'Approvals', icon: Inbox, enabled: true },
  { id: 'decisions', label: 'Decisions', icon: Network, enabled: true },
  { id: 'customers', label: 'Customers', icon: Users, enabled: false },
  { id: 'finance', label: 'Finance', icon: Gauge, enabled: true },
  { id: 'ledger', label: 'Ledger', icon: BookText, enabled: true },
  { id: 'audit', label: 'Audit', icon: ScrollText, enabled: true },
  { id: 'policies', label: 'Policies', icon: SlidersHorizontal, enabled: true },
  { id: 'breakit', label: 'Break It', icon: ShieldAlert, enabled: true },
  { id: 'settings', label: 'Settings', icon: Settings, enabled: true },
];

interface SidebarProps {
  activePage: PageId;
  onNavigate: (page: PageId) => void;
}

export function Sidebar({ activePage, onNavigate }: SidebarProps) {
  const escalatedCases = useTable('decisionCase').filter(c => tag(c.status) === 'Escalated').length;
  const pendingApprovalsCount = usePendingApprovals().length + escalatedCases;

  return (
    <nav className="sidebar">
      <div className="sidebar-logo">
        <span className="logo-icon"><Globe2 size={18} strokeWidth={1.5} /></span>
      </div>
      <div className="sidebar-nav">
        {navItems.map((item) => {
          const Icon = item.icon;
          const active = activePage === item.id;
          return (
            <button
              key={item.id}
              className={`sidebar-item ${active ? 'active' : ''} ${!item.enabled ? 'disabled' : ''} ${item.id === 'settings' ? 'sidebar-item-foot' : ''}`}
              onClick={() => item.enabled && onNavigate(item.id)}
              disabled={!item.enabled}
              title={item.label}
            >
              {active && <motion.span layoutId="sidebar-active" className="sidebar-active-bg" transition={{ duration: 0.25, ease: [0.2, 0, 0, 1] }} />}
              <span className="sidebar-icon-wrapper">
                <Icon className="sidebar-icon" size={16} strokeWidth={1.6} />
                <AnimatePresence>
                  {item.id === 'approvals' && pendingApprovalsCount > 0 && (
                    <motion.span
                      key="badge"
                      className="sidebar-badge"
                      initial={{ scale: 0.6, opacity: 0 }}
                      animate={{ scale: 1, opacity: 1 }}
                      exit={{ scale: 0.6, opacity: 0 }}
                    >
                      {pendingApprovalsCount > 99 ? '99+' : pendingApprovalsCount}
                    </motion.span>
                  )}
                </AnimatePresence>
              </span>
              <span className="sidebar-label">{item.label}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
