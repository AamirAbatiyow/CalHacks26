import { useRef, useEffect, useMemo } from 'react';
import * as THREE from 'three';
import * as satellite from 'satellite.js';
import type { Station, Satellite, Pass, SpaceWeather, LayerState } from '../types';
import { PassStatus } from '../types';
import { GLOBE_ROTATION_PERIOD_MS, AURORAL_OVAL_BASE_LATITUDE, AURORAL_OVAL_KP_SCALE, COLORS } from '../config';
import { CONTINENT_PATHS } from '../data/continents';
import { latLonToVector3, createStationDot } from './globeMarkers';
import './Globe.css';

interface GlobeProps {
  stations: Station[];
  satellites: Satellite[];
  passes: Pass[];
  spaceWeather: SpaceWeather | null;
  currentTime: bigint;
  layers: LayerState;
}

const EARTH_RADIUS = 1;
const SATELLITE_ALTITUDE = 0.08;
/** Dropped passes are linked on the globe for the playback bar's 24-hour window. */
const PASS_LINK_WINDOW_MICROS = 24 * 60 * 60 * 1_000_000;

function getSatellitePosition(sat: Satellite, time: Date): THREE.Vector3 | null {
  try {
    const satrec = satellite.twoline2satrec(sat.tleLine1, sat.tleLine2);
    const positionAndVelocity = satellite.propagate(satrec, time);
    if (!positionAndVelocity || typeof positionAndVelocity.position === 'boolean' || !positionAndVelocity.position) {
      return null;
    }
    const gmst = satellite.gstime(time);
    const position = positionAndVelocity.position;
    const pos = satellite.eciToGeodetic(position, gmst);
    const lat = satellite.degreesLat(pos.latitude);
    const lon = satellite.degreesLong(pos.longitude);
    return latLonToVector3(lat, lon, EARTH_RADIUS + SATELLITE_ALTITUDE);
  } catch {
    return null;
  }
}

function createDottedEarth(): THREE.Points {
  const geometry = new THREE.BufferGeometry();
  const positions: number[] = [];
  
  const latCount = 90;
  const lonCount = 180;
  
  for (let latIdx = 0; latIdx < latCount; latIdx++) {
    const lat = (latIdx / (latCount - 1)) * 180 - 90;
    const circumference = Math.cos(lat * Math.PI / 180);
    const pointsAtLat = Math.max(1, Math.floor(lonCount * circumference));
    
    for (let lonIdx = 0; lonIdx < pointsAtLat; lonIdx++) {
      const lon = (lonIdx / pointsAtLat) * 360 - 180;
      const pos = latLonToVector3(lat, lon, EARTH_RADIUS);
      positions.push(pos.x, pos.y, pos.z);
    }
  }
  
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  
  const material = new THREE.PointsMaterial({
    color: 0x333333,
    size: 0.008,
    sizeAttenuation: true,
  });
  
  return new THREE.Points(geometry, material);
}

function createContinentOutlines(): THREE.Group {
  const group = new THREE.Group();
  
  for (const continent of CONTINENT_PATHS) {
    const points: THREE.Vector3[] = [];
    for (const [lon, lat] of continent) {
      points.push(latLonToVector3(lat, lon, EARTH_RADIUS + 0.001));
    }
    
    if (points.length > 1) {
      const geometry = new THREE.BufferGeometry().setFromPoints(points);
      const material = new THREE.LineBasicMaterial({
        color: 0x666666,
        transparent: true,
        opacity: 0.8,
      });
      const line = new THREE.Line(geometry, material);
      group.add(line);
    }
  }
  
  return group;
}

function createAuroralOval(kpIndex: number): THREE.Group {
  const group = new THREE.Group();
  const baseLatitude = AURORAL_OVAL_BASE_LATITUDE - kpIndex * AURORAL_OVAL_KP_SCALE;
  
  const createOvalRing = (lat: number) => {
    const points: THREE.Vector3[] = [];
    for (let lon = 0; lon <= 360; lon += 3) {
      points.push(latLonToVector3(lat, lon - 180, EARTH_RADIUS + 0.005));
    }
    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    const material = new THREE.LineBasicMaterial({
      color: COLORS.amber,
      transparent: true,
      opacity: 0.7,
    });
    return new THREE.Line(geometry, material);
  };

  group.add(createOvalRing(baseLatitude));
  group.add(createOvalRing(-baseLatitude));
  
  return group;
}

