import type { DetailLayer, TerrainData } from "./map-types";
import { SPLAT_CHANNELS, heightAt, sampleSpacing, slopeAt, splatWeightsAt, valueNoise, type TerrainRegion } from "./terrain";

/**
 * Detail layers (grass, flowers, small bushes), like Unity's "Paint Details":
 * a painted density per heightmap sample, one channel per layer in
 * `terrain.details`. Individual tufts are generated from it on demand —
 * deterministically, so the editor, the server screenshots and a game all see
 * the same meadow without storing every blade.
 */

/** Brush dab on one detail channel: paints toward 100% (or 0% with `erase`) by `strength` (0-1) at the center. */
export function detailDab(
  t: TerrainData,
  details: Uint8Array,
  p: { x: number; z: number; radius: number; strength: number; layerIndex: number; erase?: boolean },
): TerrainRegion | null {
  if (p.layerIndex < 0 || p.layerIndex >= SPLAT_CHANNELS || !(p.radius > 0)) return null;
  const res = t.resolution;
  const { dx, dz } = sampleSpacing(t);
  const ix0 = Math.max(0, Math.floor((p.x - p.radius) / dx));
  const ix1 = Math.min(res - 1, Math.ceil((p.x + p.radius) / dx));
  const iz0 = Math.max(0, Math.floor((p.z - p.radius) / dz));
  const iz1 = Math.min(res - 1, Math.ceil((p.z + p.radius) / dz));
  if (ix0 > ix1 || iz0 > iz1) return null;
  const target = p.erase ? 0 : 255;
  const amount = Math.min(Math.max(p.strength, 0), 1);
  let touched = false;
  for (let iz = iz0; iz <= iz1; iz++) {
    for (let ix = ix0; ix <= ix1; ix++) {
      const d = Math.hypot(ix * dx - p.x, iz * dz - p.z) / p.radius;
      if (d >= 1) continue;
      const f = 0.5 * (1 + Math.cos(Math.PI * d));
      const k = (iz * res + ix) * SPLAT_CHANNELS + p.layerIndex;
      const v = details[k] + (target - details[k]) * amount * f;
      details[k] = Math.round(p.erase ? Math.floor(v) : Math.ceil(v));
      touched = true;
    }
  }
  return touched ? { x0: ix0, z0: iz0, w: ix1 - ix0 + 1, h: iz1 - iz0 + 1 } : null;
}

export interface DetailFillRule {
  /** 0-1 density to paint where the rule matches (0 clears). */
  density: number;
  /** Only where this terrain texture layer dominates (weight ≥ 50%). */
  onTerrainLayerIndex?: number;
  minHeight?: number;
  maxHeight?: number;
  /** Degrees. */
  maxSlope?: number;
  /** Natural-looking clumps and clearings (0 = uniform, 1 = very patchy). */
  patchiness?: number;
  /** Size of the clumps in meters (default 12). */
  patchSize?: number;
  seed?: number;
  /** Returns true where there's water — grass doesn't grow there. */
  isWet?: (x: number, z: number) => boolean;
}

/** Fills a whole detail channel from a rule (samples that don't match are set to 0). */
export function fillDetails(t: TerrainData, details: Uint8Array, layerIndex: number, rule: DetailFillRule): TerrainRegion {
  const res = t.resolution;
  const { dx, dz } = sampleSpacing(t);
  const patch = Math.min(Math.max(rule.patchiness ?? 0, 0), 1);
  const size = rule.patchSize ?? 12;
  const seed = rule.seed ?? 1;
  for (let iz = 0; iz < res; iz++) {
    for (let ix = 0; ix < res; ix++) {
      const x = ix * dx;
      const z = iz * dz;
      const h = t.heights[iz * res + ix];
      let v = rule.density;
      if (rule.minHeight !== undefined && h < rule.minHeight) v = 0;
      if (rule.maxHeight !== undefined && h > rule.maxHeight) v = 0;
      if (v > 0 && rule.maxSlope !== undefined && slopeAt(t, x, z) > rule.maxSlope) v = 0;
      if (v > 0 && rule.onTerrainLayerIndex !== undefined && splatWeightsAt(t, x, z)[rule.onTerrainLayerIndex] < 0.5) v = 0;
      if (v > 0 && rule.isWet?.(x, z)) v = 0;
      if (v > 0 && patch > 0) {
        const n = valueNoise(x / size, z / size, seed) * 0.7 + valueNoise((x * 2.3) / size, (z * 2.3) / size, seed + 7) * 0.3;
        // Map noise to 0-1 coverage: more patchiness = sharper clearings.
        const cover = Math.min(1, Math.max(0, (n - patch * 0.5) / (1 - patch * 0.5 + 1e-6)));
        v *= cover * (1 - patch) + Math.pow(cover, 1 + patch * 2) * patch;
      }
      details[(iz * res + ix) * SPLAT_CHANNELS + layerIndex] = Math.round(Math.min(1, Math.max(0, v)) * 255);
    }
  }
  return { x0: 0, z0: 0, w: res, h: res };
}

