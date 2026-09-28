import * as THREE from "three";
import type { DetailLayer, TerrainData } from "@core/map-types";
import { DETAIL_STRIDE, detailInstances } from "@core/details";
import { loadModel, loadTexture } from "./asset-cache";

/**
 * Detail layers (grass, flowers, bushes) drawn with instancing: one draw call
 * per layer for thousands of tufts, generated from the painted density by the
 * same code as the server screenshots and game exports. Grass sways in the wind.
 */

/** Tufts drawn per layer at most (dense meadows are thinned out evenly). */
const MAX_TUFTS = 150_000;

/** Shared clock for the wind (seconds). */
export const windUniform = { value: 0 };

/** Bends vertices with their height above the tuft's root (position.y is 0 at the root, 1 at the top). */
function addWind(material: THREE.Material): void {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uWindTime = windUniform;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nuniform float uWindTime;")
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
        #ifdef USE_INSTANCING
          vec3 rootPos = instanceMatrix[3].xyz;
          float sway = sin(uWindTime * 1.7 + rootPos.x * 0.35 + rootPos.z * 0.27) + 0.4 * sin(uWindTime * 3.1 + rootPos.x * 0.9);
          transformed.x += sway * 0.12 * position.y * position.y;
          transformed.z += sway * 0.06 * position.y * position.y;
        #endif`,
      );
  };
}

/** Procedural grass tuft: 5 thin blades in a unit box (1 wide, 1 tall), dark at the root, light at the tip. */
function bladeTuftGeometry(): THREE.BufferGeometry {
  const positions: number[] = [];
  const colors: number[] = [];
  const blades = 5;
  for (let b = 0; b < blades; b++) {
    const a = (b / blades) * Math.PI * 2 + b * 0.7;
    const r = 0.18 + (b % 2) * 0.12;
    const cx = Math.cos(a) * r * 0.5;
    const cz = Math.sin(a) * r * 0.5;
    const px = -Math.sin(a) * 0.06;
    const pz = Math.cos(a) * 0.06;
    const lean = 0.18 + (b % 3) * 0.08;
    const tipH = 0.75 + (b % 3) * 0.12;
    positions.push(cx - px, 0, cz - pz, cx + px, 0, cz + pz, cx + Math.cos(a) * lean, tipH, cz + Math.sin(a) * lean);
    colors.push(0.45, 0.45, 0.45, 0.45, 0.45, 0.45, 1.1, 1.1, 1.1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  // Blades lit like the ground they grow on.
  g.setAttribute("normal", new THREE.Float32BufferAttribute(positions.map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
  return g;
}

/** Two crossed unit quads (1 wide, 1 tall) for sprite tufts. */
function crossedQuadsGeometry(): THREE.BufferGeometry {
  const a = new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0);
  const b = new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0).rotateY(Math.PI / 2);
  const merged = new THREE.BufferGeometry();
  const pos = [...(a.getAttribute("position").array as Float32Array), ...(b.getAttribute("position").array as Float32Array)];
  const uv = [...(a.getAttribute("uv").array as Float32Array), ...(b.getAttribute("uv").array as Float32Array)];
  const idxA = Array.from(a.getIndex()!.array);
  const idxB = Array.from(b.getIndex()!.array).map((i) => i + 4);
  merged.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  merged.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  merged.setAttribute("normal", new THREE.Float32BufferAttribute(pos.map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
  merged.setIndex([...idxA, ...idxB]);
  return merged;
}

function instanceMatrices(inst: Float32Array, sx: number, sy: number): THREE.Matrix4[] {
  const out: THREE.Matrix4[] = [];
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  for (let k = 0; k < inst.length; k += DETAIL_STRIDE) {
    const s = inst[k + 4];
    q.setFromAxisAngle(up, inst[k + 3]);
    out.push(new THREE.Matrix4().compose(new THREE.Vector3(inst[k], inst[k + 1], inst[k + 2]), q, new THREE.Vector3(sx * s, sy * s, sx * s)));
  }
  return out;
}

function instanced(geometry: THREE.BufferGeometry, material: THREE.Material, matrices: THREE.Matrix4[]): THREE.InstancedMesh {
  const mesh = new THREE.InstancedMesh(geometry, material, Math.max(1, matrices.length));
  matrices.forEach((m, i) => mesh.setMatrixAt(i, m));
  mesh.count = matrices.length;
  mesh.instanceMatrix.needsUpdate = true;
  mesh.frustumCulled = false;
  return mesh;
}

/**
 * Builds the tufts of one detail layer. Models and sprites load
 * asynchronously: `onLoaded` fires when the final meshes replace the
 * placeholder, so the caller can re-render.
 */
export function buildDetailLayer(
  t: TerrainData,
  layer: DetailLayer,
  layerIndex: number,
  isWet: (x: number, z: number) => boolean,
  onLoaded: () => void,
): THREE.Group {
  const group = new THREE.Group();
  group.userData.detailLayerId = layer.id;
  const inst = detailInstances(t, layer, layerIndex, { maxInstances: MAX_TUFTS, isWet });
  if (inst.length === 0) return group;

  if (layer.model) {
    void loadModel(layer.model).then((scene) => {
      if (!scene || group.userData.disposed) return;
      scene.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(scene);
      const modelHeight = box.max.y - box.min.y || 1;
      const scale = layer.height / modelHeight;
      const matrices = instanceMatrices(inst, scale, scale);
      scene.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        const geometry = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
        group.add(instanced(geometry, mesh.material as THREE.Material, matrices));
      });
      onLoaded();
    });
    return group;
  }

  const matrices = instanceMatrices(inst, layer.width, layer.height);
  if (layer.sprite) {
    const material = new THREE.MeshLambertMaterial({ color: layer.color, alphaTest: 0.5, side: THREE.DoubleSide });
    addWind(material);
    group.add(instanced(crossedQuadsGeometry(), material, matrices));
    void loadTexture(layer.sprite).then((tex) => {
      if (!tex || group.userData.disposed) return;
      material.map = tex;
      material.needsUpdate = true;
      onLoaded();
    });
    return group;
  }

  const material = new THREE.MeshLambertMaterial({ color: layer.color, vertexColors: true, side: THREE.DoubleSide });
  addWind(material);
  group.add(instanced(bladeTuftGeometry(), material, matrices));
  return group;
}

export function disposeDetailGroup(group: THREE.Group): void {
  group.userData.disposed = true;
  group.traverse((o) => {
    const mesh = o as THREE.InstancedMesh;
    if (!mesh.isInstancedMesh) return;
    mesh.geometry.dispose();
    // Model materials are shared with the cached model; ours are not.
    const mat = mesh.material as THREE.Material;
    if (mat.userData?.shared !== true && !(mat as THREE.MeshStandardMaterial).isMeshStandardMaterial) mat.dispose();
    mesh.dispose();
  });
}
