import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { inStormZone, stormLevel } from '../../utils/storm';
import {
  EARTH_RADIUS,
  MARKER_COLORS,
  createLink,
  createSatelliteMarker,
  createStationMarker,
  createStormZone,
  createTrail,
  elevationDeg,
  latLonToVector3,
  replaceChildren,
  satellitePosition,
} from '../../components/globeMarkers';
import { projectToScreen, useGlobeScene, type GlobeScene } from '../../components/useGlobeScene';
import { GlobeLegend } from '../../components/GlobeLegend';

/** Everything the claim globe needs about one pass. */
export interface ClaimFocus {
  satelliteName: string;
  tle1: string;
  tle2: string;
  stationName: string;
  stationLat: number;
  stationLon: number;
  stationAltM: number;
  stationRevenueCents: bigint;
  contactStart: bigint;
  /** When the downlink failed, or null if the pass has no recorded loss. */
  signalLost: bigint | null;
  contactEnd: bigint;
  kp: number;
}

const ARC_POINTS = 60;
const TRAIL_MS = 4 * 60_000;

function ptTime(ms: number): string {
  return new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit', timeZone: 'America/Los_Angeles' });
}

type Box = { x: number; y: number; w: number; h: number };

function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.w + 4 && b.x < a.x + a.w + 4 && a.y < b.y + b.h + 4 && b.y < a.y + a.h + 4;
}

/** Box of size w x h centered `gap` px from `from` along `dir`. */
function boxAlong(from: { x: number; y: number }, dir: { x: number; y: number }, gap: number, w: number, h: number): Box {
  const reach = gap + 0.5 * Math.abs(dir.x) * w + 0.5 * Math.abs(dir.y) * h;
  return { x: from.x + dir.x * reach - w / 2, y: from.y + dir.y * reach - h / 2, w, h };
}

function show(el: HTMLDivElement, box: Box | null) {
  if (!box) {
    el.style.opacity = '0';
    return;
  }
  el.style.opacity = '1';
  el.style.transform = `translate(${Math.round(box.x)}px, ${Math.round(box.y)}px)`;
}

/**
 * Station label on the side away from the satellite, satellite label beyond the
 * satellite, link label beside the link's midpoint; the link label flips sides or
 * stacks past the satellite label rather than overlap the others.
 */
function layoutLabels(scene: GlobeScene, at: Anchors, [stationEl, satEl, linkEl]: (HTMLDivElement | null)[]) {
  if (!stationEl || !satEl || !linkEl) return;
  const s = projectToScreen(scene, at.station);
  const t = at.satellite ? projectToScreen(scene, at.satellite) : null;
  let dir = { x: 0.7, y: -0.7 };
  if (t) {
    const len = Math.hypot(t.x - s.x, t.y - s.y);
    if (len > 1) dir = { x: (t.x - s.x) / len, y: (t.y - s.y) / len };
  }
  const stationBox = s.visible ? boxAlong(s, { x: -dir.x, y: -dir.y }, 14, stationEl.offsetWidth, stationEl.offsetHeight) : null;
  const satBox = t?.visible ? boxAlong(t, dir, 12, satEl.offsetWidth, satEl.offsetHeight) : null;
  show(stationEl, stationBox);
  show(satEl, satBox);

  const m = at.link ? projectToScreen(scene, at.link) : null;
  if (!m || !m.visible) {
    show(linkEl, null);
    return;
  }
  const w = linkEl.offsetWidth;
  const h = linkEl.offsetHeight;
  const placed = [stationBox, satBox].filter((b): b is Box => b !== null);
  const candidates = [
    boxAlong(m, { x: -dir.y, y: dir.x }, 10, w, h),
    boxAlong(m, { x: dir.y, y: -dir.x }, 10, w, h),
  ];
  if (satBox) candidates.push(boxAlong({ x: satBox.x + satBox.w / 2, y: satBox.y + satBox.h / 2 }, { x: 0, y: dir.y < 0 ? -1 : 1 }, satBox.h / 2 + 6, w, h));
  show(linkEl, candidates.find(c => !placed.some(p => overlaps(c, p))) ?? candidates[candidates.length - 1]);
}

interface Anchors {
  station: THREE.Vector3;
  satellite: THREE.Vector3 | null;
  link: THREE.Vector3 | null;
}

