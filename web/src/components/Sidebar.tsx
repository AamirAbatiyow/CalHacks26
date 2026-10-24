import './Sidebar.css';

export interface NavItemConfig {
  icon: string;
  label: string;
  id: string;
}

const navItems: NavItemConfig[] = [
  { id: 'overview', icon: '◉', label: 'Overview' },
  { id: 'disputes', icon: '◎', label: 'Disputes' },
  { id: 'approvals', icon: '☐', label: 'Approvals' },
  { id: 'customers', icon: '◇', label: 'Customers' },
  { id: 'finance', icon: '◆', label: 'Finance' },
  { id: 'ledger', icon: '▤', label: 'Ledger' },
  { id: 'audit', icon: '▣', label: 'Audit' },
  { id: 'policies', icon: '◈', label: 'Policies' },
  { id: 'breakit', icon: '⊕', label: 'Break It' },
];

export interface SidebarProps {
  activeItem?: string;
  onNavigate?: (id: string) => void;
}

export function Sidebar({ activeItem = 'overview', onNavigate }: SidebarProps) {
  return (
    <aside className="sidebar">
      <div className="sidebar-logo">⬡</div>
      <nav className="sidebar-nav">
        {navItems.map((item) => (
          <NavItem
            key={item.id}
            icon={item.icon}
            label={item.label}
            active={item.id === activeItem}
            onClick={() => onNavigate?.(item.id)}
          />
        ))}
      </nav>
    </aside>
  );
}

interface NavItemProps {
  icon: string;
  label: string;
  active?: boolean;
  onClick?: () => void;
}

function NavItem({ icon, label, active = false, onClick }: NavItemProps) {
  return (
    <button
      className={`sidebar-nav-item ${active ? 'active' : ''}`}
      title={label}
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
    >
      <span className="sidebar-nav-icon">{icon}</span>
      <span className="sidebar-nav-label">{label}</span>
    </button>
  );
}
