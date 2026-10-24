import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { GLOBE_ROTATION_PERIOD_MS } from '../config';
import { createContinentOutlines, createDottedEarth, createOccluder } from './globeMarkers';

interface GlobeSceneOptions {
  /** Spin slowly when not being dragged. */
  autoRotate?: boolean;
  /** Turn the globe so this point faces the camera, north up. */
  focus?: { lat: number; lon: number };
  cameraDistance?: number;
}

export interface GlobeScene {
  group: THREE.Group;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
}

/**
 * Shared three.js setup for the globes: renderer, camera, drag-to-rotate, and the
 * dotted earth with continent outlines and an occluder. `onFrame` runs after each
 * render, for overlays that follow projected positions.
 */
export function useGlobeScene(options: GlobeSceneOptions, onFrame?: (scene: GlobeScene) => void) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scene, setScene] = useState<GlobeScene | null>(null);
  const onFrameRef = useRef(onFrame);
  useEffect(() => {
    onFrameRef.current = onFrame;
  });
  const { autoRotate = false, cameraDistance = 3.2 } = options;
  const autoRotateRef = useRef(autoRotate);
  useEffect(() => {
    autoRotateRef.current = autoRotate;
  }, [autoRotate]);
  const focusLat = options.focus?.lat;
  const focusLon = options.focus?.lon;

  const prefersReducedMotion = useMemo(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const threeScene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, container.clientWidth / container.clientHeight, 0.1, 100);
    camera.position.z = cameraDistance;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0x000000, 0);
    container.appendChild(renderer.domElement);

    const group = new THREE.Group();
    group.rotation.order = 'XYZ';
    if (focusLat !== undefined && focusLon !== undefined) {
      group.rotation.y = Math.PI / 2 - (focusLon + 180) * (Math.PI / 180);
      group.rotation.x = focusLat * (Math.PI / 180) * 0.85;
    } else {
      group.rotation.x = 0.1;
    }
    group.add(createOccluder(), createDottedEarth(), createContinentOutlines());
    threeScene.add(group);

    const handle: GlobeScene = { group, camera, renderer };
    setScene(handle);

    let dragging = false;
    let previous = { x: 0, y: 0 };
    let velocity = { x: 0, y: 0 };
    let frame = 0;

    const animate = () => {
      frame = requestAnimationFrame(animate);
      if (!dragging) {
        if (autoRotateRef.current && !prefersReducedMotion) group.rotation.y += (2 * Math.PI) / (GLOBE_ROTATION_PERIOD_MS / 16.67);
        group.rotation.x += velocity.x;
        group.rotation.y += velocity.y;
        velocity = { x: velocity.x * 0.95, y: velocity.y * 0.95 };
      }
      renderer.render(threeScene, camera);
      onFrameRef.current?.(handle);
    };
    animate();

    const handleResize = () => {
      camera.aspect = container.clientWidth / container.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(container.clientWidth, container.clientHeight);
    };
    const observer = new ResizeObserver(handleResize);
    observer.observe(container);

    const handleMouseDown = (e: MouseEvent) => {
      dragging = true;
      previous = { x: e.clientX, y: e.clientY };
    };
    const handleMouseMove = (e: MouseEvent) => {
      if (!dragging) return;
      const dx = e.clientX - previous.x;
      const dy = e.clientY - previous.y;
      group.rotation.y += dx * 0.005;
      group.rotation.x = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, group.rotation.x + dy * 0.005));
      velocity = { x: dy * 0.001, y: dx * 0.001 };
      previous = { x: e.clientX, y: e.clientY };
    };
    const handleMouseUp = () => {
      dragging = false;
    };

    renderer.domElement.addEventListener('mousedown', handleMouseDown);
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      renderer.domElement.removeEventListener('mousedown', handleMouseDown);
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      renderer.dispose();
      renderer.domElement.remove();
      setScene(null);
    };
  }, [cameraDistance, focusLat, focusLon, prefersReducedMotion]);

  return { containerRef, scene };
}

const projected = new THREE.Vector3();
const worldPos = new THREE.Vector3();
const toCamera = new THREE.Vector3();

/**
 * Screen position (CSS px within the canvas) of a point in the globe group, and
 * whether it is on the visible hemisphere.
 */
export function projectToScreen(scene: GlobeScene, local: THREE.Vector3): { x: number; y: number; visible: boolean } {
  worldPos.copy(local).applyMatrix4(scene.group.matrixWorld);
  toCamera.copy(scene.camera.position).sub(worldPos);
  const visible = worldPos.dot(toCamera) > -0.02 * worldPos.length();
  projected.copy(worldPos).project(scene.camera);
  const canvas = scene.renderer.domElement;
  return {
    x: ((projected.x + 1) / 2) * canvas.clientWidth,
    y: ((1 - projected.y) / 2) * canvas.clientHeight,
    visible,
  };
}