export function Globe({ stations, satellites, passes, spaceWeather, currentTime, layers }: GlobeProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const groupRef = useRef<THREE.Group | null>(null);
  const frameRef = useRef<number>(0);
  const isDraggingRef = useRef(false);
  const previousMouseRef = useRef({ x: 0, y: 0 });
  const rotationVelocityRef = useRef({ x: 0, y: 0 });

  const prefersReducedMotion = useMemo(() => {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }, []);

  useEffect(() => {
    if (!containerRef.current) return;

    const scene = new THREE.Scene();
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(
      45,
      containerRef.current.clientWidth / containerRef.current.clientHeight,
      0.1,
      100
    );
    camera.position.z = 3.2;
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(containerRef.current.clientWidth, containerRef.current.clientHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0x000000, 0);
    containerRef.current.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    const group = new THREE.Group();
    group.rotation.x = 0.1;
    scene.add(group);
    groupRef.current = group;

    const earth = createDottedEarth();
    earth.userData.permanent = true;
    group.add(earth);

    const continents = createContinentOutlines();
    continents.userData.permanent = true;
    group.add(continents);

    const animate = () => {
      frameRef.current = requestAnimationFrame(animate);

      if (!isDraggingRef.current && !prefersReducedMotion) {
        group.rotation.y += (2 * Math.PI) / (GLOBE_ROTATION_PERIOD_MS / 16.67);
        
        group.rotation.x += rotationVelocityRef.current.x;
        group.rotation.y += rotationVelocityRef.current.y;
        rotationVelocityRef.current.x *= 0.95;
        rotationVelocityRef.current.y *= 0.95;
      }

      renderer.render(scene, camera);
    };
    animate();

    const handleResize = () => {
      if (!containerRef.current || !camera || !renderer) return;
      camera.aspect = containerRef.current.clientWidth / containerRef.current.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(containerRef.current.clientWidth, containerRef.current.clientHeight);
    };
    window.addEventListener('resize', handleResize);

    const handleMouseDown = (e: MouseEvent) => {
      isDraggingRef.current = true;
      previousMouseRef.current = { x: e.clientX, y: e.clientY };
    };

    const handleMouseMove = (e: MouseEvent) => {
      if (!isDraggingRef.current || !groupRef.current) return;
      const deltaX = e.clientX - previousMouseRef.current.x;
      const deltaY = e.clientY - previousMouseRef.current.y;
      groupRef.current.rotation.y += deltaX * 0.005;
      groupRef.current.rotation.x += deltaY * 0.005;
      groupRef.current.rotation.x = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, groupRef.current.rotation.x));
      rotationVelocityRef.current = { x: deltaY * 0.001, y: deltaX * 0.001 };
      previousMouseRef.current = { x: e.clientX, y: e.clientY };
    };

    const handleMouseUp = () => {
      isDraggingRef.current = false;
    };

    renderer.domElement.addEventListener('mousedown', handleMouseDown);
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);

    return () => {
      cancelAnimationFrame(frameRef.current);
      window.removeEventListener('resize', handleResize);
      renderer.domElement.removeEventListener('mousedown', handleMouseDown);
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [prefersReducedMotion]);

  useEffect(() => {
    if (!groupRef.current) return;
    const group = groupRef.current;

    const toRemove: THREE.Object3D[] = [];
    group.traverse((child) => {
      if (child.userData.layerType && !child.userData.permanent) {
        toRemove.push(child);
      }
    });
    toRemove.forEach((obj) => {
      group.remove(obj);
      if (obj instanceof THREE.Mesh || obj instanceof THREE.Points || obj instanceof THREE.Line) {
        obj.geometry.dispose();
        if (Array.isArray(obj.material)) {
          obj.material.forEach(m => m.dispose());
        } else {
          obj.material.dispose();
        }
      }
    });

    const currentDate = new Date(Number(currentTime) / 1000);

    if (layers.groundStations && stations.length > 0) {
      stations.forEach((station) => {
        const mesh = createStationDot(station.latitude, station.longitude, station.monthlyRevenueCents);
        mesh.userData.layerType = 'station';
        group.add(mesh);
      });
    }

    if (layers.satellitesAndRoutes && satellites.length > 0) {
      satellites.forEach((sat) => {
        const pos = getSatellitePosition(sat, currentDate);
        if (pos) {
          const geometry = new THREE.BoxGeometry(0.012, 0.012, 0.012);
          const material = new THREE.MeshBasicMaterial({ color: 0x888888 });
          const mesh = new THREE.Mesh(geometry, material);
          mesh.position.copy(pos);
          mesh.userData.layerType = 'satellite';
          group.add(mesh);

          const orbitPoints: THREE.Vector3[] = [];
          for (let i = 0; i <= 360; i += 4) {
            const futureTime = new Date(currentDate.getTime() + (i / 360) * 95 * 60 * 1000);
            const futurePos = getSatellitePosition(sat, futureTime);
            if (futurePos) orbitPoints.push(futurePos);
          }
          if (orbitPoints.length > 10) {
            const orbitGeometry = new THREE.BufferGeometry().setFromPoints(orbitPoints);
            const orbitMaterial = new THREE.LineBasicMaterial({
              color: 0x444444,
              transparent: true,
              opacity: 0.25,
            });
            const orbit = new THREE.Line(orbitGeometry, orbitMaterial);
            orbit.userData.layerType = 'orbit';
            group.add(orbit);
          }
        }
      });
    }

    if (layers.passTraffic && passes.length > 0) {
      const linkWindowStart = currentTime - BigInt(PASS_LINK_WINDOW_MICROS);
      passes.forEach((pass) => {
        if (pass.status !== PassStatus.Active && pass.status !== PassStatus.Dropped) return;
        if (pass.status === PassStatus.Dropped && (pass.startTime < linkWindowStart || pass.startTime > currentTime)) return;
        
        const station = stations.find(s => s.id === pass.stationId);
        const sat = satellites.find(s => s.noradId === pass.satelliteId);
        if (!station || !sat) return;

        const stationPos = latLonToVector3(station.latitude, station.longitude, EARTH_RADIUS + 0.005);
        const satPos = getSatellitePosition(sat, currentDate);
        if (!satPos) return;

        const midPoint = new THREE.Vector3().addVectors(stationPos, satPos).multiplyScalar(0.5);
        midPoint.normalize().multiplyScalar(EARTH_RADIUS + 0.15);

        const curve = new THREE.QuadraticBezierCurve3(stationPos, midPoint, satPos);
        const curvePoints = curve.getPoints(20);
        const geometry = new THREE.BufferGeometry().setFromPoints(curvePoints);
        
        const isDropped = pass.status === PassStatus.Dropped;
        const material = new THREE.LineBasicMaterial({
          color: isDropped ? parseInt(COLORS.amber.replace('#', ''), 16) : 0xffffff,
          transparent: true,
          opacity: isDropped ? 0.9 : 0.6,
        });
        const line = new THREE.Line(geometry, material);
        line.userData.layerType = 'passLink';
        group.add(line);
      });
    }

    if (layers.spaceWeather && spaceWeather && spaceWeather.kpIndex >= 4) {
      const auroral = createAuroralOval(spaceWeather.kpIndex);
      auroral.traverse((child) => {
        child.userData.layerType = 'auroral';
      });
      group.add(auroral);

      if (layers.groundStations) {
        const affectedLatitude = Math.abs(AURORAL_OVAL_BASE_LATITUDE - spaceWeather.kpIndex * AURORAL_OVAL_KP_SCALE);
        stations.forEach((station) => {
          if (Math.abs(station.latitude) > affectedLatitude - 8) {
            const pos = latLonToVector3(station.latitude, station.longitude, EARTH_RADIUS);
            const ringGeometry = new THREE.RingGeometry(0.03, 0.045, 16);
            const ringMaterial = new THREE.MeshBasicMaterial({
              color: parseInt(COLORS.amber.replace('#', ''), 16),
              transparent: true,
              opacity: 0.6,
              side: THREE.DoubleSide,
            });
            const ring = new THREE.Mesh(ringGeometry, ringMaterial);
            ring.position.copy(pos);
            ring.lookAt(0, 0, 0);
            ring.userData.layerType = 'stormHighlight';
            group.add(ring);
          }
        });
      }
    }
  }, [stations, satellites, passes, spaceWeather, currentTime, layers]);

  return <div ref={containerRef} className="globe" />;
}
