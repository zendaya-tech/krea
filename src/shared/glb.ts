/**
 * Minimal, dependency-free glTF 2.0 binary (.glb) writer and reader.
 *
 * - writeGlb: static meshes with per-primitive colors (baseColorFactor) and
 *   optional vertex colors — used for terrain mesh exports and code-generated
 *   placeholder models.
 * - parseGlb: flattens a model's triangles (node transforms applied) with
 *   one color per primitive — enough for the server's software 3D renderer
 *   and bounding boxes. Textures are ignored (their material's base color
 *   factor is used instead). The browser editor uses Three.js' full loader.
 */

export type Vec3 = [number, number, number];
export type Rgba = [number, number, number, number];

export interface GlbPrimitiveInput {
  positions: Float32Array;
  normals?: Float32Array;
  /** Per-vertex RGB (0-1), 3 floats per vertex. */
  colors?: Float32Array;
  indices?: Uint32Array | Uint16Array;
  /** Linear RGBA 0-1 (default white). */
  color?: Rgba;
  roughness?: number;
  metallic?: number;
  doubleSided?: boolean;
}

export interface GlbMeshInput {
  name?: string;
  primitives: GlbPrimitiveInput[];
  translation?: Vec3;
  /** Quaternion [x, y, z, w]. */
  rotation?: [number, number, number, number];
  scale?: Vec3;
}

const GLB_MAGIC = 0x46546c67; // "glTF"
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

const FLOAT = 5126;
const UNSIGNED_BYTE = 5121;
const UNSIGNED_SHORT = 5123;
const UNSIGNED_INT = 5125;
const ARRAY_BUFFER = 34962;
const ELEMENT_ARRAY_BUFFER = 34963;

type Json = Record<string, unknown>;

export function writeGlb(meshes: GlbMeshInput[], generator = "Krea"): Uint8Array {
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  const bufferViews: Json[] = [];
  const accessors: Json[] = [];
  const materials: Json[] = [];
  const gltfMeshes: Json[] = [];
  const nodes: Json[] = [];

  function addView(data: ArrayBufferView, target: number): number {
    const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    const padding = (4 - (bytes.byteLength % 4)) % 4;
    chunks.push(bytes);
    if (padding) chunks.push(new Uint8Array(padding));
    bufferViews.push({ buffer: 0, byteOffset: byteLength, byteLength: bytes.byteLength, target });
    byteLength += bytes.byteLength + padding;
    return bufferViews.length - 1;
  }

  function addAccessor(data: Float32Array | Uint32Array | Uint16Array, type: "SCALAR" | "VEC3", target: number, withBounds = false): number {
    const view = addView(data, target);
    const componentType = data instanceof Float32Array ? FLOAT : data instanceof Uint32Array ? UNSIGNED_INT : UNSIGNED_SHORT;
    const size = type === "VEC3" ? 3 : 1;
    const accessor: Json = { bufferView: view, componentType, count: data.length / size, type };
    if (withBounds) {
      const min = [Infinity, Infinity, Infinity];
      const max = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < data.length; i += 3) {
        for (let c = 0; c < 3; c++) {
          min[c] = Math.min(min[c], data[i + c]);
          max[c] = Math.max(max[c], data[i + c]);
        }
      }
      Object.assign(accessor, { min, max });
    }
    accessors.push(accessor);
    return accessors.length - 1;
  }

  for (const mesh of meshes) {
    const primitives = mesh.primitives
      .filter((p) => p.positions.length >= 9)
      .map((p) => {
        const attributes: Json = { POSITION: addAccessor(p.positions, "VEC3", ARRAY_BUFFER, true) };
        if (p.normals) attributes.NORMAL = addAccessor(p.normals, "VEC3", ARRAY_BUFFER);
        if (p.colors) attributes.COLOR_0 = addAccessor(p.colors, "VEC3", ARRAY_BUFFER);
        materials.push({
          pbrMetallicRoughness: {
            baseColorFactor: p.color ?? [1, 1, 1, 1],
            metallicFactor: p.metallic ?? 0,
            roughnessFactor: p.roughness ?? 0.9,
          },
          ...(p.doubleSided ? { doubleSided: true } : {}),
          ...((p.color?.[3] ?? 1) < 1 ? { alphaMode: "BLEND" } : {}),
        });
        const primitive: Json = { attributes, material: materials.length - 1, mode: 4 };
        if (p.indices) primitive.indices = addAccessor(p.indices, "SCALAR", ELEMENT_ARRAY_BUFFER);
        return primitive;
      });
    if (primitives.length === 0) continue;
    gltfMeshes.push({ ...(mesh.name ? { name: mesh.name } : {}), primitives });
    nodes.push({
      mesh: gltfMeshes.length - 1,
      ...(mesh.name ? { name: mesh.name } : {}),
      ...(mesh.translation ? { translation: mesh.translation } : {}),
      ...(mesh.rotation ? { rotation: mesh.rotation } : {}),
      ...(mesh.scale ? { scale: mesh.scale } : {}),
    });
  }

  const gltf: Json = {
    asset: { version: "2.0", generator },
    scene: 0,
    scenes: [{ nodes: nodes.map((_, i) => i) }],
    nodes,
    meshes: gltfMeshes,
    materials,
    accessors,
    bufferViews,
    buffers: [{ byteLength }],
  };

  const jsonBytes = new TextEncoder().encode(JSON.stringify(gltf));
  const jsonPadded = new Uint8Array(Math.ceil(jsonBytes.length / 4) * 4).fill(0x20);
  jsonPadded.set(jsonBytes);
  const bin = new Uint8Array(byteLength);
  let offset = 0;
  for (const c of chunks) {
    bin.set(c, offset);
    offset += c.byteLength;
  }

  const total = 12 + 8 + jsonPadded.length + 8 + bin.length;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, GLB_MAGIC, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, jsonPadded.length, true);
  dv.setUint32(16, CHUNK_JSON, true);
  out.set(jsonPadded, 20);
  const binStart = 20 + jsonPadded.length;
  dv.setUint32(binStart, bin.length, true);
  dv.setUint32(binStart + 4, CHUNK_BIN, true);
  out.set(bin, binStart + 8);
  return out;
}