export function ClaimGlobe({ focus, currentTime }: { focus: ClaimFocus; currentTime: bigint }) {
  const anchors = useRef<Anchors>({ station: new THREE.Vector3(), satellite: null, link: null });
  const stationLabel = useRef<HTMLDivElement>(null);
  const satLabel = useRef<HTMLDivElement>(null);
  const linkLabel = useRef<HTMLDivElement>(null);

  const { containerRef, scene } = useGlobeScene(
    { focus: { lat: focus.stationLat, lon: focus.stationLon }, cameraDistance: 2.7 },
    s => layoutLabels(s, anchors.current, [stationLabel.current, satLabel.current, linkLabel.current]),
  );

  const layer = useRef<{ static: THREE.Group; moving: THREE.Group } | null>(null);
  useEffect(() => {
    if (!scene) return;
    const groups = { static: new THREE.Group(), moving: new THREE.Group() };
    scene.group.add(groups.static, groups.moving);
    layer.current = groups;
    return () => {
      replaceChildren(groups.static, []);
      replaceChildren(groups.moving, []);
      scene.group.remove(groups.static, groups.moving);
      layer.current = null;
    };
  }, [scene]);

  const level = stormLevel(focus.kp);
  const stationInZone = inStormZone(focus.stationLat, focus.stationLon, focus.kp);
  const lossColor = level?.color ?? MARKER_COLORS.dropped;
  const startMs = Number(focus.contactStart / 1000n);
  const endMs = Number(focus.contactEnd / 1000n);
  const lostMs = focus.signalLost !== null ? Number(focus.signalLost / 1000n) : null;
  const nowMs = Number(currentTime / 1000n);

  useEffect(() => {
    const groups = layer.current;
    if (!groups) return;
    const objects: THREE.Object3D[] = [createStormZone(focus.kp)];
    objects.push(createStationMarker(focus.stationLat, focus.stationLon, focus.stationRevenueCents, stationInZone ? level?.color : undefined));

    const healthy: THREE.Vector3[] = [];
    const lost: THREE.Vector3[] = [];
    for (let i = 0; i <= ARC_POINTS; i++) {
      const t = startMs + (i / ARC_POINTS) * (endMs - startMs);
      const p = satellitePosition(focus.tle1, focus.tle2, new Date(t));
      if (!p) continue;
      if (lostMs === null || t <= lostMs) healthy.push(p.pos);
      if (lostMs !== null && t >= lostMs) lost.push(p.pos);
    }
    const arc = (points: THREE.Vector3[], color: string, opacity: number) => points.length > 1 && objects.push(new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(points),
      new THREE.LineBasicMaterial({ color, transparent: true, opacity }),
    ));
    arc(healthy, '#ffffff', 0.35);
    arc(lost, lossColor, 0.8);

    if (lostMs !== null) {
      const p = satellitePosition(focus.tle1, focus.tle2, new Date(lostMs));
      if (p) {
        const ring = new THREE.Mesh(
          new THREE.RingGeometry(0.022, 0.03, 32),
          new THREE.MeshBasicMaterial({ color: lossColor, side: THREE.DoubleSide, transparent: true, opacity: 0.9 }),
        );
        ring.position.copy(p.pos);
        ring.lookAt(p.pos.clone().multiplyScalar(2));
        objects.push(ring);
      }
    }
    anchors.current.station = latLonToVector3(focus.stationLat, focus.stationLon, EARTH_RADIUS + 0.004);
    replaceChildren(groups.static, objects);
  }, [scene, focus, startMs, endMs, lostMs, level, lossColor, stationInZone]);

  const inContact = nowMs >= startMs && nowMs < endMs;
  const signalDown = lostMs !== null && nowMs >= lostMs;
  const elevation = useMemo(
    () => elevationDeg(focus.tle1, focus.tle2, focus.stationLat, focus.stationLon, focus.stationAltM, new Date(nowMs)),
    [focus, nowMs],
  );

  useEffect(() => {
    const groups = layer.current;
    if (!groups) return;
    const objects: THREE.Object3D[] = [];
    const now = satellitePosition(focus.tle1, focus.tle2, new Date(nowMs));
    anchors.current.satellite = now?.pos ?? null;
    anchors.current.link = null;
    if (now) {
      const trail: THREE.Vector3[] = [];
      for (let i = 12; i >= 0; i--) {
        const p = satellitePosition(focus.tle1, focus.tle2, new Date(nowMs - (i / 12) * TRAIL_MS));
        if (p) trail.push(p.pos);
      }
      if (trail.length > 2) objects.push(createTrail(trail, 0.9));
      objects.push(createSatelliteMarker(now.pos, 0.012));
      if (inContact) {
        const from = anchors.current.station;
        objects.push(createLink(from, now.pos, signalDown ? lossColor : MARKER_COLORS.link, signalDown ? 0.95 : 0.8));
        const mid = from.clone().add(now.pos).multiplyScalar(0.5);
        const radius = Math.max(mid.length(), EARTH_RADIUS + 0.04);
        anchors.current.link = mid.normalize().multiplyScalar(radius);
      }
    }
    replaceChildren(groups.moving, objects);
  }, [scene, focus, nowMs, inContact, signalDown, lossColor]);

  return (
    <div className="claim-globe-container">
      <div ref={containerRef} className="claim-globe" />
      <div className="globe-labels" aria-hidden>
        <div ref={stationLabel} className="globe-label station">
          <span>{focus.stationName}</span>
          <small>ground station{stationInZone && level ? ` · in G${level.g} zone` : ''}</small>
        </div>
        <div ref={satLabel} className="globe-label satellite">
          <span>{focus.satelliteName}</span>
          <small>satellite</small>
        </div>
        <div
          ref={linkLabel}
          className={`globe-label link ${signalDown ? 'lost' : ''}`}
          style={signalDown ? { color: lossColor, borderColor: lossColor } : undefined}
        >
          <span>{signalDown ? 'Signal lost' : 'Pass link'}{elevation !== null && ` · El ${elevation.toFixed(1)}°`}</span>
          <small>{ptTime(nowMs)} PT</small>
        </div>
      </div>
      {!inContact && (
        <div className="claim-globe-status">
          {nowMs < startMs ? `Contact starts ${ptTime(startMs)} PT` : `Contact ended ${ptTime(endMs)} PT`}
        </div>
      )}
      <GlobeLegend
        kp={focus.kp}
        extra={lostMs !== null ? [{ swatch: <span className="legend-swatch ring" style={{ borderColor: lossColor }} />, label: 'Signal lost' }] : []}
      />
    </div>
  );
}
