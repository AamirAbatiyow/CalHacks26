import { usePlayback } from './hooks/usePlayback';
import { useLayers } from './hooks/useLayers';
import { mockKPIs } from './data';
import './App.css';

// Components will be added by parallel agents
// Lane A: Sidebar, KPIStrip
// Lane B: Globe
// Lane C: LayerPanel, layer overlays
// Lane D: PlaybackBar

function App() {
  const { layers, toggleLayer } = useLayers();
  const playbackControls = usePlayback();

  return (
    <div className="app">
      {/* Sidebar - Lane A */}
      <aside className="sidebar">
        <div className="sidebar-logo">⬡</div>
        <nav className="sidebar-nav">
          <NavItem icon="◉" label="Overview" active />
          <NavItem icon="◎" label="Disputes" />
          <NavItem icon="☐" label="Approvals" />
          <NavItem icon="◇" label="Customers" />
          <NavItem icon="◆" label="Finance" />
          <NavItem icon="▤" label="Ledger" />
          <NavItem icon="▣" label="Audit" />
          <NavItem icon="◈" label="Policies" />
          <NavItem icon="⊕" label="Break It" />
        </nav>
      </aside>

      {/* Main content area */}
      <div className="main">
        {/* Top bar with KPIs - Lane A */}
        <header className="topbar">
          <h1 className="topbar-title">Ground Truth</h1>
          <div className="kpi-strip">
            <KPICard label="Billed this month" value={mockKPIs.billedThisMonth} />
            <KPICard label="Revenue at risk" value={mockKPIs.revenueAtRisk} highlight />
            <KPICard label="Credits paid" value={mockKPIs.creditsPaid} />
            <KPICard label="Recovered" value={mockKPIs.recovered} />
          </div>
        </header>

        {/* Globe viewport - Lane B */}
        <div className="viewport">
          {/* Layer panel - Lane C */}
          <div className="layer-panel">
            <LayerToggle 
              label="Ground stations" 
              checked={layers.groundStations}
              onChange={() => toggleLayer('groundStations')}
            />
            <LayerToggle 
              label="Satellites and routes" 
              checked={layers.satellitesAndRoutes}
              onChange={() => toggleLayer('satellitesAndRoutes')}
            />
            <LayerToggle 
              label="Pass traffic" 
              checked={layers.passTraffic}
              onChange={() => toggleLayer('passTraffic')}
            />
            <LayerToggle 
              label="Space weather" 
              checked={layers.spaceWeather}
              onChange={() => toggleLayer('spaceWeather')}
            />
          </div>

          {/* Globe placeholder */}
          <div className="globe-placeholder">
            <span className="globe-placeholder-text">Globe renderer loading...</span>
          </div>
        </div>

        {/* Playback bar - Lane D */}
        <footer className="playback-bar">
          <div className="playback-controls">
            <button className="playback-btn" onClick={playbackControls.stepBackward}>⏮</button>
            <button className="playback-btn" onClick={playbackControls.togglePlay}>
              {playbackControls.playback.isPlaying ? '⏸' : '▶'}
            </button>
            <button className="playback-btn" onClick={playbackControls.stepForward}>⏭</button>
            <button className="playback-btn speed-btn" onClick={playbackControls.cycleSpeed}>
              {playbackControls.playback.speed}x
            </button>
          </div>
          
          <div className="playback-timeline">
            <div className="timeline-track">
              <div 
                className="timeline-progress"
                style={{ width: `${playbackControls.progress * 100}%` }}
              />
              <input
                type="range"
                min="0"
                max="1"
                step="0.001"
                value={playbackControls.progress}
                onChange={(e) => playbackControls.seekToProgress(parseFloat(e.target.value))}
                className="timeline-scrubber"
              />
            </div>
            <span className="timeline-label">last 24 hours</span>
          </div>

          <div className="playback-time">
            <span className="time-display">
              {playbackControls.playback.currentTime.toLocaleString('en-US', {
                month: 'short',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
                hour12: false,
                timeZone: 'America/Los_Angeles',
              })} PT
            </span>
            <button 
              className={`live-btn ${playbackControls.playback.isLive ? 'active' : ''}`}
              onClick={playbackControls.goLive}
            >
              Live
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

// Temporary inline components - will be extracted by agents
function NavItem({ icon, label, active = false }: { icon: string; label: string; active?: boolean }) {
  return (
    <button className={`nav-item ${active ? 'active' : ''}`} title={label}>
      <span className="nav-icon">{icon}</span>
      <span className="nav-label">{label}</span>
    </button>
  );
}

function KPICard({ label, value, highlight = false }: { label: string; value: number; highlight?: boolean }) {
  const formatted = value >= 1_000_000 
    ? `$${(value / 1_000_000).toFixed(1)}M`
    : `$${(value / 1_000).toFixed(0)}K`;
    
  return (
    <div className={`kpi-card ${highlight ? 'highlight' : ''}`}>
      <span className="kpi-label">{label}</span>
      <span className="kpi-value">{formatted}</span>
    </div>
  );
}

function LayerToggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: () => void }) {
  return (
    <label className="layer-toggle">
      <input 
        type="checkbox" 
        checked={checked} 
        onChange={onChange}
        className="layer-checkbox"
      />
      <span className="layer-switch" />
      <span className="layer-label">{label}</span>
    </label>
  );
}

export default App;
