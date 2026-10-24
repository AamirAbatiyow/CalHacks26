import { useEffect, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { X } from 'lucide-react';

interface DrawerProps {
  open: boolean;
  onClose: () => void;
  eyebrow?: string;
  title: ReactNode;
  children: ReactNode;
}

/** Right-hand detail panel inside the page area; detail text lives here instead of on the page. */
export function Drawer({ open, onClose, eyebrow, title, children }: DrawerProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            key="scrim"
            className="ui-drawer-scrim"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            onClick={onClose}
          />
          <motion.aside
            key="drawer"
            className="ui-drawer"
            role="dialog"
            aria-label={typeof title === 'string' ? title : eyebrow}
            initial={{ x: 24, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: 24, opacity: 0 }}
            transition={{ duration: 0.22, ease: [0.2, 0, 0, 1] }}
          >
            <header className="ui-drawer-head">
              <div>
                {eyebrow && <div className="ui-eyebrow">{eyebrow}</div>}
                <div className="ui-drawer-title">{title}</div>
              </div>
              <button className="ui-icon-btn" onClick={onClose} aria-label="Close details" title="Close (Esc)">
                <X size={14} />
              </button>
            </header>
            <div className="ui-drawer-body">{children}</div>
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}

/** One label/value line inside a drawer. */
export function Fact({ label, value, tone }: { label: string; value: ReactNode; tone?: 'warn' | 'block' | 'pass' }) {
  return (
    <div className="ui-fact">
      <span className="ui-fact-label">{label}</span>
      <span className={`ui-fact-value ${tone ? `tone-${tone}` : ''}`}>{value}</span>
    </div>
  );
}
