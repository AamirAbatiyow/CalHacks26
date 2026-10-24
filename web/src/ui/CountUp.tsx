import { useEffect, useRef } from 'react';
import { animate, useMotionValue, useReducedMotion, useTransform, motion } from 'motion/react';

interface CountUpProps {
  value: number;
  format: (n: number) => string;
  duration?: number;
  className?: string;
}

/** Counts from the previous value to `value`; the first render counts up from zero. */
export function CountUp({ value, format, duration = 0.9, className }: CountUpProps) {
  const reduce = useReducedMotion();
  const mv = useMotionValue(reduce ? value : 0);
  const text = useTransform(mv, n => format(n));
  const first = useRef(true);

  useEffect(() => {
    if (reduce) {
      mv.set(value);
      return;
    }
    const controls = animate(mv, value, {
      duration: first.current ? duration : duration * 0.6,
      ease: [0.2, 0, 0, 1],
    });
    first.current = false;
    return () => controls.stop();
  }, [value, duration, mv, reduce]);

  return <motion.span className={className}>{text}</motion.span>;
}

/** Same compact dollar format as `formatDollars`, for a plain number of cents. */
export function compactUsd(cents: number): string {
  const d = Math.abs(cents) / 100;
  if (d >= 1_000_000) return `$${(d / 1_000_000).toFixed(2)}M`;
  if (d >= 1000) return `$${(d / 1000).toFixed(1)}K`;
  return `$${d.toFixed(0)}`;
}

/** Dollars with cents only when the amount has them, e.g. $75 or $28.80. */
export function usd(cents: number | bigint): string {
  const c = Number(cents);
  const d = Math.abs(c) / 100;
  const s = c % 100 === 0
    ? d.toLocaleString('en-US', { maximumFractionDigits: 0 })
    : d.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${c < 0 ? '−' : ''}$${s}`;
}

export function wholeUsd(cents: number): string {
  return `$${Math.round(Math.abs(cents) / 100).toLocaleString('en-US')}`;
}
