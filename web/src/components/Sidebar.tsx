import { useState } from 'react';
import './Sidebar.css';

interface NavItem {
  id: string;
  label: string;
  icon: string;
  enabled: boolean;
}

const navItems: NavItem[] = [
  { id: 'overview', label: 'Overview', icon: '⌂', enabled: true },
  { id: 'disputes', label: 'Disputes', icon: '⚡', enabled: false },
  { id: 'approvals', label: 'Approvals', icon: '☐', enabled: false },
  { id: 'customers', label: 'Customers', icon: '⚇', enabled: false },
  { id: 'finance', label: 'Finance', icon: '$', enabled: false },
  { id: 'ledger', label: 'Ledger', icon: '≡', enabled: false },
  { id: 'audit', label: 'Audit', icon: '⊙', enabled: false },
  { id: 'policies', label: 'Policies', icon: '⚙', enabled: false },
  { id: 'breakit', label: 'Break It', icon: '⊕', enabled: false },
];

export function Sidebar() {
  const [activeItem, setActiveItem] = useState('overview');

  return (
    <nav className="sidebar">
      <div className="sidebar-logo">
        <span className="logo-icon">⌂</span>
      </div>
      <div className="sidebar-nav">
        {navItems.map((item) => (
          <button
            key={item.id}
            className={`sidebar-item ${activeItem === item.id ? 'active' : ''} ${!item.enabled ? 'disabled' : ''}`}
            onClick={() => item.enabled && setActiveItem(item.id)}
            disabled={!item.enabled}
            title={item.label}
          >
            <span className="sidebar-icon">{item.icon}</span>
            <span className="sidebar-label">{item.label}</span>
          </button>
        ))}
      </div>
    </nav>
  );
}
