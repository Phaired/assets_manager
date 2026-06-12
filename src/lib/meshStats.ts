import * as THREE from "three";

export interface MeshStats {
  faces: number;
  vertices: number;
  /** Model bounding-box size (world units) — for the dimensions readout. */
  size: { x: number; y: number; z: number };
}

/** Count faces/vertices and measure the bounding box of a loaded scene.
 *  Shared by Viewer3D and CompareViewer3D. */
export function collectMeshStats(root: THREE.Object3D): {
  stats: MeshStats;
  box: THREE.Box3;
} {
  let faces = 0;
  let vertices = 0;
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (mesh.isMesh && mesh.geometry) {
      const g = mesh.geometry as THREE.BufferGeometry;
      const pos = g.getAttribute("position");
      if (pos) vertices += pos.count;
      if (g.index) faces += g.index.count / 3;
      else if (pos) faces += pos.count / 3;
    }
  });
  const box = new THREE.Box3().setFromObject(root);
  const size = new THREE.Vector3();
  box.getSize(size);
  return {
    stats: {
      faces: Math.round(faces),
      vertices,
      size: { x: size.x, y: size.y, z: size.z },
    },
    box,
  };
}
