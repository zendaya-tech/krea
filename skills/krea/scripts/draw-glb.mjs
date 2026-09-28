// Dependency-free writer of simple low-poly 3D models (.glb) for Krea's 3D maps.
//
//   import { writeGlb, box, cone, cylinder, sphere, roof } from "./draw-glb.mjs";
//   writeGlb("pine.glb", [
//     { color: "#6b4a2b", parts: [cylinder(0, 0, 0, 0.18, 1.2)] },           // trunk
//     { color: "#2f6b3a", parts: [cone(0, 0.9, 0, 1.1, 1.6), cone(0, 1.8, 0, 0.8, 1.4)] },
//   ]);
//
// Units are meters, y is up, the model stands on y = 0 and is centered on x/z = 0
// (Krea places that origin on the terrain). Each group becomes one material.
// Run directly for a demo:  node draw-glb.mjs out-folder
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const part = () => ({ positions: [], normals: [], indices: [] });

function quad(p, corners, n) {
  const base = p.positions.length / 3;
  for (const c of corners) {
    p.positions.push(...c);
    p.normals.push(...n);
  }
  p.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
}

/** Axis-aligned box centered at (cx, cy, cz) with sizes sx, sy, sz. */
export function box(cx, cy, cz, sx, sy, sz) {
  const p = part();
  const [x0, x1, y0, y1, z0, z1] = [cx - sx / 2, cx + sx / 2, cy - sy / 2, cy + sy / 2, cz - sz / 2, cz + sz / 2];
  quad(p, [[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]], [1, 0, 0]);
  quad(p, [[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]], [-1, 0, 0]);
  quad(p, [[x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]], [0, 1, 0]);
  quad(p, [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]], [0, -1, 0]);
  quad(p, [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], [0, 0, 1]);
  quad(p, [[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]], [0, 0, -1]);
  return p;
}

/** Cone (topRadius 0) or truncated cone along +y, base centered at (cx, y0, cz). */
export function cone(cx, y0, cz, radius, height, segments = 12, topRadius = 0) {
  const p = part();
  const slope = (radius - topRadius) / height;
  const len = Math.hypot(1, slope);
  for (let i = 0; i < segments; i++) {
    const a0 = (i / segments) * Math.PI * 2;
    const a1 = ((i + 1) / segments) * Math.PI * 2;
    const base = p.positions.length / 3;
    for (const [a, r, y] of [[a0, radius, y0], [a1, radius, y0], [a1, topRadius, y0 + height], [a0, topRadius, y0 + height]]) {
      p.positions.push(cx + Math.cos(a) * r, y, cz - Math.sin(a) * r);
      p.normals.push(Math.cos(a) / len, slope / len, -Math.sin(a) / len);
    }
    p.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  const center = p.positions.length / 3;
  p.positions.push(cx, y0, cz);
  p.normals.push(0, -1, 0);
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    p.positions.push(cx + Math.cos(a) * radius, y0, cz - Math.sin(a) * radius);
    p.normals.push(0, -1, 0);
  }
  for (let i = 0; i < segments; i++) p.indices.push(center, center + 2 + i, center + 1 + i);
  return p;
}

export function cylinder(cx, y0, cz, radius, height, segments = 10) {
  return cone(cx, y0, cz, radius, height, segments, radius * 0.999);
}

/** Sphere (squashY < 1 flattens it: rocks, bushes) centered at (cx, cy, cz). */
export function sphere(cx, cy, cz, radius, squashY = 1, rings = 6, segments = 10) {
  const p = part();
  for (let r = 0; r <= rings; r++) {
    const phi = (r / rings) * Math.PI;
    for (let s = 0; s <= segments; s++) {
      const t = (s / segments) * Math.PI * 2;
      const n = [Math.sin(phi) * Math.cos(t), Math.cos(phi), -Math.sin(phi) * Math.sin(t)];
      p.positions.push(cx + n[0] * radius, cy + n[1] * radius * squashY, cz + n[2] * radius);
      p.normals.push(...n);
    }
  }
  for (let r = 0; r < rings; r++) {
    for (let s = 0; s < segments; s++) {
      const a = r * (segments + 1) + s;
      const c = a + segments + 1;
      p.indices.push(a, c, a + 1, a + 1, c, c + 1);
    }
  }
  return p;
}

