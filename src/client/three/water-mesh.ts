import * as THREE from "three";
import type { Map3D } from "@core/map-types";
import { sampleSpacing } from "@core/terrain";
import { DEFAULT_WATER_COLOR, waterMask, wetCells } from "@core/water";

/**
 * Water surfaces of a 3D map: the sea (a plane at terrain.waterLevel, extended
 * past the terrain edges) and every lake over the cells of its basin. Each
 * vertex carries the water depth there, so the shader makes shallow water
 * clear and deep water dark — shores fade in naturally.
 */

const vertexShader = /* glsl */ `
  attribute float depth;
  varying float vDepth;
  void main() {
    vDepth = depth;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  uniform vec3 uColor;
  varying float vDepth;
  void main() {
    float alpha = clamp(0.28 + vDepth * 0.12, 0.28, 0.9);
    vec3 c = uColor * (1.0 - min(0.5, vDepth * 0.035));
    gl_FragColor = vec4(c, alpha);
    #include <colorspace_fragment>
  }
`;

function waterMaterial(color: string): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(color) } },
    vertexShader,
    fragmentShader,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}

/** Quads (one per grid cell) at `level`, with per-vertex depth from the terrain. */
function cellsGeometry(map: Map3D, cells: Array<{ ix: number; iz: number }>, level: number): THREE.BufferGeometry {
  const t = map.terrain;
  const res = t.resolution;
  const { dx, dz } = sampleSpacing(t);
  const positions = new Float32Array(cells.length * 12);
  const depths = new Float32Array(cells.length * 4);
  const index = new Uint32Array(cells.length * 6);
  cells.forEach(({ ix, iz }, k) => {
    const corners: Array<[number, number]> = [
      [ix, iz],
      [ix + 1, iz],
      [ix, iz + 1],
      [ix + 1, iz + 1],
    ];
    corners.forEach(([cx, cz], c) => {
      positions.set([cx * dx, level, cz * dz], (k * 4 + c) * 3);
      depths[k * 4 + c] = Math.max(0, level - t.heights[cz * res + cx]);
    });
    const b = k * 4;
    index.set([b, b + 2, b + 1, b + 1, b + 2, b + 3], k * 6);
  });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("depth", new THREE.BufferAttribute(depths, 1));
  geometry.setIndex(new THREE.BufferAttribute(index, 1));
  return geometry;
}

/** The sea beyond the terrain edges: a frame of 4 deep quads. */
function seaFrameGeometry(map: Map3D, level: number): THREE.BufferGeometry {
  const { width: w, depth: d } = map.terrain.size;
  const far = Math.max(w, d) * 4;
  const rects: Array<[number, number, number, number]> = [
    [-far, -far, w + far, 0],
    [-far, d, w + far, d + far],
    [-far, 0, 0, d],
    [w, 0, w + far, d],
  ];
  const positions: number[] = [];
  const index: number[] = [];
  for (const [x0, z0, x1, z1] of rects) {
    const b = positions.length / 3;
    positions.push(x0, level, z0, x1, level, z0, x0, level, z1, x1, level, z1);
    index.push(b, b + 2, b + 1, b + 1, b + 2, b + 3);
  }
  // Same depth as along the terrain's edges, so the sea has no visible seam there.
  const t = map.terrain;
  const res = t.resolution;
  let edge = 0;
  for (let k = 0; k < res; k++) {
    edge += t.heights[k] + t.heights[(res - 1) * res + k] + t.heights[k * res] + t.heights[k * res + res - 1];
  }
  const edgeDepth = Math.max(0, level - edge / (res * 4));
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute("depth", new THREE.BufferAttribute(new Float32Array(positions.length / 3).fill(edgeDepth), 1));
  geometry.setIndex(index);
  return geometry;
}

export function buildWaterGroup(map: Map3D): THREE.Group {
  const group = new THREE.Group();
  const t = map.terrain;
  if (t.waterLevel !== null) {
    const res = t.resolution;
    const all: Array<{ ix: number; iz: number }> = [];
    for (let iz = 0; iz < res - 1; iz++) for (let ix = 0; ix < res - 1; ix++) all.push({ ix, iz });
    const material = waterMaterial(DEFAULT_WATER_COLOR);
    group.add(new THREE.Mesh(cellsGeometry(map, all, t.waterLevel), material));
    group.add(new THREE.Mesh(seaFrameGeometry(map, t.waterLevel), material));
  }
  for (const body of map.waters) {
    const cells = wetCells(t, waterMask(t, body));
    if (cells.length === 0) continue;
    const mesh = new THREE.Mesh(cellsGeometry(map, cells, body.level), waterMaterial(body.color ?? DEFAULT_WATER_COLOR));
    mesh.userData.waterId = body.id;
    group.add(mesh);
  }
  group.renderOrder = 2;
  group.traverse((o) => (o.renderOrder = 2));
  return group;
}

export function disposeWaterGroup(group: THREE.Group): void {
  const materials = new Set<THREE.Material>();
  group.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry.dispose();
    materials.add(mesh.material as THREE.Material);
  });
  materials.forEach((m) => m.dispose());
}