// ---- Reading ----

export interface ParsedPrimitive {
  /** Transformed into the model's root space, 3 floats per vertex. */
  positions: Float32Array;
  /** Triangle list (3 indices per triangle). */
  indices: Uint32Array;
  color: Rgba;
  /** Per-vertex RGB (0-1) if the model has COLOR_0. */
  vertexColors?: Float32Array;
}

export interface ParsedModel {
  primitives: ParsedPrimitive[];
  bounds: { min: Vec3; max: Vec3 };
}

export class GlbError extends Error {}

type Mat4 = Float64Array;

function identity(): Mat4 {
  const m = new Float64Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

/** Column-major multiply (glTF convention): a × b. */
function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Float64Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      out[c * 4 + r] = s;
    }
  }
  return out;
}

function fromTRS(t: number[] = [0, 0, 0], q: number[] = [0, 0, 0, 1], s: number[] = [1, 1, 1]): Mat4 {
  const [x, y, z, w] = q;
  const m = new Float64Array(16);
  m[0] = (1 - 2 * (y * y + z * z)) * s[0];
  m[1] = 2 * (x * y + z * w) * s[0];
  m[2] = 2 * (x * z - y * w) * s[0];
  m[4] = 2 * (x * y - z * w) * s[1];
  m[5] = (1 - 2 * (x * x + z * z)) * s[1];
  m[6] = 2 * (y * z + x * w) * s[1];
  m[8] = 2 * (x * z + y * w) * s[2];
  m[9] = 2 * (y * z - x * w) * s[2];
  m[10] = (1 - 2 * (x * x + y * y)) * s[2];
  m[12] = t[0];
  m[13] = t[1];
  m[14] = t[2];
  m[15] = 1;
  return m;
}

const COMPONENTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

