import './Sidebar.css';

export type PageId = 'overview' | 'claims' | 'approvals' | 'customers' | 'finance' | 'ledger' | 'audit' | 'policies' | 'breakit';

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
  { id: 'customers', label: 'Customers', icon: '⚇', enabled: false },
  { id: 'finance', label: 'Finance', icon: '$', enabled: true },
  { id: 'ledger', label: 'Ledger', icon: '≡', enabled: false },
  { id: 'audit', label: 'Audit', icon: '⊙', enabled: false },
  { id: 'policies', label: 'Policies', icon: '⚙', enabled: true },
  { id: 'breakit', label: 'Break It', icon: '⊕', enabled: true },
];

interface SidebarProps {
  activePage: PageId;
  onNavigate: (page: PageId) => void;
  pendingApprovalsCount: number;
}

export function Sidebar({ activePage, onNavigate, pendingApprovalsCount }: SidebarProps) {
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
