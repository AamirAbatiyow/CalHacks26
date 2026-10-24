import type { LayerVisibility } from '../types';
import './LayerPanel.css';

interface LayerPanelProps {
  layers: LayerVisibility;
  onToggle: (layer: keyof LayerVisibility) => void;
}

interface LayerToggleItemProps {
  label: string;
  checked: boolean;
  onChange: () => void;
}

function LayerToggleItem({ label, checked, onChange }: LayerToggleItemProps) {
  return (
    <label className="layer-panel-toggle">
      <input
        type="checkbox"
        checked={checked}
        onChange={onChange}
        className="layer-panel-checkbox"
      />
      <span className="layer-panel-switch" />
      <span className="layer-panel-label">{label}</span>
    </label>
  );
}

export function LayerPanel({ layers, onToggle }: LayerPanelProps) {
  return (
    <div className="layer-panel-container">
      <LayerToggleItem
        label="Ground stations"
        checked={layers.groundStations}
        onChange={() => onToggle('groundStations')}
      />
      <LayerToggleItem
        label="Satellites and routes"
        checked={layers.satellitesAndRoutes}
        onChange={() => onToggle('satellitesAndRoutes')}
      />
      <LayerToggleItem
        label="Pass traffic"
        checked={layers.passTraffic}
        onChange={() => onToggle('passTraffic')}
      />
      <LayerToggleItem
        label="Space weather"
        checked={layers.spaceWeather}
        onChange={() => onToggle('spaceWeather')}
      />
    </div>
  );
}

export default LayerPanel;
