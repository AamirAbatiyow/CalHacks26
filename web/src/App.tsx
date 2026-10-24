import { useEffect, useState, useCallback, useMemo } from 'react';
import { Sidebar, type PageId } from './components/Sidebar';
import { KpiStrip } from './components/KpiStrip';
import { Globe } from './components/Globe';
import { isDegraded } from './utils/storm';
import { LayerPanel } from './components/LayerPanel';
import { PlaybackBar } from './components/PlaybackBar';
import { useSpacetimeDB } from './hooks/useSpacetimeDB';
import { useHashPage, useHashParam } from './hooks/useHashPage';
import { useKpi } from './hooks/useKpi';
import ClaimsPage from './pages/Claims';
import FinancePage, { type FinanceTabId } from './pages/Finance';
import PoliciesPage from './pages/Policies';
import BreakItPage from './pages/BreakIt';
import DecisionsPage from './pages/Decisions';
import SettingsPage from './pages/Settings';
import { DecisionReplayHost } from './replay/DecisionReplay';
import type { LayerState, PlaybackSpeed } from './types';
import './App.css';

function App() {
  const [activePage, setActivePage] = useHashPage();
  const hashParam = useHashParam();
  const financeTab: FinanceTabId = hashParam === 'ledger' || hashParam === 'audit' ? hashParam : 'summary';
  const [layers, setLayers] = useState<LayerState>({
    groundStations: true,
    satellitesAndRoutes: true,
    passTraffic: true,
    spaceWeather: true,
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
    setPlaybackPlaying,
    setPlaybackSpeedDb,
    seekToTime,
    goLive,
  } = useSpacetimeDB();
  const kpi = useKpi();

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

  const affectedPasses = useMemo(() => {
    if (!layers.spaceWeather || !currentWeather) return 0;
    const byId = new Map(stations.map(s => [s.id, s]));
    return passes.filter(p => p.startTime <= currentTime && p.endTime > currentTime
      && isDegraded(p, byId.get(p.stationId), currentWeather.kpIndex)).length;
  }, [passes, stations, currentTime, currentWeather, layers.spaceWeather]);

  const renderPage = (page: PageId) => {
    switch (page) {
      case 'claims':
        return <ClaimsPage stations={stations} satellites={satellites} passes={passes} spaceWeather={spaceWeather} />;
      case 'decisions':
        return <DecisionsPage />;
      case 'finance':
        return <FinancePage key={financeTab} initialTab={financeTab} />;
      case 'policies':
        return <PoliciesPage />;
      case 'breakit':
        return <BreakItPage />;
      case 'settings':
        return <SettingsPage />;
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
          <div className="page-content">
            {renderPage(activePage)}
            <DecisionReplayHost />
          </div>
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
            stations={stations}
            affectedPasses={affectedPasses}
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
          spaceWeather={spaceWeather}
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
