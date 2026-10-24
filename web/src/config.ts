export const SPACETIMEDB_HOST = import.meta.env.VITE_SPACETIMEDB_HOST || 'http://localhost:3000';
export const SPACETIMEDB_MODULE = import.meta.env.VITE_SPACETIMEDB_MODULE || 'ground-truth';

export const GLOBE_ROTATION_PERIOD_MS = 120000;

export const AURORAL_OVAL_BASE_LATITUDE = 67;
export const AURORAL_OVAL_KP_SCALE = 3;

export const COLORS = {
  background: '#000000',
  primary: '#ffffff',
  secondary: '#888888',
  muted: '#444444',
  amber: '#f59e0b',
  amberMuted: 'rgba(245, 158, 11, 0.3)',
  green: '#22c55e',
  red: '#ef4444',
} as const;

export const TYPOGRAPHY = {
  body: '14px',
  metadata: '12px',
  headingLarge: '28px',
  headingMedium: '20px',
} as const;
