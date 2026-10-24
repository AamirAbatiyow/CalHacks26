import type { ReactNode } from 'react';
import { STORM_LEVELS, stormLevel } from '../utils/storm';
import { MARKER_COLORS } from './globeMarkers';
import './GlobeLegend.css';

interface GlobeLegendProps {
  kp: number;
  showLinks?: boolean;
  extra?: { swatch: ReactNode; label: string }[];
}

export function GlobeLegend({ kp, showLinks = true, extra = [] }: GlobeLegendProps) {
  const current = stormLevel(kp);
  return (
    <div className="globe-legend" aria-label="Map legend">
      <div className="legend-row">
        <span className="legend-swatch station" style={{ borderBottomColor: MARKER_COLORS.station }} />
        Ground station
      </div>
      <div className="legend-row">
        <span className="legend-swatch satellite" style={{ background: MARKER_COLORS.satellite }} />
        Satellite + trail
      </div>
      {showLinks && (
        <>
          <div className="legend-row">
            <span className="legend-swatch line" style={{ background: MARKER_COLORS.link }} />
            Pass link
          </div>
          <div className="legend-row">
            <span className="legend-swatch line" style={{ background: current?.color ?? MARKER_COLORS.dropped }} />
            Affected pass
          </div>
        </>
      )}
      {extra.map(e => (
        <div className="legend-row" key={e.label}>{e.swatch}{e.label}</div>
      ))}
      <div className="legend-scale" title="NOAA geomagnetic storm scale">
        <span className="legend-scale-label">Storm</span>
        {STORM_LEVELS.map(l => (
          <span
            key={l.g}
            className={`legend-g ${current?.g === l.g ? 'current' : ''}`}
            style={{ background: l.color }}
            title={`G${l.g} ${l.name} (Kp ${l.kp})`}
          >
            G{l.g}
          </span>
        ))}
      </div>
    </div>
  );
}
