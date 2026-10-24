import {
  useRef,
  useEffect,
  useState,
  createContext,
  useContext,
  forwardRef,
  useImperativeHandle,
} from 'react';
import type { ReactNode } from 'react';
import * as THREE from 'three';
import { useGlobe } from '../hooks/useGlobe';
import type { GlobeContext } from '../hooks/useGlobe';
import type { LayerVisibility } from '../types';
import './Globe.css';

export interface GlobeProps {
  currentTime: Date;
  layers: LayerVisibility;
  children?: ReactNode;
}

export interface GlobeRef {
  getContext: () => GlobeContext | null;
  getScene: () => THREE.Scene | null;
  getCamera: () => THREE.PerspectiveCamera | null;
  getEarthGroup: () => THREE.Group | null;
  addOverlay: (object: THREE.Object3D) => void;
  removeOverlay: (object: THREE.Object3D) => void;
}

const GlobeReactContext = createContext<GlobeContext | null>(null);

export function useGlobeContext(): GlobeContext | null {
  return useContext(GlobeReactContext);
}

export const Globe = forwardRef<GlobeRef, GlobeProps>(function Globe(
  { children },
  ref
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);
  const [contextValue, setContextValue] = useState<GlobeContext | null>(null);

  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    setPrefersReducedMotion(mediaQuery.matches);

    const handler = (e: MediaQueryListEvent) => {
      setPrefersReducedMotion(e.matches);
    };

    mediaQuery.addEventListener('change', handler);
    return () => mediaQuery.removeEventListener('change', handler);
  }, []);

  const { scene, camera, earthGroup } = useGlobe(containerRef, {
    prefersReducedMotion,
  });

  useEffect(() => {
    if (scene && camera && earthGroup) {
      const ctx: GlobeContext = {
        scene,
        camera,
        earthGroup,
        addOverlay: (object: THREE.Object3D) => earthGroup.add(object),
        removeOverlay: (object: THREE.Object3D) => earthGroup.remove(object),
      };
      setContextValue(ctx);
    }
  }, [scene, camera, earthGroup]);

  useImperativeHandle(
    ref,
    () => ({
      getContext: () => contextValue,
      getScene: () => scene,
      getCamera: () => camera,
      getEarthGroup: () => earthGroup,
      addOverlay: (object: THREE.Object3D) => {
        earthGroup?.add(object);
      },
      removeOverlay: (object: THREE.Object3D) => {
        earthGroup?.remove(object);
      },
    }),
    [contextValue, scene, camera, earthGroup]
  );

  return (
    <div ref={containerRef} className="globe-container" data-testid="globe">
      {contextValue && (
        <GlobeReactContext.Provider value={contextValue}>
          {children}
        </GlobeReactContext.Provider>
      )}
    </div>
  );
});

export default Globe;
