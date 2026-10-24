import * as THREE from 'three';

export function latLonToVector3(lat: number, lon: number, radius: number): THREE.Vector3 {
  const phi = (90 - lat) * (Math.PI / 180);
  const theta = (lon + 180) * (Math.PI / 180);
  return new THREE.Vector3(
    -radius * Math.sin(phi) * Math.cos(theta),
    radius * Math.cos(phi),
    radius * Math.sin(phi) * Math.sin(theta)
  );
}

/** Ground-station marker: a small flat white dot on a unit globe, sized by monthly revenue. */
export function createStationDot(lat: number, lon: number, monthlyRevenueCents: bigint | number): THREE.Mesh {
  const revenueShare = Math.min(1, Number(monthlyRevenueCents) / 5000000000);
  const geometry = new THREE.CircleGeometry(0.005 + 0.007 * revenueShare, 24);
  const material = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.copy(latLonToVector3(lat, lon, 1.002));
  mesh.lookAt(0, 0, 0);
  return mesh;
}
