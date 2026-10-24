import { useMemo } from 'react';
import * as THREE from 'three';
import type { Station } from '../../types';
import { latLonToVector3 } from '../../utils/geo';

interface GroundStationLayerProps {
  stations: Station[];
  visible: boolean;
  globeRadius: number;
}

/**
 * Create a Three.js group containing ground station markers
 */
export function createGroundStationGroup(
  stations: Station[],
  globeRadius: number
): THREE.Group {
  const group = new THREE.Group();
  group.name = 'ground-stations';

  if (stations.length === 0) return group;

  const revenues = stations.map((s) => s.monthlyRevenue);
  const minRevenue = Math.min(...revenues);
  const maxRevenue = Math.max(...revenues);
  const range = maxRevenue - minRevenue;

  stations.forEach((station) => {
    const normalized = range === 0 ? 0.5 : (station.monthlyRevenue - minRevenue) / range;
    const minSize = 0.04;
    const maxSize = 0.12;
    const size = minSize + normalized * (maxSize - minSize);

    const elevation = 0.02;
    const [x, y, z] = latLonToVector3(
      station.lat,
      station.lon,
      globeRadius * (1 + elevation)
    );

    const geometry = new THREE.BoxGeometry(size, size, size * 0.5);
    const material = new THREE.MeshBasicMaterial({ color: 0xffffff });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(x, y, z);
    mesh.lookAt(0, 0, 0);
    mesh.userData = { station, type: 'station-marker' };
    group.add(mesh);
  });

  return group;
}

/**
 * Create a label sprite for a station
 */
export function createStationLabel(
  station: Station,
  globeRadius: number
): THREE.Sprite {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  
  canvas.width = 256;
  canvas.height = 64;

  if (ctx) {
    ctx.fillStyle = 'rgba(20, 20, 24, 0.85)';
    ctx.roundRect(0, 0, canvas.width, canvas.height, 8);
    ctx.fill();

    ctx.font = 'bold 24px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(station.name, canvas.width / 2, canvas.height / 2);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;

  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthTest: false,
  });

  const sprite = new THREE.Sprite(material);
  
  const elevation = 0.05;
  const [x, y, z] = latLonToVector3(
    station.lat,
    station.lon,
    globeRadius * (1 + elevation)
  );
  sprite.position.set(x, y, z);
  sprite.scale.set(0.4, 0.1, 1);
  sprite.userData = { station, type: 'station-label' };

  return sprite;
}

/**
 * React hook for managing ground station layer
 */
export function useGroundStationLayer({
  stations,
  visible,
  globeRadius,
}: GroundStationLayerProps): THREE.Group | null {
  return useMemo(() => {
    if (!visible) return null;
    return createGroundStationGroup(stations, globeRadius);
  }, [stations, visible, globeRadius]);
}

export function GroundStationLayer({
  stations,
  visible,
  globeRadius,
}: GroundStationLayerProps): THREE.Group | null {
  return useGroundStationLayer({ stations, visible, globeRadius });
}

export default GroundStationLayer;
