import { MAX_TERRAIN_LAYERS, type TerrainData, type TerrainInfo, type TerrainLayer } from "./map-types";

/**
 * Pure terrain math: sampling, brushes, procedural generation, auto-painting.
 * Brush functions mutate the arrays they're given and return the region they
 * touched, so the editor can apply them live to a working copy while core
 * operations apply them to fresh copies (see map-operations.ts).
 */

export const SPLAT_CHANNELS = 4;

/** A rectangle of heightmap samples: [x0, x0 + w) × [z0, z0 + h). */
export interface TerrainRegion {
  x0: number;
  z0: number;
  w: number;
  h: number;
}

export function fullRegion(t: TerrainInfo): TerrainRegion {
  return { x0: 0, z0: 0, w: t.resolution, h: t.resolution };
}

export function unionRegion(a: TerrainRegion | null, b: TerrainRegion | null): TerrainRegion | null {
  if (!a) return b;
  if (!b) return a;
  const x0 = Math.min(a.x0, b.x0);
  const z0 = Math.min(a.z0, b.z0);
  return { x0, z0, w: Math.max(a.x0 + a.w, b.x0 + b.w) - x0, h: Math.max(a.z0 + a.h, b.z0 + b.h) - z0 };
}

/** World distance between neighboring samples. */
export function sampleSpacing(t: TerrainInfo): { dx: number; dz: number } {
  return { dx: t.size.width / (t.resolution - 1), dz: t.size.depth / (t.resolution - 1) };
}

export function isInsideTerrain(t: TerrainInfo, x: number, z: number): boolean {
  return x >= 0 && z >= 0 && x <= t.size.width && z <= t.size.depth;
}

export function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  const n = m ? parseInt(m[1], 16) : 0x808080;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function isHexColor(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);
}

/** A flat terrain; splat weight goes entirely to the first layer. */
export function createTerrain(params: {
  resolution: number;
  width: number;
  depth: number;
  layers?: TerrainLayer[];
  baseHeight?: number;
  waterLevel?: number | null;
  detailLayers?: TerrainData["detailLayers"];
}): TerrainData {
  const res = params.resolution;
  const heights = new Float32Array(res * res).fill(params.baseHeight ?? 0);
  const splat = new Uint8Array(res * res * SPLAT_CHANNELS);
  for (let i = 0; i < res * res; i++) splat[i * SPLAT_CHANNELS] = 255;
  return {
    resolution: res,
    size: { width: params.width, depth: params.depth },
    layers: params.layers ?? [],
    waterLevel: params.waterLevel ?? null,
    detailLayers: params.detailLayers ?? [],
    heights,
    splat,
    details: new Uint8Array(res * res * SPLAT_CHANNELS),
  };
}

/** Bilinear height at world (x, z), clamped to the terrain. */
export function heightAt(t: TerrainInfo & { heights: Float32Array }, x: number, z: number): number {
  const res = t.resolution;
  const { dx, dz } = sampleSpacing(t);
  const gx = Math.min(Math.max(x / dx, 0), res - 1);
  const gz = Math.min(Math.max(z / dz, 0), res - 1);
  const x0 = Math.min(Math.floor(gx), res - 2);
  const z0 = Math.min(Math.floor(gz), res - 2);
  const fx = gx - x0;
  const fz = gz - z0;
  const h = t.heights;
  const a = h[z0 * res + x0];
  const b = h[z0 * res + x0 + 1];
  const c = h[(z0 + 1) * res + x0];
  const d = h[(z0 + 1) * res + x0 + 1];
  return (a * (1 - fx) + b * fx) * (1 - fz) + (c * (1 - fx) + d * fx) * fz;
}

/** Surface normal (unit vector, y up) at world (x, z). */
export function normalAt(t: TerrainInfo & { heights: Float32Array }, x: number, z: number): { x: number; y: number; z: number } {
  const { dx, dz } = sampleSpacing(t);
  const hl = heightAt(t, x - dx, z);
  const hr = heightAt(t, x + dx, z);
  const hd = heightAt(t, x, z - dz);
  const hu = heightAt(t, x, z + dz);
  const nx = (hl - hr) / (2 * dx);
  const nz = (hd - hu) / (2 * dz);
  const len = Math.hypot(nx, 1, nz);
  return { x: nx / len, y: 1 / len, z: nz / len };
}