/** Gable roof (ridge along x) sitting at height y0, footprint sx × sz, ridge `height` above. */
export function roof(cx, y0, cz, sx, sz, height) {
  const p = part();
  const [hx, hz] = [sx / 2, sz / 2];
  const l = Math.hypot(hz, height);
  const at = (x, y, z) => [cx + x, y0 + y, cz + z];
  quad(p, [at(-hx, 0, hz), at(hx, 0, hz), at(hx, height, 0), at(-hx, height, 0)], [0, hz / l, height / l]);
  quad(p, [at(hx, 0, -hz), at(-hx, 0, -hz), at(-hx, height, 0), at(hx, height, 0)], [0, hz / l, -height / l]);
  for (const [sign, n] of [[1, [1, 0, 0]], [-1, [-1, 0, 0]]]) {
    const base = p.positions.length / 3;
    const tri = sign > 0 ? [at(hx, 0, hz), at(hx, 0, -hz), at(hx, height, 0)] : [at(-hx, 0, -hz), at(-hx, 0, hz), at(-hx, height, 0)];
    for (const c of tri) {
      p.positions.push(...c);
      p.normals.push(...n);
    }
    p.indices.push(base, base + 1, base + 2);
  }
  return p;
}

function srgbHexToLinear(hex) {
  const n = parseInt(hex.replace("#", ""), 16);
  const lin = (v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return [lin((n >> 16) & 255), lin((n >> 8) & 255), lin(n & 255), 1];
}

/** Encodes groups [{ color: "#rrggbb", parts: [...] }] as a binary glTF. */
export function encodeGlb(groups) {
  const chunks = [];
  let byteLength = 0;
  const bufferViews = [];
  const accessors = [];
  const materials = [];
  const primitives = [];
  const addAccessor = (array, type, target, bounds) => {
    const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
    const pad = (4 - (bytes.length % 4)) % 4;
    chunks.push(bytes, new Uint8Array(pad));
    bufferViews.push({ buffer: 0, byteOffset: byteLength, byteLength: bytes.length, target });
    byteLength += bytes.length + pad;
    const accessor = { bufferView: bufferViews.length - 1, componentType: array instanceof Float32Array ? 5126 : 5125, count: array.length / (type === "VEC3" ? 3 : 1), type };
    if (bounds) {
      const min = [Infinity, Infinity, Infinity];
      const max = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < array.length; i += 3) for (let c = 0; c < 3; c++) {
        min[c] = Math.min(min[c], array[i + c]);
        max[c] = Math.max(max[c], array[i + c]);
      }
      Object.assign(accessor, { min, max });
    }
    accessors.push(accessor);
    return accessors.length - 1;
  };
  for (const group of groups) {
    const merged = part();
    for (const p of group.parts) {
      const offset = merged.positions.length / 3;
      merged.positions.push(...p.positions);
      merged.normals.push(...p.normals);
      merged.indices.push(...p.indices.map((i) => i + offset));
    }
    if (merged.indices.length === 0) continue;
    materials.push({ pbrMetallicRoughness: { baseColorFactor: srgbHexToLinear(group.color ?? "#cccccc"), metallicFactor: 0, roughnessFactor: 0.9 } });
    primitives.push({
      attributes: {
        POSITION: addAccessor(Float32Array.from(merged.positions), "VEC3", 34962, true),
        NORMAL: addAccessor(Float32Array.from(merged.normals), "VEC3", 34962, false),
      },
      indices: addAccessor(Uint32Array.from(merged.indices), "SCALAR", 34963, false),
      material: materials.length - 1,
      mode: 4,
    });
  }
  const gltf = {
    asset: { version: "2.0", generator: "krea-skill draw-glb" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives }],
    materials,
    accessors,
    bufferViews,
    buffers: [{ byteLength }],
  };
  let json = Buffer.from(JSON.stringify(gltf));
  json = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)]);
  const bin = Buffer.concat(chunks);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + json.length + 8 + bin.length, 8);
  const chunkHeader = (len, type) => {
    const b = Buffer.alloc(8);
    b.writeUInt32LE(len, 0);
    b.writeUInt32LE(type, 4);
    return b;
  };
  return Buffer.concat([header, chunkHeader(json.length, 0x4e4f534a), json, chunkHeader(bin.length, 0x004e4942), bin]);
}

export function writeGlb(file, groups) {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, encodeGlb(groups));
  return file;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = process.argv[2] ?? ".";
  writeGlb(path.join(out, "pine.glb"), [
    { color: "#6b4a2b", parts: [cylinder(0, 0, 0, 0.16, 1.2)] },
    { color: "#2f6b3a", parts: [cone(0, 0.9, 0, 1.1, 1.6), cone(0, 1.8, 0, 0.85, 1.4), cone(0, 2.6, 0, 0.55, 1.2)] },
  ]);
  writeGlb(path.join(out, "hut.glb"), [
    { color: "#d8c29a", parts: [box(0, 1.25, 0, 4, 2.5, 3)] },
    { color: "#9a3b2e", parts: [roof(0, 2.5, 0, 4.4, 3.4, 1.6)] },
    { color: "#5a3b22", parts: [box(0, 0.8, 1.51, 0.9, 1.6, 0.04)] },
  ]);
  writeGlb(path.join(out, "rock.glb"), [{ color: "#8a8680", parts: [sphere(0, 0.35, 0, 0.7, 0.65)] }]);
  console.log(`Wrote pine.glb, hut.glb and rock.glb to ${path.resolve(out)}`);
}
