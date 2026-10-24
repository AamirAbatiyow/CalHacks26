import { motion } from 'motion/react';
import type { ReactNode } from 'react';

type Art = 'orbit' | 'inbox' | 'ledger' | 'shield' | 'graph';

/** Line-art spot illustrations drawn in the muted stroke; the accent marks the one live element. */
function Illustration({ art }: { art: Art }) {
  const stroke = 'var(--color-muted)';
  const accent = 'var(--color-accent)';
  const common = { fill: 'none', stroke, strokeWidth: 1.25, strokeLinecap: 'round' as const };
  switch (art) {
    case 'orbit':
      return (
        <svg viewBox="0 0 96 64" width="96" height="64" aria-hidden>
          <ellipse cx="48" cy="34" rx="38" ry="14" {...common} strokeDasharray="2 4" />
          <circle cx="48" cy="34" r="11" {...common} />
          <motion.circle r="3" fill={accent}
            animate={{ cx: [10, 48, 86, 48, 10], cy: [34, 48, 34, 20, 34] }}
            transition={{ duration: 6, repeat: Infinity, ease: 'linear' }} />
        </svg>
      );
    case 'inbox':
      return (
        <svg viewBox="0 0 96 64" width="96" height="64" aria-hidden>
          <path d="M22 30 L30 14 H66 L74 30 V52 H22 Z" {...common} />
          <path d="M22 30 H38 L42 37 H54 L58 30 H74" {...common} />
          <motion.path d="M40 23 L46 28 L57 18" fill="none" stroke="var(--color-green)" strokeWidth={1.5} strokeLinecap="round"
            initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 0.8, delay: 0.2 }} />
        </svg>
      );
    case 'ledger':
      return (
        <svg viewBox="0 0 96 64" width="96" height="64" aria-hidden>
          <rect x="26" y="10" width="44" height="46" rx="3" {...common} />
          {[20, 28, 36, 44].map((y, i) => (
            <line key={y} x1="33" y1={y} x2={i === 3 ? 50 : 63} y2={y} {...common} />
          ))}
          <motion.circle cx="63" cy="44" r="2.5" fill={accent} animate={{ opacity: [0.3, 1, 0.3] }} transition={{ duration: 2, repeat: Infinity }} />
        </svg>
      );
    case 'shield':
      return (
        <svg viewBox="0 0 96 64" width="96" height="64" aria-hidden>
          <path d="M48 8 L70 16 V32 C70 45 60 53 48 57 C36 53 26 45 26 32 V16 Z" {...common} />
          <motion.path d="M38 32 L45 39 L58 25" fill="none" stroke={accent} strokeWidth={1.5} strokeLinecap="round"
            initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 0.8, delay: 0.2 }} />
        </svg>
      );
    case 'graph':
      return (
        <svg viewBox="0 0 96 64" width="96" height="64" aria-hidden>
          <rect x="8" y="24" width="18" height="14" rx="3" {...common} />
          <rect x="39" y="24" width="18" height="14" rx="3" {...common} />
          <rect x="70" y="24" width="18" height="14" rx="3" {...common} stroke={accent} />
          <line x1="26" y1="31" x2="39" y2="31" {...common} />
          <line x1="57" y1="31" x2="70" y2="31" {...common} strokeDasharray="2 3" />
        </svg>
      );
  }
}

interface EmptyStateProps {
  art: Art;
  title: string;
  hint?: ReactNode;
  action?: ReactNode;
  compact?: boolean;
}

export function EmptyState({ art, title, hint, action, compact }: EmptyStateProps) {
  return (
    <motion.div
      className={`ui-empty ${compact ? 'compact' : ''}`}
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: [0.2, 0, 0, 1] }}
    >
      <Illustration art={art} />
      <div className="ui-empty-title">{title}</div>
      {hint && <div className="ui-empty-hint">{hint}</div>}
      {action}
    </motion.div>
  );
}