/** Steepness in degrees (0 = flat, 90 = vertical) at world (x, z). */
export function slopeAt(t: TerrainInfo & { heights: Float32Array }, x: number, z: number): number {
  return (Math.acos(Math.min(1, normalAt(t, x, z).y)) * 180) / Math.PI;
}

/** Normalized splat weights (sum 1) of the sample nearest to (x, z). */
export function splatWeightsAt(t: TerrainData, x: number, z: number): number[] {
  const { dx, dz } = sampleSpacing(t);
  const ix = Math.min(Math.max(Math.round(x / dx), 0), t.resolution - 1);
  const iz = Math.min(Math.max(Math.round(z / dz), 0), t.resolution - 1);
  const base = (iz * t.resolution + ix) * SPLAT_CHANNELS;
  const w = Array.from(t.splat.subarray(base, base + SPLAT_CHANNELS));
  const sum = w.reduce((a, b) => a + b, 0);
  return sum > 0 ? w.map((v) => v / sum) : [1, 0, 0, 0];
}

/** Samples within `radius` meters of (x, z), with a smooth falloff (1 at the center, 0 at the edge). */
function forEachInBrush(
  t: TerrainInfo,
  x: number,
  z: number,
  radius: number,
  visit: (index: number, falloff: number, ix: number, iz: number) => void,
): TerrainRegion | null {
  if (!(radius > 0)) return null;
  const res = t.resolution;
  const { dx, dz } = sampleSpacing(t);
  const ix0 = Math.max(0, Math.floor((x - radius) / dx));
  const ix1 = Math.min(res - 1, Math.ceil((x + radius) / dx));
  const iz0 = Math.max(0, Math.floor((z - radius) / dz));
  const iz1 = Math.min(res - 1, Math.ceil((z + radius) / dz));
  if (ix0 > ix1 || iz0 > iz1) return null;
  let touched = false;
  for (let iz = iz0; iz <= iz1; iz++) {
    for (let ix = ix0; ix <= ix1; ix++) {
      const d = Math.hypot(ix * dx - x, iz * dz - z) / radius;
      if (d >= 1) continue;
      touched = true;
      visit(iz * res + ix, 0.5 * (1 + Math.cos(Math.PI * d)), ix, iz);
    }
  }
  return touched ? { x0: ix0, z0: iz0, w: ix1 - ix0 + 1, h: iz1 - iz0 + 1 } : null;
}

export type SculptMode = "raise" | "lower" | "smooth" | "flatten";

/**
 * One brush dab. raise/lower move by up to `strength` meters at the center;
 * smooth/flatten blend toward the neighbors' average / `height` by
 * `strength` (0-1). Flatten without `height` uses the height at the center.
 */
export function sculptDab(
  t: TerrainInfo,
  heights: Float32Array,
  p: { x: number; z: number; radius: number; strength: number; mode: SculptMode; height?: number },
): TerrainRegion | null {
  const res = t.resolution;
  const target = p.height ?? heightAt({ ...t, heights }, p.x, p.z);
  const snapshot = p.mode === "smooth" ? heights.slice() : null;
  const blend = Math.min(Math.max(p.strength, 0), 1);
  return forEachInBrush(t, p.x, p.z, p.radius, (i, f, ix, iz) => {
    switch (p.mode) {
      case "raise":
        heights[i] += p.strength * f;
        break;
      case "lower":
        heights[i] -= p.strength * f;
        break;
      case "flatten":
        heights[i] += (target - heights[i]) * blend * f;
        break;
      case "smooth": {
        let sum = 0;
        let n = 0;
        for (let oz = -1; oz <= 1; oz++) {
          for (let ox = -1; ox <= 1; ox++) {
            const nx = ix + ox;
            const nz = iz + oz;
            if (nx < 0 || nz < 0 || nx >= res || nz >= res) continue;
            sum += snapshot![nz * res + nx];
            n++;
          }
        }
        heights[i] += (sum / n - heights[i]) * blend * f;
        break;
      }
    }
  });
}

