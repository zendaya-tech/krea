import type { Map3D, TerrainData, WaterBody } from "./map-types";
import { heightAt, sampleSpacing } from "./terrain";

/**
 * Where the water is on a 3D map: the global sea (terrain.waterLevel) plus
 * local water bodies, each filling the basin around its seed point up to its
 * own level. Pure functions, shared by the editor, the server renderer, the
 * exporter and the operations.
 */

export const DEFAULT_WATER_COLOR = "#2f79a8";

/** Nearest heightmap sample to a world point. */
function nearestSample(t: TerrainData, x: number, z: number): { ix: number; iz: number } {
  const { dx, dz } = sampleSpacing(t);
  return {
    ix: Math.min(t.resolution - 1, Math.max(0, Math.round(x / dx))),
    iz: Math.min(t.resolution - 1, Math.max(0, Math.round(z / dz))),
  };
}

/**
 * The samples a water body covers (1 = under water): a flood fill from the
 * seed through samples lower than `level`, clipped to `area`. Empty when the
 * seed itself is above the water level.
 */
export function waterMask(t: TerrainData, body: WaterBody): Uint8Array {
  const res = t.resolution;
  const mask = new Uint8Array(res * res);
  const { dx, dz } = sampleSpacing(t);
  const area = body.area;
  const inArea = (ix: number, iz: number) =>
    !area || (ix * dx >= area.x && ix * dx <= area.x + area.width && iz * dz >= area.z && iz * dz <= area.z + area.depth);
  const seed = nearestSample(t, body.x, body.z);
  if (t.heights[seed.iz * res + seed.ix] >= body.level || !inArea(seed.ix, seed.iz)) return mask;
  const stack = [seed.iz * res + seed.ix];
  mask[stack[0]] = 1;
  while (stack.length > 0) {
    const i = stack.pop()!;
    const ix = i % res;
    const iz = (i - ix) / res;
    for (const [nx, nz] of [
      [ix + 1, iz],
      [ix - 1, iz],
      [ix, iz + 1],
      [ix, iz - 1],
    ]) {
      if (nx < 0 || nz < 0 || nx >= res || nz >= res) continue;
      const n = nz * res + nx;
      if (mask[n] || t.heights[n] >= body.level || !inArea(nx, nz)) continue;
      mask[n] = 1;
      stack.push(n);
    }
  }
  return mask;
}

/**
 * The highest level water poured at (x, z) can reach before it overflows the
 * basin (its "spill" height): a priority flood that always grows the wet area
 * through the lowest bank; once the lowest bank is lower than the water
 * already reached, the water would run out there. Reaching the terrain edge
 * (or the edge of `area`) also spills. Returns the ground height at the seed
 * when there's no basin at all (a slope or a peak).
 */
export function spillLevel(t: TerrainData, x: number, z: number, area?: WaterBody["area"]): number {
  return findBasin(t, x, z, area).level;
}

/**
 * Where water poured at (x, z) ends up: it first runs downhill to the bottom
 * of the hollow (steepest descent), then fills it up to the spill level.
 * Returns that bottom point (a good seed) and the spill level.
 */
