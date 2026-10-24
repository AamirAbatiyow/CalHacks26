import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { projectToScreen, useGlobeScene, type GlobeScene } from './useGlobeScene';
import { GlobeInfoCard, type GlobeSelection } from './GlobeInfoCard';
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
const PICK_RADIUS_PX = 12;
const HIGHLIGHT_SCALE = 1.7;

type Pickable = { key: string; selection: GlobeSelection; obj: THREE.Object3D };

function selectionKey(s: GlobeSelection | null): string | null {
  return s ? `${s.kind}:${s.id}` : null;
}

export function Globe({ stations, satellites, passes, spaceWeather, currentTime, layers }: GlobeProps) {
  const [selected, setSelected] = useState<GlobeSelection | null>(null);
  const pickables = useRef<Map<string, Pickable>>(new Map());
  const hoveredKey = useRef<string | null>(null);
  const selectedKey = useRef<string | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  const positionCard = (s: GlobeScene) => {
    const card = cardRef.current;
    const target = selectedKey.current ? pickables.current.get(selectedKey.current) : undefined;
    if (!card) return;
    const p = target ? projectToScreen(s, target.obj.position) : null;
    if (!p || !p.visible) {
      card.style.visibility = 'hidden';
      return;
    }
    const canvas = s.renderer.domElement;
    const x = Math.min(p.x, canvas.clientWidth - card.offsetWidth - 28);
    const y = Math.min(p.y, canvas.clientHeight - card.offsetHeight - 28);
    card.style.visibility = 'visible';
    card.style.transform = `translate(${Math.max(0, x)}px, ${Math.max(0, y)}px)`;
  };

  // Spin until something is selected, so the card stays next to its marker.
  const { containerRef, scene } = useGlobeScene({ autoRotate: selected === null }, positionCard);
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

  const applyHighlight = useCallback((p: Pickable) => {
    const on = p.key === hoveredKey.current || p.key === selectedKey.current;
    p.obj.scale.setScalar(on ? HIGHLIGHT_SCALE : 1);
  }, []);

  const register = useCallback((selection: GlobeSelection, obj: THREE.Object3D) => {
    const key = selectionKey(selection)!;
    const p = { key, selection, obj };
    pickables.current.set(key, p);
    applyHighlight(p);
  }, [applyHighlight]);

  const pick = useCallback((clientX: number, clientY: number): Pickable | null => {
    if (!scene) return null;
    const rect = scene.renderer.domElement.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    let best: Pickable | null = null;
    let bestDist = PICK_RADIUS_PX;
    for (const p of pickables.current.values()) {
      const s = projectToScreen(scene, p.obj.position);
      if (!s.visible) continue;
      // Satellites sit above stations on screen; prefer them on a tie.
      const d = Math.hypot(s.x - x, s.y - y) - (p.selection.kind === 'satellite' ? 2 : 0);
      if (d < bestDist) { best = p; bestDist = d; }
    }
    return best;
  }, [scene]);

  const select = useCallback((next: GlobeSelection | null) => {
    const prev = selectedKey.current ? pickables.current.get(selectedKey.current) : undefined;
    selectedKey.current = selectionKey(next);
    if (prev) applyHighlight(prev);
    const now = selectedKey.current ? pickables.current.get(selectedKey.current) : undefined;
    if (now) applyHighlight(now);
    setSelected(next);
  }, [applyHighlight]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || !scene) return;
    let down: { x: number; y: number } | null = null;
    const setHover = (p: Pickable | null) => {
      const prev = hoveredKey.current ? pickables.current.get(hoveredKey.current) : undefined;
      hoveredKey.current = p?.key ?? null;
      if (prev) applyHighlight(prev);
      if (p) applyHighlight(p);
      el.style.cursor = p ? 'pointer' : '';
    };
    const onMove = (e: MouseEvent) => {
      if (e.buttons) return;
      const p = pick(e.clientX, e.clientY);
      if ((p?.key ?? null) !== hoveredKey.current) setHover(p);
    };
    const onDown = (e: MouseEvent) => { down = { x: e.clientX, y: e.clientY }; };
    const onUp = (e: MouseEvent) => {
      if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) { down = null; return; }
      down = null;
      select(pick(e.clientX, e.clientY)?.selection ?? null);
    };
    const onLeave = () => setHover(null);
    el.addEventListener('mousemove', onMove);
    el.addEventListener('mousedown', onDown);
    el.addEventListener('mouseup', onUp);
    el.addEventListener('mouseleave', onLeave);
    return () => {
      el.removeEventListener('mousemove', onMove);
      el.removeEventListener('mousedown', onDown);
      el.removeEventListener('mouseup', onUp);
      el.removeEventListener('mouseleave', onLeave);
    };
  }, [scene, containerRef, pick, select, applyHighlight]);

  useEffect(() => {
    if (!selected) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') select(null); };
    const onDocDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (cardRef.current?.contains(target) || containerRef.current?.contains(target)) return;
      select(null);
    };
    window.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDocDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDocDown);
    };
  }, [selected, select, containerRef]);

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
    const markers = layers.groundStations
      ? stations.map(s => {
          const obj = createStationMarker(
            s.latitude, s.longitude, s.monthlyRevenueCents,
            level && inStormZone(s.latitude, s.longitude, kp) ? level.color : undefined,
          );
          register({ kind: 'station', id: s.id }, obj);
          return obj;
        })
      : [];
    for (const [key, p] of pickables.current) if (p.selection.kind === 'station' && !(markers as THREE.Object3D[]).includes(p.obj)) pickables.current.delete(key);
    replaceChildren(groups.stations, markers);
  }, [scene, stations, layers.groundStations, level, kp, register]);

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
        const marker = createSatelliteMarker(now.pos);
        register({ kind: 'satellite', id: sat.noradId }, marker);
        objects.push(marker);
      }
    }
    for (const [key, p] of pickables.current) if (p.selection.kind === 'satellite' && !objects.includes(p.obj)) pickables.current.delete(key);
    replaceChildren(groups.satellites, objects);
  }, [scene, satellites, layers.satellitesAndRoutes, nowMs, register]);

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
      {selected && (
        <GlobeInfoCard
          ref={cardRef}
          selection={selected}
          stations={stations}
          satellites={satellites}
          passes={passes}
          kp={kp}
          currentTime={currentTime}
          onClose={() => select(null)}
        />
      )}
    </div>
  );
}