/** Adds weight to one layer (strength 0-1 at the center), scaling the others so weights still sum to 255. */
export function paintDab(
  t: TerrainInfo,
  splat: Uint8Array,
  p: { x: number; z: number; radius: number; strength: number; layerIndex: number },
): TerrainRegion | null {
  const layer = p.layerIndex;
  if (layer < 0 || layer >= SPLAT_CHANNELS) return null;
  const amount = Math.min(Math.max(p.strength, 0), 1);
  return forEachInBrush(t, p.x, p.z, p.radius, (i, f) => {
    const base = i * SPLAT_CHANNELS;
    const w = [0, 1, 2, 3].map((c) => splat[base + c] / 255);
    const sum = w.reduce((a, b) => a + b, 0) || 1;
    for (let c = 0; c < SPLAT_CHANNELS; c++) w[c] /= sum;
    const target = w[layer] + (1 - w[layer]) * amount * f;
    const others = 1 - w[layer];
    const scale = others > 1e-6 ? (1 - target) / others : 0;
    for (let c = 0; c < SPLAT_CHANNELS; c++) w[c] = c === layer ? target : w[c] * scale;
    writeWeights(splat, base, w);
  });
}

/** Writes normalized weights as bytes that sum to exactly 255. */
function writeWeights(splat: Uint8Array, base: number, w: number[]): void {
  const bytes = w.map((v) => Math.round(v * 255));
  const diff = 255 - bytes.reduce((a, b) => a + b, 0);
  if (diff !== 0) {
    const max = bytes.indexOf(Math.max(...bytes));
    bytes[max] = Math.max(0, bytes[max] + diff);
  }
  for (let c = 0; c < SPLAT_CHANNELS; c++) splat[base + c] = bytes[c];
}

/** Sets every sample inside a world rectangle to `height`. */
export function setHeightRect(
  t: TerrainInfo,
  heights: Float32Array,
  p: { x: number; z: number; width: number; depth: number; height: number },
): TerrainRegion | null {
  const res = t.resolution;
  const { dx, dz } = sampleSpacing(t);
  const ix0 = Math.max(0, Math.ceil(p.x / dx));
  const ix1 = Math.min(res - 1, Math.floor((p.x + p.width) / dx));
  const iz0 = Math.max(0, Math.ceil(p.z / dz));
  const iz1 = Math.min(res - 1, Math.floor((p.z + p.depth) / dz));
  if (ix0 > ix1 || iz0 > iz1) return null;
  for (let iz = iz0; iz <= iz1; iz++) for (let ix = ix0; ix <= ix1; ix++) heights[iz * res + ix] = p.height;
  return { x0: ix0, z0: iz0, w: ix1 - ix0 + 1, h: iz1 - iz0 + 1 };
}

// ---- Procedural generation ----

/** Deterministic PRNG (mulberry32) for generation and scattering. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0 || 0x9e3779b9;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash2(ix: number, iz: number, seed: number): number {
  let h = Math.imul(ix, 374761393) ^ Math.imul(iz, 668265263) ^ Math.imul(seed, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Smooth value noise in [0, 1] (unit cells), deterministic for a seed. */
export function valueNoise(x: number, z: number, seed: number): number {
  const x0 = Math.floor(x);
  const z0 = Math.floor(z);
  const fx = x - x0;
  const fz = z - z0;
  const sx = fx * fx * (3 - 2 * fx);
  const sz = fz * fz * (3 - 2 * fz);
  const a = hash2(x0, z0, seed);
  const b = hash2(x0 + 1, z0, seed);
  const c = hash2(x0, z0 + 1, seed);
  const d = hash2(x0 + 1, z0 + 1, seed);
  return (a * (1 - sx) + b * sx) * (1 - sz) + (c * (1 - sx) + d * sx) * sz;
}