export function findBasin(t: TerrainData, x: number, z: number, area?: WaterBody["area"]): { level: number; x: number; z: number } {
  const res = t.resolution;
  const { dx, dz } = sampleSpacing(t);
  const inArea = (ix: number, iz: number) =>
    !area || (ix * dx >= area.x && ix * dx <= area.x + area.width && iz * dz >= area.z && iz * dz <= area.z + area.depth);
  const h = t.heights;
  const seed = nearestSample(t, x, z);
  let start = seed.iz * res + seed.ix;
  // Run downhill to the bottom of the hollow.
  for (;;) {
    const ix = start % res;
    const iz = (start - ix) / res;
    let lowest = start;
    for (let oz = -1; oz <= 1; oz++) {
      for (let ox = -1; ox <= 1; ox++) {
        const nx = ix + ox;
        const nz = iz + oz;
        if (nx < 0 || nz < 0 || nx >= res || nz >= res || !inArea(nx, nz)) continue;
        const n = nz * res + nx;
        if (h[n] < h[lowest]) lowest = n;
      }
    }
    if (lowest === start) break;
    start = lowest;
  }
  const bottom = { x: (start % res) * dx, z: Math.floor(start / res) * dz };
  const level = fillFrom(start);
  return { level, ...bottom };

  function fillFrom(start: number): number {
    // Binary min-heap of sample indices by height.
    const heap: number[] = [start];
    const push = (i: number) => {
      heap.push(i);
      let c = heap.length - 1;
      while (c > 0) {
        const p = (c - 1) >> 1;
        if (h[heap[p]] <= h[heap[c]]) break;
        [heap[p], heap[c]] = [heap[c], heap[p]];
        c = p;
      }
    };
    const pop = () => {
      const top = heap[0];
      const last = heap.pop()!;
      if (heap.length > 0) {
        heap[0] = last;
        let c = 0;
        for (;;) {
          const l = c * 2 + 1;
          const r = l + 1;
          let m = c;
          if (l < heap.length && h[heap[l]] < h[heap[m]]) m = l;
          if (r < heap.length && h[heap[r]] < h[heap[m]]) m = r;
          if (m === c) break;
          [heap[m], heap[c]] = [heap[c], heap[m]];
          c = m;
        }
      }
      return top;
    };
    const seen = new Uint8Array(res * res);
    seen[start] = 1;
    let level = h[start];
    while (heap.length > 0) {
      const i = pop();
      if (h[i] < level) return level; // over the rim and going down: it spills here
      level = h[i];
      const ix = i % res;
      const iz = (i - ix) / res;
      if (ix === 0 || iz === 0 || ix === res - 1 || iz === res - 1 || !inArea(ix, iz)) return level; // runs off the edge
      for (const [nx, nz] of [
        [ix + 1, iz],
        [ix - 1, iz],
        [ix, iz + 1],
        [ix, iz - 1],
      ]) {
        const n = nz * res + nx;
        if (seen[n]) continue;
        seen[n] = 1;
        push(n);
      }
    }
    return level;
  }
}

/** Number of samples under a body — 0 means the seed is above its level (nothing to fill). */
export function waterSampleCount(mask: Uint8Array): number {
  let n = 0;
  for (const v of mask) n += v;
  return n;
}

export interface WaterSurface {
  /** Height of the water surface. */
  level: number;
  /** "sea" or the water body's id. */
  source: string;
  color: string;
}

/**
 * The water surfaces over each sample of a map, computed once (masks are
 * flood fills, so reuse this for many queries).
 */
export function buildWaterIndex(map: Pick<Map3D, "terrain" | "waters">): {
  bodies: Array<{ body: WaterBody; mask: Uint8Array }>;
  /** The water surface at (x, z), or null on dry land. The highest surface wins where bodies overlap. */
  surfaceAt: (x: number, z: number) => WaterSurface | null;
} {
  const t = map.terrain;
  const bodies = (map.waters ?? []).map((body) => ({ body, mask: waterMask(t, body) }));
  const surfaceAt = (x: number, z: number): WaterSurface | null => {
    const ground = heightAt(t, x, z);
    const { ix, iz } = nearestSample(t, x, z);
    let best: WaterSurface | null = null;
    for (const { body, mask } of bodies) {
      if (!mask[iz * t.resolution + ix] || ground >= body.level) continue;
      if (!best || body.level > best.level) best = { level: body.level, source: body.id, color: body.color ?? DEFAULT_WATER_COLOR };
    }
    if (t.waterLevel !== null && ground < t.waterLevel && (!best || t.waterLevel > best.level)) {
      best = { level: t.waterLevel, source: "sea", color: DEFAULT_WATER_COLOR };
    }
    return best;
  };
  return { bodies, surfaceAt };
}

/**
 * Grid cells (quads between samples) a water surface should cover: every cell
 * with at least one wet corner. The terrain hides the part above the banks.
 */
export function wetCells(t: TerrainData, mask: Uint8Array): Array<{ ix: number; iz: number }> {
  const res = t.resolution;
  const cells: Array<{ ix: number; iz: number }> = [];
  for (let iz = 0; iz < res - 1; iz++) {
    for (let ix = 0; ix < res - 1; ix++) {
      const i = iz * res + ix;
      if (mask[i] || mask[i + 1] || mask[i + res] || mask[i + res + 1]) cells.push({ ix, iz });
    }
  }
  return cells;
}

/** Mask of the global sea: every sample below the sea level (the sea is open, not a basin). */
export function seaMask(t: TerrainData): Uint8Array {
  const mask = new Uint8Array(t.resolution * t.resolution);
  if (t.waterLevel === null) return mask;
  for (let i = 0; i < mask.length; i++) if (t.heights[i] < t.waterLevel) mask[i] = 1;
  return mask;
}
