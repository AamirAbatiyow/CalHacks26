import { useRef, useEffect, useMemo } from 'react';
import * as THREE from 'three';
import * as satellite from 'satellite.js';
import { COLORS } from '../../config';

interface ClaimGlobeProps {
  stationLat: number;
  stationLon: number;
  stationName: string;
  satelliteTle1: string;
  satelliteTle2: string;
  currentTime: bigint;
  signalLostTime: bigint;
  contactStartTime: bigint;
  contactEndTime: bigint;
  kpIndex: number;
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

function getSatellitePosition(tle1: string, tle2: string, time: Date): { pos: THREE.Vector3; lat: number; lon: number } | null {
  try {
    const satrec = satellite.twoline2satrec(tle1, tle2);
    const positionAndVelocity = satellite.propagate(satrec, time);
    if (!positionAndVelocity || typeof positionAndVelocity.position === 'boolean' || !positionAndVelocity.position) {
      return null;
    }
    const gmst = satellite.gstime(time);
    const position = positionAndVelocity.position;
    const pos = satellite.eciToGeodetic(position, gmst);
    const lat = satellite.degreesLat(pos.latitude);
    const lon = satellite.degreesLong(pos.longitude);
    return {
      pos: latLonToVector3(lat, lon, EARTH_RADIUS + SATELLITE_ALTITUDE),
      lat,
      lon,
    };
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

export function ClaimGlobe({
  stationLat,
  stationLon,
  stationName: _stationName,
  satelliteTle1,
  satelliteTle2,
  currentTime,
  signalLostTime,
  contactStartTime,
  contactEndTime,
  kpIndex,
}: ClaimGlobeProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const groupRef = useRef<THREE.Group | null>(null);
  const frameRef = useRef<number>(0);
  const isDraggingRef = useRef(false);
  const previousMouseRef = useRef({ x: 0, y: 0 });

  const prefersReducedMotion = useMemo(() => {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }, []);

  useEffect(() => {
    if (!containerRef.current) return;

    const scene = new THREE.Scene();
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(
      35,
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
    scene.add(group);
    groupRef.current = group;

    const earth = createDottedEarth();
    group.add(earth);

    const stationPos = latLonToVector3(stationLat, stationLon, EARTH_RADIUS);
    const targetLookAt = stationPos.clone().normalize();
    
    const up = new THREE.Vector3(0, 1, 0);
    const right = new THREE.Vector3().crossVectors(up, targetLookAt).normalize();
    const newUp = new THREE.Vector3().crossVectors(targetLookAt, right);
    
    const rotationMatrix = new THREE.Matrix4().makeBasis(right, newUp, targetLookAt);
    const euler = new THREE.Euler().setFromRotationMatrix(rotationMatrix);
    
    group.rotation.x = -euler.x + 0.3;
    group.rotation.y = -euler.y - Math.PI;

    const animate = () => {
      frameRef.current = requestAnimationFrame(animate);
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
  }, [stationLat, stationLon, prefersReducedMotion]);

  useEffect(() => {
    if (!groupRef.current) return;
    const group = groupRef.current;

    const toRemove: THREE.Object3D[] = [];
    group.traverse((child) => {
      if (child.userData.dynamic) {
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

    const stationPos = latLonToVector3(stationLat, stationLon, EARTH_RADIUS);
    const stationGeometry = new THREE.BoxGeometry(0.04, 0.04, 0.04);
    const stationMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff });
    const stationMesh = new THREE.Mesh(stationGeometry, stationMaterial);
    stationMesh.position.copy(stationPos);
    stationMesh.lookAt(0, 0, 0);
    stationMesh.userData.dynamic = true;
    group.add(stationMesh);

    const currentDate = new Date(Number(currentTime) / 1000);
    const satResult = getSatellitePosition(satelliteTle1, satelliteTle2, currentDate);

    if (satResult) {
      const satGeometry = new THREE.BoxGeometry(0.025, 0.025, 0.025);
      const satMaterial = new THREE.MeshBasicMaterial({ color: 0x888888 });
      const satMesh = new THREE.Mesh(satGeometry, satMaterial);
      satMesh.position.copy(satResult.pos);
      satMesh.userData.dynamic = true;
      group.add(satMesh);
    }

    const orbitPoints: THREE.Vector3[] = [];
    const startMs = Number(contactStartTime) / 1000;
    const endMs = Number(contactEndTime) / 1000;
    const signalLostMs = Number(signalLostTime) / 1000;
    const duration = endMs - startMs;

    for (let i = 0; i <= 60; i++) {
      const t = startMs + (i / 60) * duration;
      const pos = getSatellitePosition(satelliteTle1, satelliteTle2, new Date(t));
      if (pos) orbitPoints.push(pos.pos);
    }

    if (orbitPoints.length > 2) {
      const orbitGeometry = new THREE.BufferGeometry().setFromPoints(orbitPoints);
      const orbitMaterial = new THREE.LineBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.4,
      });
      const orbit = new THREE.Line(orbitGeometry, orbitMaterial);
      orbit.userData.dynamic = true;
      group.add(orbit);
    }

    const signalLostPos = getSatellitePosition(satelliteTle1, satelliteTle2, new Date(signalLostMs));
    if (signalLostPos) {
      const markerGeometry = new THREE.SphereGeometry(0.025, 16, 16);
      const markerMaterial = new THREE.MeshBasicMaterial({ color: COLORS.amber });
      const marker = new THREE.Mesh(markerGeometry, markerMaterial);
      marker.position.copy(signalLostPos.pos);
      marker.userData.dynamic = true;
      group.add(marker);

      const ringGeometry = new THREE.RingGeometry(0.035, 0.045, 32);
      const ringMaterial = new THREE.MeshBasicMaterial({
        color: COLORS.amber,
        transparent: true,
        opacity: 0.5,
        side: THREE.DoubleSide,
      });
      const ring = new THREE.Mesh(ringGeometry, ringMaterial);
      ring.position.copy(signalLostPos.pos);
      ring.lookAt(0, 0, 0);
      ring.userData.dynamic = true;
      group.add(ring);
    }

    if (kpIndex >= 4) {
      const baseLatitude = 67 - kpIndex * 3;
      const ovalPoints: THREE.Vector3[] = [];
      for (let lon = 0; lon <= 360; lon += 5) {
        ovalPoints.push(latLonToVector3(baseLatitude, lon - 180, EARTH_RADIUS + 0.01));
      }
      const ovalGeometry = new THREE.BufferGeometry().setFromPoints(ovalPoints);
      const ovalMaterial = new THREE.LineBasicMaterial({
        color: COLORS.amber,
        transparent: true,
        opacity: 0.6,
      });
      const oval = new THREE.Line(ovalGeometry, ovalMaterial);
      oval.userData.dynamic = true;
      group.add(oval);

      const southOvalPoints: THREE.Vector3[] = [];
      for (let lon = 0; lon <= 360; lon += 5) {
        southOvalPoints.push(latLonToVector3(-baseLatitude, lon - 180, EARTH_RADIUS + 0.01));
      }
      const southOvalGeometry = new THREE.BufferGeometry().setFromPoints(southOvalPoints);
      const southOval = new THREE.Line(southOvalGeometry, new THREE.LineBasicMaterial({
        color: COLORS.amber,
        transparent: true,
        opacity: 0.6,
      }));
      southOval.userData.dynamic = true;
      group.add(southOval);
    }

  }, [stationLat, stationLon, satelliteTle1, satelliteTle2, currentTime, signalLostTime, contactStartTime, contactEndTime, kpIndex]);

  return (
    <div className="claim-globe-container">
      <div ref={containerRef} className="claim-globe" />
      {currentTime >= signalLostTime && currentTime < contactEndTime && (
        <div className="signal-lost-label">Signal lost</div>
      )}
    </div>
  );
}
