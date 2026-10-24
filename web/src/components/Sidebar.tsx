import type { PageId } from '../hooks/useHashPage';
import { usePendingApprovals } from '../hooks/useApprovals';
import { useTable, tag } from '../hooks/useTable';
import './Sidebar.css';

export type { PageId };

interface NavItem {
  id: PageId;
  label: string;
  icon: string;
  enabled: boolean;
}

const navItems: NavItem[] = [
  { id: 'overview', label: 'Overview', icon: '⌂', enabled: true },
  { id: 'claims', label: 'Claims', icon: '⚡', enabled: true },
  { id: 'approvals', label: 'Approvals', icon: '☐', enabled: true },
  { id: 'decisions', label: 'Decisions', icon: '◐', enabled: true },
  { id: 'customers', label: 'Customers', icon: '⚇', enabled: false },
  { id: 'finance', label: 'Finance', icon: '$', enabled: true },
  { id: 'ledger', label: 'Ledger', icon: '≡', enabled: true },
  { id: 'audit', label: 'Audit', icon: '⊙', enabled: true },
  { id: 'policies', label: 'Policies', icon: '⚙', enabled: true },
  { id: 'breakit', label: 'Break It', icon: '⊕', enabled: true },
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
        <span className="logo-icon">⌂</span>
      </div>
      <div className="sidebar-nav">
        {navItems.map((item) => (
          <button
            key={item.id}
            className={`sidebar-item ${activePage === item.id ? 'active' : ''} ${!item.enabled ? 'disabled' : ''}`}
            onClick={() => item.enabled && onNavigate(item.id)}
            disabled={!item.enabled}
            title={item.label}
          >
            <span className="sidebar-icon-wrapper">
              <span className="sidebar-icon">{item.icon}</span>
              {item.id === 'approvals' && pendingApprovalsCount > 0 && (
                <span className="sidebar-badge">{pendingApprovalsCount > 99 ? '99+' : pendingApprovalsCount}</span>
              )}
            </span>
            <span className="sidebar-label">{item.label}</span>
          </button>
        ))}
      </div>
    </nav>
  );
}
