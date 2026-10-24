import type { LayerState } from '../types';
import './LayerPanel.css';

interface LayerPanelProps {
  layers: LayerState;
  onToggle: (layer: keyof LayerState) => void;
  kpIndex: number;
}

interface LayerToggleProps {
  label: string;
  enabled: boolean;
  onToggle: () => void;
  badge?: string;
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
      {badge && <span className="toggle-badge">{badge}</span>}
    </button>
  );
}

export function LayerPanel({ layers, onToggle, kpIndex }: LayerPanelProps) {
  return (
    <div className="layer-panel">
      <LayerToggle
        label="Ground stations"
        enabled={layers.groundStations}
        onToggle={() => onToggle('groundStations')}
      />
      <LayerToggle
        label="Satellites and routes"
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
        badge={kpIndex >= 5 ? `Kp ${kpIndex.toFixed(0)} storm` : undefined}
      />
    </div>
  );
}
