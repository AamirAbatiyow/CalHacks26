import { useEffect, useRef, useCallback } from 'react';
import * as THREE from 'three';
import { generateEarthLandPoints } from '../utils/earthGeometry';

const EARTH_RADIUS = 1.0;
const CAMERA_DISTANCE = 2.8;
const AUTO_ROTATION_SPEED = 0.00052;
const DAMPING_FACTOR = 0.95;
const MIN_POLAR_ANGLE = Math.PI * 0.15;
const MAX_POLAR_ANGLE = Math.PI * 0.85;

interface DragState {
  isDragging: boolean;
  previousMouseX: number;
  previousMouseY: number;
  velocityX: number;
  velocityY: number;
}

export interface GlobeContext {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  earthGroup: THREE.Group;
  addOverlay: (object: THREE.Object3D) => void;
  removeOverlay: (object: THREE.Object3D) => void;
}

export interface UseGlobeOptions {
  prefersReducedMotion: boolean;
}

export function useGlobe(
  containerRef: React.RefObject<HTMLDivElement | null>,
  options: UseGlobeOptions
) {
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const earthGroupRef = useRef<THREE.Group | null>(null);
  const frameIdRef = useRef<number>(0);
  const dragStateRef = useRef<DragState>({
    isDragging: false,
    previousMouseX: 0,
    previousMouseY: 0,
    velocityX: 0,
    velocityY: 0,
  });
  const sphericalRef = useRef<{ theta: number; phi: number }>({
    theta: THREE.MathUtils.degToRad(20),
    phi: THREE.MathUtils.degToRad(70),
  });

  const { prefersReducedMotion } = options;

  const createPointCloud = useCallback(() => {
    const { positions, colors } = generateEarthLandPoints({
      numPoints: 80000,
      radius: EARTH_RADIUS,
      jitter: 0.003,
    });

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    const material = new THREE.PointsMaterial({
      size: 0.012,
      vertexColors: true,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.95,
    });

    return new THREE.Points(geometry, material);
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x000000);
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(
      45,
      container.clientWidth / container.clientHeight,
      0.1,
      100
    );
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
    });
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    renderer.domElement.tabIndex = 0;
    renderer.domElement.setAttribute('role', 'img');
    renderer.domElement.setAttribute('aria-label', 'Interactive 3D globe showing Earth land masses');

    const earthGroup = new THREE.Group();
    scene.add(earthGroup);
    earthGroupRef.current = earthGroup;

    const pointCloud = createPointCloud();
    earthGroup.add(pointCloud);

    const sphereGeometry = new THREE.SphereGeometry(EARTH_RADIUS * 0.99, 32, 32);
    const sphereMaterial = new THREE.MeshBasicMaterial({
      color: 0x050505,
      transparent: true,
      opacity: 0.3,
    });
    const sphere = new THREE.Mesh(sphereGeometry, sphereMaterial);
    earthGroup.add(sphere);

    const updateCameraPosition = () => {
      const { theta, phi } = sphericalRef.current;
      camera.position.x = CAMERA_DISTANCE * Math.sin(phi) * Math.cos(theta);
      camera.position.y = CAMERA_DISTANCE * Math.cos(phi);
      camera.position.z = CAMERA_DISTANCE * Math.sin(phi) * Math.sin(theta);
      camera.lookAt(0, 0, 0);
    };
    updateCameraPosition();

    const handleMouseDown = (e: MouseEvent) => {
      dragStateRef.current.isDragging = true;
      dragStateRef.current.previousMouseX = e.clientX;
      dragStateRef.current.previousMouseY = e.clientY;
      dragStateRef.current.velocityX = 0;
      dragStateRef.current.velocityY = 0;
      container.style.cursor = 'grabbing';
    };

    const handleMouseMove = (e: MouseEvent) => {
      if (!dragStateRef.current.isDragging) return;

      const deltaX = e.clientX - dragStateRef.current.previousMouseX;
      const deltaY = e.clientY - dragStateRef.current.previousMouseY;

      const rotationSpeed = 0.005;
      sphericalRef.current.theta -= deltaX * rotationSpeed;
      sphericalRef.current.phi = Math.max(
        MIN_POLAR_ANGLE,
        Math.min(MAX_POLAR_ANGLE, sphericalRef.current.phi + deltaY * rotationSpeed)
      );

      dragStateRef.current.velocityX = deltaX * rotationSpeed;
      dragStateRef.current.velocityY = deltaY * rotationSpeed;
      dragStateRef.current.previousMouseX = e.clientX;
      dragStateRef.current.previousMouseY = e.clientY;

      updateCameraPosition();
    };

    const handleMouseUp = () => {
      dragStateRef.current.isDragging = false;
      container.style.cursor = 'grab';
    };

    const handleMouseLeave = () => {
      if (dragStateRef.current.isDragging) {
        dragStateRef.current.isDragging = false;
        container.style.cursor = 'grab';
      }
    };

    const handleTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 1) {
        dragStateRef.current.isDragging = true;
        dragStateRef.current.previousMouseX = e.touches[0].clientX;
        dragStateRef.current.previousMouseY = e.touches[0].clientY;
        dragStateRef.current.velocityX = 0;
        dragStateRef.current.velocityY = 0;
      }
    };

    const handleTouchMove = (e: TouchEvent) => {
      if (!dragStateRef.current.isDragging || e.touches.length !== 1) return;
      e.preventDefault();

      const deltaX = e.touches[0].clientX - dragStateRef.current.previousMouseX;
      const deltaY = e.touches[0].clientY - dragStateRef.current.previousMouseY;

      const rotationSpeed = 0.005;
      sphericalRef.current.theta -= deltaX * rotationSpeed;
      sphericalRef.current.phi = Math.max(
        MIN_POLAR_ANGLE,
        Math.min(MAX_POLAR_ANGLE, sphericalRef.current.phi + deltaY * rotationSpeed)
      );

      dragStateRef.current.velocityX = deltaX * rotationSpeed;
      dragStateRef.current.velocityY = deltaY * rotationSpeed;
      dragStateRef.current.previousMouseX = e.touches[0].clientX;
      dragStateRef.current.previousMouseY = e.touches[0].clientY;

      updateCameraPosition();
    };

    const handleTouchEnd = () => {
      dragStateRef.current.isDragging = false;
    };

    container.addEventListener('mousedown', handleMouseDown);
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    container.addEventListener('mouseleave', handleMouseLeave);
    container.addEventListener('touchstart', handleTouchStart, { passive: true });
    container.addEventListener('touchmove', handleTouchMove, { passive: false });
    container.addEventListener('touchend', handleTouchEnd);

    container.style.cursor = 'grab';

    const animate = () => {
      frameIdRef.current = requestAnimationFrame(animate);

      if (!dragStateRef.current.isDragging && !prefersReducedMotion) {
        sphericalRef.current.theta += AUTO_ROTATION_SPEED;
      }

      if (!dragStateRef.current.isDragging) {
        if (Math.abs(dragStateRef.current.velocityX) > 0.0001) {
          sphericalRef.current.theta -= dragStateRef.current.velocityX;
          dragStateRef.current.velocityX *= DAMPING_FACTOR;
        }
        if (Math.abs(dragStateRef.current.velocityY) > 0.0001) {
          sphericalRef.current.phi = Math.max(
            MIN_POLAR_ANGLE,
            Math.min(MAX_POLAR_ANGLE, sphericalRef.current.phi + dragStateRef.current.velocityY)
          );
          dragStateRef.current.velocityY *= DAMPING_FACTOR;
        }
      }

      updateCameraPosition();
      renderer.render(scene, camera);
    };
    animate();

    const handleResize = () => {
      if (!container) return;
      const width = container.clientWidth;
      const height = container.clientHeight;
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height);
    };
    window.addEventListener('resize', handleResize);

    return () => {
      cancelAnimationFrame(frameIdRef.current);
      window.removeEventListener('resize', handleResize);
      container.removeEventListener('mousedown', handleMouseDown);
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      container.removeEventListener('mouseleave', handleMouseLeave);
      container.removeEventListener('touchstart', handleTouchStart);
      container.removeEventListener('touchmove', handleTouchMove);
      container.removeEventListener('touchend', handleTouchEnd);

      scene.traverse((object) => {
        if (object instanceof THREE.Mesh || object instanceof THREE.Points) {
          object.geometry.dispose();
          if (Array.isArray(object.material)) {
            object.material.forEach((m) => m.dispose());
          } else {
            object.material.dispose();
          }
        }
      });
      renderer.dispose();

      if (container.contains(renderer.domElement)) {
        container.removeChild(renderer.domElement);
      }
    };
  }, [containerRef, createPointCloud, prefersReducedMotion]);

  return {
    scene: sceneRef.current,
    camera: cameraRef.current,
    earthGroup: earthGroupRef.current,
  };
}