/** Details after removing layer `index`: later channels shift down, the last one is cleared. */
export function removeDetailChannel(details: Uint8Array, index: number): Uint8Array {
  const out = new Uint8Array(details.length);
  for (let i = 0; i < details.length; i += SPLAT_CHANNELS) {
    let o = 0;
    for (let c = 0; c < SPLAT_CHANNELS; c++) if (c !== index) out[i + o++] = details[i + c];
  }
  return out;
}

function cellRandom(ix: number, iz: number, layer: number): () => number {
  let a = (Math.imul(ix + 1, 73856093) ^ Math.imul(iz + 1, 19349663) ^ Math.imul(layer + 1, 83492791)) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Floats per generated tuft: x, y, z, yaw (radians), scale. */
export const DETAIL_STRIDE = 5;

/**
 * The individual tufts of one detail layer, generated from its painted
 * density: per heightmap cell, `density × painted% × cell area` tufts at
 * pseudo-random spots (seeded by the cell, so always the same ones).
 * `maxInstances` thins them out evenly beyond a budget.
 */
export function detailInstances(
  t: TerrainData,
  layer: DetailLayer,
  layerIndex: number,
  opts: { maxInstances?: number; isWet?: (x: number, z: number) => boolean; area?: { x: number; z: number; width: number; depth: number } } = {},
): Float32Array {
  const res = t.resolution;
  const { dx, dz } = sampleSpacing(t);
  const cellArea = dx * dz;
  const d = t.details;
  const at = (ix: number, iz: number) => d[(iz * res + ix) * SPLAT_CHANNELS + layerIndex] / 255;
  const area = opts.area;
  const ix0 = area ? Math.max(0, Math.floor(area.x / dx)) : 0;
  const iz0 = area ? Math.max(0, Math.floor(area.z / dz)) : 0;
  const ix1 = area ? Math.min(res - 2, Math.ceil((area.x + area.width) / dx)) : res - 2;
  const iz1 = area ? Math.min(res - 2, Math.ceil((area.z + area.depth) / dz)) : res - 2;

  let expected = 0;
  for (let iz = iz0; iz <= iz1; iz++) {
    for (let ix = ix0; ix <= ix1; ix++) {
      expected += ((at(ix, iz) + at(ix + 1, iz) + at(ix, iz + 1) + at(ix + 1, iz + 1)) / 4) * layer.density * cellArea;
    }
  }
  const keep = opts.maxInstances && expected > opts.maxInstances ? opts.maxInstances / expected : 1;
  const out: number[] = [];
  for (let iz = iz0; iz <= iz1; iz++) {
    for (let ix = ix0; ix <= ix1; ix++) {
      const c00 = at(ix, iz);
      const c10 = at(ix + 1, iz);
      const c01 = at(ix, iz + 1);
      const c11 = at(ix + 1, iz + 1);
      if (c00 + c10 + c01 + c11 === 0) continue;
      const rand = cellRandom(ix, iz, layerIndex);
      const count = ((c00 + c10 + c01 + c11) / 4) * layer.density * cellArea * keep;
      const n = Math.floor(count) + (rand() < count - Math.floor(count) ? 1 : 0);
      for (let k = 0; k < n; k++) {
        const fx = rand();
        const fz = rand();
        // Accept by the local (bilinear) density so painted edges fade out tuft by tuft.
        const local = (c00 * (1 - fx) + c10 * fx) * (1 - fz) + (c01 * (1 - fx) + c11 * fx) * fz;
        const avg = (c00 + c10 + c01 + c11) / 4;
        const accept = rand() * avg <= local;
        const yaw = rand() * Math.PI * 2;
        const scale = 1 + (rand() * 2 - 1) * layer.sizeVariation;
        if (!accept) continue;
        const x = (ix + fx) * dx;
        const z = (iz + fz) * dz;
        if (opts.isWet?.(x, z)) continue;
        out.push(x, heightAt(t, x, z), z, yaw, Math.max(0.1, scale));
      }
    }
  }
  return Float32Array.from(out);
}

/** Share of the terrain each detail layer covers (average painted density, 0-1). */
export function detailCoverage(t: TerrainData): number[] {
  const totals = [0, 0, 0, 0];
  for (let i = 0; i < t.details.length; i++) totals[i % SPLAT_CHANNELS] += t.details[i];
  const n = (t.details.length / SPLAT_CHANNELS) * 255 || 1;
  return t.detailLayers.map((_, i) => totals[i] / n);
}