export function parseGlb(bytes: Uint8Array): ParsedModel {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 20 || dv.getUint32(0, true) !== GLB_MAGIC) throw new GlbError("Not a .glb file.");
  if (dv.getUint32(4, true) !== 2) throw new GlbError("Only glTF 2.0 .glb files are supported.");

  let json: Json | null = null;
  let bin: Uint8Array | null = null;
  let offset = 12;
  while (offset + 8 <= bytes.byteLength) {
    const length = dv.getUint32(offset, true);
    const type = dv.getUint32(offset + 4, true);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === CHUNK_JSON) json = JSON.parse(new TextDecoder().decode(data)) as Json;
    else if (type === CHUNK_BIN && !bin) bin = data;
    offset += 8 + length;
  }
  if (!json) throw new GlbError("The .glb has no JSON chunk.");

  const accessors = (json.accessors as Json[] | undefined) ?? [];
  const views = (json.bufferViews as Json[] | undefined) ?? [];
  const materials = (json.materials as Json[] | undefined) ?? [];
  const meshes = (json.meshes as Json[] | undefined) ?? [];
  const nodes = (json.nodes as Json[] | undefined) ?? [];

  function readAccessor(index: number): { values: Float64Array; size: number } {
    const acc = accessors[index];
    if (!acc || acc.bufferView === undefined || !bin) throw new GlbError(`Accessor ${index} has no data (external or sparse buffers aren't supported).`);
    const view = views[acc.bufferView as number];
    const size = COMPONENTS[acc.type as string] ?? 1;
    const count = acc.count as number;
    const componentType = acc.componentType as number;
    const componentBytes = componentType === FLOAT || componentType === UNSIGNED_INT ? 4 : componentType === UNSIGNED_SHORT || componentType === 5122 ? 2 : 1;
    const stride = (view.byteStride as number | undefined) ?? size * componentBytes;
    const base = ((view.byteOffset as number | undefined) ?? 0) + ((acc.byteOffset as number | undefined) ?? 0);
    const bdv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
    const normalized = acc.normalized === true;
    const values = new Float64Array(count * size);
    for (let i = 0; i < count; i++) {
      for (let c = 0; c < size; c++) {
        const at = base + i * stride + c * componentBytes;
        let v: number;
        switch (componentType) {
          case FLOAT:
            v = bdv.getFloat32(at, true);
            break;
          case UNSIGNED_INT:
            v = bdv.getUint32(at, true);
            break;
          case UNSIGNED_SHORT:
            v = bdv.getUint16(at, true);
            if (normalized) v /= 65535;
            break;
          case 5122:
            v = bdv.getInt16(at, true);
            if (normalized) v = Math.max(v / 32767, -1);
            break;
          case UNSIGNED_BYTE:
            v = bdv.getUint8(at);
            if (normalized) v /= 255;
            break;
          default:
            v = bdv.getInt8(at);
            if (normalized) v = Math.max(v / 127, -1);
        }
        values[i * size + c] = v;
      }
    }
    return { values, size };
  }

  const primitives: ParsedPrimitive[] = [];
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];

  function visit(nodeIndex: number, parent: Mat4, depth: number): void {
    const node = nodes[nodeIndex];
    if (!node || depth > 64) return;
    const local = Array.isArray(node.matrix)
      ? Float64Array.from(node.matrix as number[])
      : fromTRS(node.translation as number[] | undefined, node.rotation as number[] | undefined, node.scale as number[] | undefined);
    const world = multiply(parent, local);
    if (typeof node.mesh === "number") {
      for (const prim of ((meshes[node.mesh]?.primitives as Json[] | undefined) ?? [])) {
        if ((prim.mode ?? 4) !== 4) continue;
        const attrs = prim.attributes as Record<string, number>;
        if (attrs.POSITION === undefined) continue;
        const pos = readAccessor(attrs.POSITION).values;
        const vertexCount = pos.length / 3;
        const positions = new Float32Array(pos.length);
        for (let i = 0; i < vertexCount; i++) {
          const x = pos[i * 3];
          const y = pos[i * 3 + 1];
          const z = pos[i * 3 + 2];
          for (let c = 0; c < 3; c++) {
            const v = world[c] * x + world[4 + c] * y + world[8 + c] * z + world[12 + c];
            positions[i * 3 + c] = v;
            if (v < min[c]) min[c] = v;
            if (v > max[c]) max[c] = v;
          }
        }
        const indices =
          prim.indices !== undefined ? Uint32Array.from(readAccessor(prim.indices as number).values) : Uint32Array.from({ length: vertexCount }, (_, i) => i);
        const material = typeof prim.material === "number" ? materials[prim.material] : undefined;
        const pbr = (material?.pbrMetallicRoughness as Json | undefined) ?? {};
        const color = ((pbr.baseColorFactor as number[] | undefined) ?? [1, 1, 1, 1]) as Rgba;
        let vertexColors: Float32Array | undefined;
        if (attrs.COLOR_0 !== undefined) {
          const { values, size } = readAccessor(attrs.COLOR_0);
          vertexColors = new Float32Array(vertexCount * 3);
          for (let i = 0; i < vertexCount; i++) for (let c = 0; c < 3; c++) vertexColors[i * 3 + c] = values[i * size + c];
        }
        primitives.push({ positions, indices, color, ...(vertexColors ? { vertexColors } : {}) });
      }
    }
    for (const child of (node.children as number[] | undefined) ?? []) visit(child, world, depth + 1);
  }

  const scenes = (json.scenes as Json[] | undefined) ?? [];
  const scene = scenes[(json.scene as number | undefined) ?? 0];
  const roots = (scene?.nodes as number[] | undefined) ?? nodes.map((_, i) => i).filter((i) => !nodes.some((n) => ((n.children as number[] | undefined) ?? []).includes(i)));
  for (const root of roots) visit(root, identity(), 0);

  if (primitives.length === 0) return { primitives, bounds: { min: [0, 0, 0], max: [0, 0, 0] } };
  return { primitives, bounds: { min, max } };
}