export interface GenerateParams {
  seed: number;
  /** Height difference between the lowest and highest points, in meters. */
  amplitude: number;
  /** Size of the main hills, in meters. */
  featureSize: number;
  /** Detail layers (1 = smooth, 5+ = rugged). */
  octaves: number;
  /** Height added everywhere. */
  baseHeight: number;
  /** "replace" the terrain, or "add" the noise on top of it. */
  mode: "replace" | "add";
  /** Lower the edges so the land forms an island (combine with a water level). */
  island: boolean;
}

/** Fractal value noise terrain (hills, mountains, islands). */
export function generateHeights(t: TerrainInfo, heights: Float32Array, p: GenerateParams): TerrainRegion {
  const res = t.resolution;
  const { dx, dz } = sampleSpacing(t);
  const octaves = Math.max(1, Math.min(8, Math.round(p.octaves)));
  const cx = t.size.width / 2;
  const cz = t.size.depth / 2;
  const maxR = Math.min(cx, cz);
  for (let iz = 0; iz < res; iz++) {
    for (let ix = 0; ix < res; ix++) {
      const wx = ix * dx;
      const wz = iz * dz;
      let n = 0;
      let amp = 1;
      let freq = 1 / Math.max(p.featureSize, 1e-3);
      let norm = 0;
      for (let o = 0; o < octaves; o++) {
        n += valueNoise(wx * freq, wz * freq, p.seed + o * 1013) * amp;
        norm += amp;
        amp *= 0.5;
        freq *= 2;
      }
      n /= norm;
      if (p.island) {
        const r = Math.hypot(wx - cx, wz - cz) / maxR;
        const edge = Math.min(Math.max((r - 0.45) / 0.5, 0), 1);
        n = n * (1 - edge * edge * (3 - 2 * edge)) - 0.35 * edge;
      }
      const h = p.baseHeight + p.amplitude * n;
      const i = iz * res + ix;
      heights[i] = p.mode === "add" ? heights[i] + h : h;
    }
  }
  return fullRegion(t);
}

export interface AutoPaintRule {
  layerIndex: number;
  minHeight?: number;
  maxHeight?: number;
  /** Degrees. */
  minSlope?: number;
  maxSlope?: number;
}

/**
 * Paints each sample with the first rule it matches (by height and slope),
 * then softens the borders between layers. Samples matching no rule keep
 * their weights.
 */
export function autoPaint(t: TerrainInfo, heights: Float32Array, splat: Uint8Array, rules: AutoPaintRule[], blend = true): TerrainRegion {
  const res = t.resolution;
  const { dx, dz } = sampleSpacing(t);
  const terrain = { ...t, heights };
  for (let iz = 0; iz < res; iz++) {
    for (let ix = 0; ix < res; ix++) {
      const i = iz * res + ix;
      const h = heights[i];
      const slope = slopeAt(terrain, ix * dx, iz * dz);
      const rule = rules.find(
        (r) =>
          (r.minHeight === undefined || h >= r.minHeight) &&
          (r.maxHeight === undefined || h <= r.maxHeight) &&
          (r.minSlope === undefined || slope >= r.minSlope) &&
          (r.maxSlope === undefined || slope <= r.maxSlope),
      );
      if (!rule) continue;
      for (let c = 0; c < SPLAT_CHANNELS; c++) splat[i * SPLAT_CHANNELS + c] = c === rule.layerIndex ? 255 : 0;
    }
  }
  if (blend) {
    const source = splat.slice();
    for (let iz = 0; iz < res; iz++) {
      for (let ix = 0; ix < res; ix++) {
        const w = [0, 0, 0, 0];
        let n = 0;
        for (let oz = -1; oz <= 1; oz++) {
          for (let ox = -1; ox <= 1; ox++) {
            const nx = ix + ox;
            const nz = iz + oz;
            if (nx < 0 || nz < 0 || nx >= res || nz >= res) continue;
            const b = (nz * res + nx) * SPLAT_CHANNELS;
            for (let c = 0; c < SPLAT_CHANNELS; c++) w[c] += source[b + c];
            n++;
          }
        }
        const sum = w.reduce((a, b) => a + b, 0) || 1;
        writeWeights(splat, (iz * res + ix) * SPLAT_CHANNELS, w.map((v) => v / sum));
      }
    }
  }
  return fullRegion(t);
}

