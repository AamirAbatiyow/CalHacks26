import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import type { Station, Satellite, Pass, SpaceWeather, LayerState } from '../types';
import { inStormZone, isDegraded, stormLevel } from '../utils/storm';
import {
  EARTH_RADIUS,
  MARKER_COLORS,
  createLink,
  createSatelliteMarker,
  createStationMarker,
  createStormZone,
  createTrail,
  latLonToVector3,
  replaceChildren,
  satellitePosition,
} from './globeMarkers';
import { useGlobeScene } from './useGlobeScene';
import { GlobeLegend } from './GlobeLegend';
import './Globe.css';

interface GlobeProps {
  stations: Station[];
  satellites: Satellite[];
  passes: Pass[];
  spaceWeather: SpaceWeather | null;
  currentTime: bigint;
  layers: LayerState;
}

const TRAIL_MINUTES = 8;
const TRAIL_POINTS = 16;

export function Globe({ stations, satellites, passes, spaceWeather, currentTime, layers }: GlobeProps) {
  const { containerRef, scene } = useGlobeScene({ autoRotate: true });
  const layerGroups = useRef<Record<'storm' | 'stations' | 'satellites' | 'links', THREE.Group> | null>(null);

  useEffect(() => {
    if (!scene) return;
    const groups = { storm: new THREE.Group(), stations: new THREE.Group(), satellites: new THREE.Group(), links: new THREE.Group() };
    scene.group.add(groups.storm, groups.links, groups.stations, groups.satellites);
    layerGroups.current = groups;
    return () => {
      for (const g of Object.values(groups)) {
        replaceChildren(g, []);
        scene.group.remove(g);
      }
      layerGroups.current = null;
    };
  }, [scene]);

  const kp = layers.spaceWeather && spaceWeather ? spaceWeather.kpIndex : 0;
  const level = stormLevel(kp);
  const stationsById = useMemo(() => new Map(stations.map(s => [s.id, s])), [stations]);
  const satellitesById = useMemo(() => new Map(satellites.map(s => [s.noradId, s])), [satellites]);

  useEffect(() => {
    const groups = layerGroups.current;
    if (!groups) return;
    replaceChildren(groups.storm, [createStormZone(kp)]);
  }, [scene, kp]);

  useEffect(() => {
    const groups = layerGroups.current;
    if (!groups) return;
    replaceChildren(groups.stations, layers.groundStations
      ? stations.map(s => createStationMarker(
          s.latitude, s.longitude, s.monthlyRevenueCents,
          level && inStormZone(s.latitude, s.longitude, kp) ? level.color : undefined,
        ))
      : []);
  }, [scene, stations, layers.groundStations, level, kp]);

  const nowMs = Number(currentTime / 1000n);

  useEffect(() => {
    const groups = layerGroups.current;
    if (!groups) return;
    const objects: THREE.Object3D[] = [];
    if (layers.satellitesAndRoutes) {
      for (const sat of satellites) {
        const now = satellitePosition(sat.tleLine1, sat.tleLine2, new Date(nowMs));
        if (!now) continue;
        const trail: THREE.Vector3[] = [];
        for (let i = TRAIL_POINTS; i >= 0; i--) {
          const p = satellitePosition(sat.tleLine1, sat.tleLine2, new Date(nowMs - (i / TRAIL_POINTS) * TRAIL_MINUTES * 60_000));
          if (p) trail.push(p.pos);
        }
        if (trail.length > 2) objects.push(createTrail(trail));
        objects.push(createSatelliteMarker(now.pos));
      }
    }
    replaceChildren(groups.satellites, objects);
  }, [scene, satellites, layers.satellitesAndRoutes, nowMs]);

  useEffect(() => {
    const groups = layerGroups.current;
    if (!groups) return;
    const objects: THREE.Object3D[] = [];
    if (layers.passTraffic) {
      for (const pass of passes) {
        if (pass.startTime > currentTime || pass.endTime <= currentTime) continue;
        const station = stationsById.get(pass.stationId);
        const sat = satellitesById.get(pass.satelliteId);
        if (!station || !sat) continue;
        const satNow = satellitePosition(sat.tleLine1, sat.tleLine2, new Date(nowMs));
        if (!satNow) continue;
        const from = latLonToVector3(station.latitude, station.longitude, EARTH_RADIUS + 0.004);
        const degraded = isDegraded(pass, station, kp);
        const color = degraded ? (level?.color ?? MARKER_COLORS.dropped) : MARKER_COLORS.link;
        objects.push(createLink(from, satNow.pos, color, degraded ? 0.95 : 0.55));
      }
    }
    replaceChildren(groups.links, objects);
  }, [scene, passes, stationsById, satellitesById, layers.passTraffic, currentTime, nowMs, kp, level]);

  return (
    <div className="globe-wrap">
      <div ref={containerRef} className="globe" />
      <GlobeLegend kp={kp} showLinks={layers.passTraffic} />
    </div>
  );
}
