import { useRef, useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { usePlayback } from './hooks/usePlayback';
import { useLayers } from './hooks/useLayers';
import {
  mockKPIs,
  mockStations,
  mockSatellites,
  mockPasses,
  getKpIndexAtTime,
  getActivePassesAtTime,
} from './data';
import { Sidebar, KPIStrip } from './components';
import { Globe } from './components/Globe';
import type { GlobeRef } from './components/Globe';
import { LayerPanel } from './components/LayerPanel';
import { PlaybackBar } from './components/PlaybackBar';
import {
  createGroundStationGroup,
  createSatelliteGroup,
  createPassTrafficGroup,
  createSpaceWeatherGroup,
} from './components/layers';
import type { TimelineEvent } from './types';
import './App.css';

const GLOBE_RADIUS = 1.0;

function App() {
  const { layers, toggleLayer } = useLayers();
  const playbackControls = usePlayback();
  const globeRef = useRef<GlobeRef>(null);
  const layerGroupsRef = useRef<{
    groundStations: THREE.Group | null;
    satellites: THREE.Group | null;
    passTraffic: THREE.Group | null;
    spaceWeather: THREE.Group | null;
  }>({
    groundStations: null,
    satellites: null,
    passTraffic: null,
    spaceWeather: null,
  });

  const currentTime = playbackControls.playback.currentTime;
  const kpIndex = getKpIndexAtTime(currentTime);
  const activePasses = getActivePassesAtTime(currentTime);

  // Generate timeline events from dropped passes
  const timelineEvents: TimelineEvent[] = useMemo(() => {
    return mockPasses
      .filter((pass) => pass.status === 'dropped')
      .map((pass) => ({
        time: pass.start,
        type: 'dispute' as const,
        description: `Dropped pass: ${pass.id}`,
      }));
  }, []);

  // Update layer groups when time or visibility changes
  useEffect(() => {
    const globe = globeRef.current;
    if (!globe) return;

    const earthGroup = globe.getEarthGroup();
    if (!earthGroup) return;

    // Remove old groups
    if (layerGroupsRef.current.groundStations) {
      earthGroup.remove(layerGroupsRef.current.groundStations);
      layerGroupsRef.current.groundStations = null;
    }
    if (layerGroupsRef.current.satellites) {
      earthGroup.remove(layerGroupsRef.current.satellites);
      layerGroupsRef.current.satellites = null;
    }
    if (layerGroupsRef.current.passTraffic) {
      earthGroup.remove(layerGroupsRef.current.passTraffic);
      layerGroupsRef.current.passTraffic = null;
    }
    if (layerGroupsRef.current.spaceWeather) {
      earthGroup.remove(layerGroupsRef.current.spaceWeather);
      layerGroupsRef.current.spaceWeather = null;
    }

    // Add new groups based on visibility
    if (layers.groundStations) {
      const group = createGroundStationGroup(mockStations, GLOBE_RADIUS);
      earthGroup.add(group);
      layerGroupsRef.current.groundStations = group;
    }

    if (layers.satellitesAndRoutes) {
      const group = createSatelliteGroup(mockSatellites, currentTime, GLOBE_RADIUS);
      earthGroup.add(group);
      layerGroupsRef.current.satellites = group;
    }

    if (layers.passTraffic) {
      const group = createPassTrafficGroup(
        activePasses,
        mockStations,
        mockSatellites,
        currentTime,
        GLOBE_RADIUS
      );
      earthGroup.add(group);
      layerGroupsRef.current.passTraffic = group;
    }

    if (layers.spaceWeather) {
      const group = createSpaceWeatherGroup(kpIndex, mockStations, GLOBE_RADIUS);
      earthGroup.add(group);
      layerGroupsRef.current.spaceWeather = group;
    }
  }, [layers, currentTime, kpIndex, activePasses]);

  return (
    <div className="app">
      <Sidebar activeItem="overview" />

      <div className="main">
        <header className="topbar">
          <h1 className="topbar-title">Ground Truth</h1>
          <KPIStrip kpis={mockKPIs} />
        </header>

        <div className="viewport">
          <LayerPanel layers={layers} onToggle={toggleLayer} />

          <Globe
            ref={globeRef}
            currentTime={currentTime}
            layers={layers}
          />

          {layers.spaceWeather && kpIndex >= 5 && (
            <div className="kp-storm-chip">
              Kp {kpIndex} storm
            </div>
          )}
        </div>

        <PlaybackBar
          playback={playbackControls.playback}
          progress={playbackControls.progress}
          timeRangeStart={playbackControls.timeRangeStart}
          timeRangeEnd={playbackControls.timeRangeEnd}
          onPlay={playbackControls.play}
          onPause={playbackControls.pause}
          onTogglePlay={playbackControls.togglePlay}
          onCycleSpeed={playbackControls.cycleSpeed}
          onSeekToProgress={playbackControls.seekToProgress}
          onStepForward={playbackControls.stepForward}
          onStepBackward={playbackControls.stepBackward}
          onGoLive={playbackControls.goLive}
          events={timelineEvents}
        />
      </div>
    </div>
  );
}

export default App;
