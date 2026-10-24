import { useRef, useEffect, useMemo } from 'react';
import * as THREE from 'three';
import * as satellite from 'satellite.js';
import type { Station, Satellite, Pass, SpaceWeather, LayerState } from '../types';
import { PassStatus } from '../types';
import { GLOBE_ROTATION_PERIOD_MS, AURORAL_OVAL_BASE_LATITUDE, AURORAL_OVAL_KP_SCALE, COLORS } from '../config';
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
const SATELLITE_ALTITUDE = 0.1;

function latLonToVector3(lat: number, lon: number, radius: number): THREE.Vector3 {
  const phi = (90 - lat) * (Math.PI / 180);
  const theta = (lon + 180) * (Math.PI / 180);
  return new THREE.Vector3(
    -radius * Math.sin(phi) * Math.cos(theta),
    radius * Math.cos(phi),
    radius * Math.sin(phi) * Math.sin(theta)
  );
}

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
  
  const latCount = 80;
  const lonCount = 160;
  
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
    color: 0x444444,
    size: 0.012,
    sizeAttenuation: true,
  });
  
  return new THREE.Points(geometry, material);
}

function createAuroralOval(kpIndex: number): THREE.Line {
  const baseLatitude = AURORAL_OVAL_BASE_LATITUDE - kpIndex * AURORAL_OVAL_KP_SCALE;
  const points: THREE.Vector3[] = [];
  
  for (let lon = 0; lon <= 360; lon += 5) {
    points.push(latLonToVector3(baseLatitude, lon - 180, EARTH_RADIUS + 0.01));
  }
  
  const geometry = new THREE.BufferGeometry().setFromPoints(points);
  const material = new THREE.LineBasicMaterial({
    color: COLORS.amber,
    transparent: true,
    opacity: 0.6,
  });
  
  return new THREE.Line(geometry, material);
}

export function Globe({ stations, satellites, passes, spaceWeather, currentTime, layers }: GlobeProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const earthRef = useRef<THREE.Points | null>(null);
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
    camera.position.z = 3.5;
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(containerRef.current.clientWidth, containerRef.current.clientHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0x000000, 0);
    containerRef.current.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    const group = new THREE.Group();
    scene.add(group);
    groupRef.current = group;

    const earth = createDottedEarth();
    group.add(earth);
    earthRef.current = earth;

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
      if (containerRef.current && renderer.domElement.parentNode === containerRef.current) {
        containerRef.current.removeChild(renderer.domElement);
      }
    };
  }, [prefersReducedMotion]);

  useEffect(() => {
    if (!groupRef.current) return;
    const group = groupRef.current;

    const toRemove: THREE.Object3D[] = [];
    group.traverse((child) => {
      if (child.userData.layerType) {
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

    if (layers.groundStations) {
      stations.forEach((station) => {
        const pos = latLonToVector3(station.latitude, station.longitude, EARTH_RADIUS);
        const size = Math.max(0.02, Math.min(0.06, Number(station.monthlyRevenueCents) / 5000000000));
        const geometry = new THREE.BoxGeometry(size, size, size);
        const material = new THREE.MeshBasicMaterial({ color: 0xffffff });
        const mesh = new THREE.Mesh(geometry, material);
        mesh.position.copy(pos);
        mesh.lookAt(0, 0, 0);
        mesh.userData.layerType = 'station';
        group.add(mesh);
      });
    }

    if (layers.satellitesAndRoutes) {
      satellites.forEach((sat) => {
        const pos = getSatellitePosition(sat, currentDate);
        if (pos) {
          const geometry = new THREE.BoxGeometry(0.015, 0.015, 0.015);
          const material = new THREE.MeshBasicMaterial({ color: 0x888888 });
          const mesh = new THREE.Mesh(geometry, material);
          mesh.position.copy(pos);
          mesh.userData.layerType = 'satellite';
          group.add(mesh);

          const orbitPoints: THREE.Vector3[] = [];
          for (let i = 0; i <= 360; i += 3) {
            const futureTime = new Date(currentDate.getTime() + (i / 360) * 90 * 60 * 1000);
            const futurePos = getSatellitePosition(sat, futureTime);
            if (futurePos) orbitPoints.push(futurePos);
          }
          if (orbitPoints.length > 10) {
            const orbitGeometry = new THREE.BufferGeometry().setFromPoints(orbitPoints);
            const orbitMaterial = new THREE.LineBasicMaterial({
              color: 0x444444,
              transparent: true,
              opacity: 0.3,
            });
            const orbit = new THREE.Line(orbitGeometry, orbitMaterial);
            orbit.userData.layerType = 'orbit';
            group.add(orbit);
          }
        }
      });
    }

    if (layers.passTraffic) {
      passes.forEach((pass) => {
        if (pass.status !== PassStatus.Active && pass.status !== PassStatus.Dropped) return;
        
        const station = stations.find(s => s.id === pass.stationId);
        const sat = satellites.find(s => s.noradId === pass.satelliteId);
        if (!station || !sat) return;

        const stationPos = latLonToVector3(station.latitude, station.longitude, EARTH_RADIUS);
        const satPos = getSatellitePosition(sat, currentDate);
        if (!satPos) return;

        const points = [stationPos, satPos];
        const geometry = new THREE.BufferGeometry().setFromPoints(points);
        const material = new THREE.LineBasicMaterial({
          color: pass.status === PassStatus.Dropped ? COLORS.amber : 0xffffff,
          transparent: true,
          opacity: pass.status === PassStatus.Dropped ? 0.8 : 0.5,
        });
        const line = new THREE.Line(geometry, material);
        line.userData.layerType = 'passLink';
        group.add(line);
      });
    }

    if (layers.spaceWeather && spaceWeather && spaceWeather.kpIndex >= 4) {
      const oval = createAuroralOval(spaceWeather.kpIndex);
      oval.userData.layerType = 'auroral';
      group.add(oval);

      const southOvalPoints: THREE.Vector3[] = [];
      const baseLatitude = -(AURORAL_OVAL_BASE_LATITUDE - spaceWeather.kpIndex * AURORAL_OVAL_KP_SCALE);
      for (let lon = 0; lon <= 360; lon += 5) {
        southOvalPoints.push(latLonToVector3(baseLatitude, lon - 180, EARTH_RADIUS + 0.01));
      }
      const southOvalGeometry = new THREE.BufferGeometry().setFromPoints(southOvalPoints);
      const southOval = new THREE.Line(southOvalGeometry, new THREE.LineBasicMaterial({
        color: COLORS.amber,
        transparent: true,
        opacity: 0.6,
      }));
      southOval.userData.layerType = 'auroral';
      group.add(southOval);

      if (layers.groundStations) {
        const affectedLatitude = Math.abs(AURORAL_OVAL_BASE_LATITUDE - spaceWeather.kpIndex * AURORAL_OVAL_KP_SCALE);
        stations.forEach((station) => {
          if (Math.abs(station.latitude) > affectedLatitude - 5) {
            const pos = latLonToVector3(station.latitude, station.longitude, EARTH_RADIUS);
            const ringGeometry = new THREE.RingGeometry(0.04, 0.06, 16);
            const ringMaterial = new THREE.MeshBasicMaterial({
              color: COLORS.amber,
              transparent: true,
              opacity: 0.5,
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
