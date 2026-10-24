import type { LayerState, Station } from '../types';
import { auroralOval, inStormZone, stormLevel } from '../utils/storm';
import './LayerPanel.css';

interface LayerPanelProps {
  layers: LayerState;
  onToggle: (layer: keyof LayerState) => void;
  kpIndex: number;
  stations: Station[];
  affectedPasses: number;
}

interface LayerToggleProps {
  label: string;
  enabled: boolean;
  onToggle: () => void;
  badge?: { text: string; color: string };
}

function LayerToggle({ label, enabled, onToggle, badge }: LayerToggleProps) {
  return (
    <button
      className={`layer-toggle ${enabled ? 'enabled' : ''}`}
      onClick={onToggle}
      role="switch"
      aria-checked={enabled}
    >
      <span className="toggle-track">
        <span className="toggle-thumb" />
      </span>
      <span className="toggle-label">{label}</span>
      {badge && (
        <span className="toggle-badge" style={{ color: badge.color, background: `${badge.color}26`, borderColor: `${badge.color}80` }}>
          {badge.text}
        </span>
      )}
    </button>
  );
}

export function LayerPanel({ layers, onToggle, kpIndex, stations, affectedPasses }: LayerPanelProps) {
  const level = stormLevel(kpIndex);
  const affectedStations = level ? stations.filter(s => inStormZone(s.latitude, s.longitude, kpIndex)).length : 0;
  return (
    <div className="layer-panel">
      <LayerToggle
        label="Ground stations"
        enabled={layers.groundStations}
        onToggle={() => onToggle('groundStations')}
      />
      <LayerToggle
        label="Satellites and trails"
        enabled={layers.satellitesAndRoutes}
        onToggle={() => onToggle('satellitesAndRoutes')}
      />
      <LayerToggle
        label="Pass traffic"
        enabled={layers.passTraffic}
        onToggle={() => onToggle('passTraffic')}
      />
      <LayerToggle
        label="Space weather"
        enabled={layers.spaceWeather}
        onToggle={() => onToggle('spaceWeather')}
        badge={level ? { text: `G${level.g} ${level.name} · Kp ${kpIndex.toFixed(1)}`, color: level.color } : undefined}
      />
      {layers.spaceWeather && (
        <div className="layer-storm-info">
          {level ? (
            <>
              <span style={{ color: level.color }}>Affected zone</span> poleward of {auroralOval(kpIndex).equatorward.toFixed(0)}° geomagnetic
              <br />
              {affectedStations} station{affectedStations === 1 ? '' : 's'} inside
              {layers.passTraffic && <> · {affectedPasses} affected pass{affectedPasses === 1 ? '' : 'es'} now</>}
            </>
          ) : (
            <>Quiet · Kp {kpIndex.toFixed(1)}, no storm zone</>
          )}
        </div>
      )}
    </div>
  );
}
