import { useEffect, useState, useCallback } from 'react';
import { Sidebar, type PageId } from './components/Sidebar';
import { KpiStrip } from './components/KpiStrip';
import { Globe } from './components/Globe';
import { LayerPanel } from './components/LayerPanel';
import { PlaybackBar } from './components/PlaybackBar';
import { useSpacetimeDB } from './hooks/useSpacetimeDB';
import { useHashPage } from './hooks/useHashPage';
import ClaimPage from './pages/Claim';
import FinancePage from './pages/Finance';
import type { LayerState, PlaybackSpeed } from './types';
import './App.css';

function App() {
  const [activePage, setActivePage] = useHashPage();
  const [layers, setLayers] = useState<LayerState>({
    groundStations: true,
    satellitesAndRoutes: true,
    passTraffic: false,
    spaceWeather: false,
  });

  const [playbackSpeed, setPlaybackSpeed] = useState<PlaybackSpeed>(1);
  const [isPlaying, setIsPlaying] = useState(true);
  const [currentTime, setCurrentTime] = useState<bigint>(BigInt(Date.now() * 1000));
  const [isLive, setIsLive] = useState(true);
  
  const {
    connectionState,
    stations,
    satellites,
    passes,
    spaceWeather,
    simClock,
    kpi,
    setPlaybackPlaying,
    setPlaybackSpeedDb,
    seekToTime,
    goLive,
  } = useSpacetimeDB();

  useEffect(() => {
    if (simClock) {
      setCurrentTime(simClock.currentTime);
      setIsPlaying(simClock.isPlaying);
      setPlaybackSpeed(Math.round(simClock.speedMultiplier) as PlaybackSpeed);
      const timeDiff = Math.abs(Number(simClock.currentTime - BigInt(Date.now() * 1000)));
      setIsLive(timeDiff < 5000000);
    }
  }, [simClock]);

  const toggleLayer = useCallback((layer: keyof LayerState) => {
    setLayers(prev => ({ ...prev, [layer]: !prev[layer] }));
  }, []);

  const handlePlayPause = useCallback(() => {
    setPlaybackPlaying(!isPlaying);
  }, [isPlaying, setPlaybackPlaying]);

  const handleSpeedChange = useCallback((speed: PlaybackSpeed) => {
    setPlaybackSpeedDb(speed);
  }, [setPlaybackSpeedDb]);

  const handleSeek = useCallback((timestamp: bigint) => {
    seekToTime(timestamp);
    setIsLive(false);
  }, [seekToTime]);

  const handleGoLive = useCallback(() => {
    goLive();
  }, [goLive]);

  const twentyFourHoursAgo = BigInt(Date.now() * 1000) - BigInt(24 * 60 * 60 * 1000000);
  const now = BigInt(Date.now() * 1000);

  const currentWeather = spaceWeather.length > 0
    ? spaceWeather.reduce((closest, w) => {
        const closestDiff = Math.abs(Number(closest.timestamp - currentTime));
        const wDiff = Math.abs(Number(w.timestamp - currentTime));
        return wDiff < closestDiff ? w : closest;
      }, spaceWeather[0])
    : null;

  const renderPage = (page: PageId) => {
    switch (page) {
      case 'claims':
        return <ClaimPage />;
      case 'finance':
        return <FinancePage key="summary" initialTab="summary" />;
      case 'ledger':
        return <FinancePage key="ledger" initialTab="ledger" />;
      case 'audit':
        return <FinancePage key="audit" initialTab="audit" />;
      default:
        return null;
    }
  };

  return (
    <div className="app">
      <Sidebar activePage={activePage} onNavigate={setActivePage} />
      <main className="main">
        <KpiStrip kpi={kpi} connectionState={connectionState} />
        {activePage !== 'overview' ? (
          <div className="page-content">{renderPage(activePage)}</div>
        ) : (<>
        <div className="globe-container">
          <Globe
            stations={stations}
            satellites={satellites}
            passes={passes}
            spaceWeather={currentWeather}
            currentTime={currentTime}
            layers={layers}
          />
          <LayerPanel
            layers={layers}
            onToggle={toggleLayer}
            kpIndex={currentWeather?.kpIndex ?? 0}
          />
        </div>
        <PlaybackBar
          currentTime={currentTime}
          startTime={twentyFourHoursAgo}
          endTime={now}
          isPlaying={isPlaying}
          speed={playbackSpeed}
          isLive={isLive}
          passes={passes}
          onPlayPause={handlePlayPause}
          onSpeedChange={handleSpeedChange}
          onSeek={handleSeek}
          onGoLive={handleGoLive}
        />
        </>)}
      </main>
    </div>
  );
}

export default App;