// ---- Layers ----

/** Splat after removing layer `index`: later channels shift down; empty samples fall back to layer 0. */
export function removeSplatChannel(splat: Uint8Array, index: number): Uint8Array {
  const out = new Uint8Array(splat.length);
  const count = splat.length / SPLAT_CHANNELS;
  for (let i = 0; i < count; i++) {
    const base = i * SPLAT_CHANNELS;
    const w = [0, 1, 2, 3].filter((c) => c !== index).map((c) => splat[base + c] / 255);
    w.push(0);
    const sum = w.reduce((a, b) => a + b, 0);
    writeWeights(out, base, sum > 0 ? w.map((v) => v / sum) : [1, 0, 0, 0]);
  }
  return out;
}

// ---- Regions (undo/redo patches) ----

export function extractRegion<T extends Float32Array | Uint8Array>(data: T, res: number, channels: number, r: TerrainRegion): T {
  const out = new (data.constructor as { new (n: number): T })(r.w * r.h * channels);
  for (let row = 0; row < r.h; row++) {
    const start = ((r.z0 + row) * res + r.x0) * channels;
    out.set(data.subarray(start, start + r.w * channels), row * r.w * channels);
  }
  return out;
}

export function writeRegion<T extends Float32Array | Uint8Array>(target: T, res: number, channels: number, r: TerrainRegion, patch: T): void {
  for (let row = 0; row < r.h; row++) {
    target.set(patch.subarray(row * r.w * channels, (row + 1) * r.w * channels), ((r.z0 + row) * res + r.x0) * channels);
  }
}

// ---- Inspection ----

export function terrainStats(t: TerrainData): {
  minHeight: number;
  maxHeight: number;
  meanHeight: number;
  /** Share of each layer across the terrain (0-1). */
  layerCoverage: Array<{ layerId: string; share: number }>;
} {
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  for (const h of t.heights) {
    if (h < min) min = h;
    if (h > max) max = h;
    sum += h;
  }
  const totals = [0, 0, 0, 0];
  for (let i = 0; i < t.splat.length; i++) totals[i % SPLAT_CHANNELS] += t.splat[i];
  const all = totals.reduce((a, b) => a + b, 0) || 1;
  return {
    minHeight: min,
    maxHeight: max,
    meanHeight: sum / t.heights.length,
    layerCoverage: t.layers.map((l, i) => ({ layerId: l.id, share: totals[i] / all })),
  };
}

/** An n×n grid of heights (rows along z) — a compact view of the relief for an agent. */
export function downsampleHeights(t: TerrainData, samples: number): number[][] {
  const n = Math.max(2, Math.min(129, Math.round(samples)));
  const rows: number[][] = [];
  for (let r = 0; r < n; r++) {
    const z = (r / (n - 1)) * t.size.depth;
    const row: number[] = [];
    for (let c = 0; c < n; c++) row.push(Math.round(heightAt(t, (c / (n - 1)) * t.size.width, z) * 100) / 100);
    rows.push(row);
  }
  return rows;
}

/** Lines every `spacing` meters along x and z, following the relief — for grid overlays in 3D views. */
export function terrainGridLines(t: TerrainData, spacing: number, lift = 0.05): Array<Array<{ x: number; y: number; z: number }>> {
  const lines: Array<Array<{ x: number; y: number; z: number }>> = [];
  if (!(spacing > 0)) return lines;
  const { dx, dz } = sampleSpacing(t);
  for (let x = 0; x <= t.size.width + 1e-6; x += spacing) {
    const line = [];
    for (let z = 0; z <= t.size.depth + 1e-6; z += dz) line.push({ x, y: heightAt(t, x, z) + lift, z });
    lines.push(line);
  }
  for (let z = 0; z <= t.size.depth + 1e-6; z += spacing) {
    const line = [];
    for (let x = 0; x <= t.size.width + 1e-6; x += dx) line.push({ x, y: heightAt(t, x, z) + lift, z });
    lines.push(line);
  }
  return lines;
}

export function canAddTerrainLayer(t: TerrainInfo): boolean {
  return t.layers.length < MAX_TERRAIN_LAYERS;
}
