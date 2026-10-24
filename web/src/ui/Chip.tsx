import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

export type Tone = 'neutral' | 'pass' | 'warn' | 'block' | 'accent';

interface ChipProps {
  tone?: Tone;
  icon?: LucideIcon;
  children: ReactNode;
  title?: string;
}

/** Small status label. Tone is always paired with an icon or text so meaning never rests on colour alone. */
export function Chip({ tone = 'neutral', icon: Icon, children, title }: ChipProps) {
  return (
    <span className={`ui-chip tone-${tone}`} title={title}>
      {Icon && <Icon size={11} strokeWidth={2} aria-hidden />}
      {children}
    </span>
  );
}