// ---- Geometry helpers for code-generated models ----

export interface MeshBuilder {
  positions: number[];
  normals: number[];
  indices: number[];
}

export function newMeshBuilder(): MeshBuilder {
  return { positions: [], normals: [], indices: [] };
}

/** Adds an axis-aligned box centered at (cx, cy, cz). */
export function addBox(b: MeshBuilder, cx: number, cy: number, cz: number, sx: number, sy: number, sz: number): void {
  const hx = sx / 2;
  const hy = sy / 2;
  const hz = sz / 2;
  const faces: Array<{ n: Vec3; corners: Vec3[] }> = [
    { n: [1, 0, 0], corners: [[hx, -hy, hz], [hx, -hy, -hz], [hx, hy, -hz], [hx, hy, hz]] },
    { n: [-1, 0, 0], corners: [[-hx, -hy, -hz], [-hx, -hy, hz], [-hx, hy, hz], [-hx, hy, -hz]] },
    { n: [0, 1, 0], corners: [[-hx, hy, hz], [hx, hy, hz], [hx, hy, -hz], [-hx, hy, -hz]] },
    { n: [0, -1, 0], corners: [[-hx, -hy, -hz], [hx, -hy, -hz], [hx, -hy, hz], [-hx, -hy, hz]] },
    { n: [0, 0, 1], corners: [[-hx, -hy, hz], [hx, -hy, hz], [hx, hy, hz], [-hx, hy, hz]] },
    { n: [0, 0, -1], corners: [[hx, -hy, -hz], [-hx, -hy, -hz], [-hx, hy, -hz], [hx, hy, -hz]] },
  ];
  for (const f of faces) {
    const base = b.positions.length / 3;
    for (const c of f.corners) {
      b.positions.push(cx + c[0], cy + c[1], cz + c[2]);
      b.normals.push(...f.n);
    }
    b.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
}

/** Adds a cone (or a cylinder when topRadius > 0) along +y, base centered at (cx, y0, cz). */
export function addCone(
  b: MeshBuilder,
  cx: number,
  y0: number,
  cz: number,
  radius: number,
  height: number,
  segments = 12,
  topRadius = 0,
): void {
  const slope = (radius - topRadius) / height;
  for (let i = 0; i < segments; i++) {
    const a0 = (i / segments) * Math.PI * 2;
    const a1 = ((i + 1) / segments) * Math.PI * 2;
    const base = b.positions.length / 3;
    const pts: Array<[number, number, number, number]> = [
      [a0, radius, y0, 0],
      [a1, radius, y0, 0],
      [a1, topRadius, y0 + height, 0],
      [a0, topRadius, y0 + height, 0],
    ];
    for (const [a, r, y] of pts) {
      b.positions.push(cx + Math.cos(a) * r, y, cz - Math.sin(a) * r);
      const len = Math.hypot(1, slope);
      b.normals.push(Math.cos(a) / len, slope / len, -Math.sin(a) / len);
    }
    b.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  // Bottom cap.
  const center = b.positions.length / 3;
  b.positions.push(cx, y0, cz);
  b.normals.push(0, -1, 0);
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    b.positions.push(cx + Math.cos(a) * radius, y0, cz - Math.sin(a) * radius);
    b.normals.push(0, -1, 0);
  }
  for (let i = 0; i < segments; i++) b.indices.push(center, center + 2 + i, center + 1 + i);
}

/** A low-poly sphere (UV sphere) centered at (cx, cy, cz). */
export function addSphere(b: MeshBuilder, cx: number, cy: number, cz: number, radius: number, rings = 6, segments = 10, squashY = 1): void {
  const base = b.positions.length / 3;
  for (let r = 0; r <= rings; r++) {
    const phi = (r / rings) * Math.PI;
    for (let s = 0; s <= segments; s++) {
      const theta = (s / segments) * Math.PI * 2;
      const nx = Math.sin(phi) * Math.cos(theta);
      const ny = Math.cos(phi);
      const nz = -Math.sin(phi) * Math.sin(theta);
      b.positions.push(cx + nx * radius, cy + ny * radius * squashY, cz + nz * radius);
      b.normals.push(nx, ny, nz);
    }
  }
  for (let r = 0; r < rings; r++) {
    for (let s = 0; s < segments; s++) {
      const a = base + r * (segments + 1) + s;
      const c = a + segments + 1;
      b.indices.push(a, c, a + 1, a + 1, c, c + 1);
    }
  }
}

/** Adds a gable roof (triangular prism) along x, ridge at y0 + height. */
export function addGableRoof(b: MeshBuilder, cx: number, y0: number, cz: number, sx: number, sz: number, height: number): void {
  const hx = sx / 2;
  const hz = sz / 2;
  const ridge: Vec3[] = [
    [-hx, height, 0],
    [hx, height, 0],
  ];
  const slopeLen = Math.hypot(hz, height);
  const quads: Array<{ n: Vec3; corners: Vec3[] }> = [
    { n: [0, hz / slopeLen, height / slopeLen], corners: [[-hx, 0, hz], [hx, 0, hz], ridge[1], ridge[0]] },
    { n: [0, hz / slopeLen, -height / slopeLen], corners: [[hx, 0, -hz], [-hx, 0, -hz], ridge[0], ridge[1]] },
  ];
  for (const q of quads) {
    const base = b.positions.length / 3;
    for (const c of q.corners) {
      b.positions.push(cx + c[0], y0 + c[1], cz + c[2]);
      b.normals.push(...q.n);
    }
    b.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  const gables: Array<{ n: Vec3; corners: Vec3[] }> = [
    { n: [1, 0, 0], corners: [[hx, 0, hz], [hx, 0, -hz], [hx, height, 0]] },
    { n: [-1, 0, 0], corners: [[-hx, 0, -hz], [-hx, 0, hz], [-hx, height, 0]] },
  ];
  for (const g of gables) {
    const base = b.positions.length / 3;
    for (const c of g.corners) {
      b.positions.push(cx + c[0], y0 + c[1], cz + c[2]);
      b.normals.push(...g.n);
    }
    b.indices.push(base, base + 1, base + 2);
  }
}

export function builderToPrimitive(b: MeshBuilder, color: Rgba, extra: Partial<GlbPrimitiveInput> = {}): GlbPrimitiveInput {
  return {
    positions: Float32Array.from(b.positions),
    normals: Float32Array.from(b.normals),
    indices: Uint32Array.from(b.indices),
    color,
    ...extra,
  };
}

/** sRGB hex ("#rrggbb") → linear RGBA for glTF baseColorFactor. */
export function hexToLinear(hex: string, alpha = 1): Rgba {
  const n = parseInt(hex.replace("#", ""), 16);
  const toLinear = (v: number) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return [toLinear((n >> 16) & 255), toLinear((n >> 8) & 255), toLinear(n & 255), alpha];
}

/** Linear 0-1 → sRGB 0-255. */
export function linearToSrgb255(v: number): number {
  const c = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(c * 255)));
}
