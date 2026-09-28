import { createCanvas, loadImage } from "@napi-rs/canvas";
import type { KreaProject, Map3D, MapObjectDefinition, Placement3D } from "@core/map-types";
import { getSprite } from "@core/map-utils";
import { SPLAT_CHANNELS, hexToRgb, heightAt, normalAt, sampleSpacing } from "@core/terrain";
import {
  BOX_EDGES,
  MARKER_SIZE,
  billboardSize,
  objectLocalBounds,
  placementCorners,
  placementOrigin,
  transformPoint,
  type LocalBounds,
  type Vec3,
} from "@core/placement-geometry";
import { parseGlb, linearToSrgb255, type ParsedModel } from "@shared/glb";
import { DEFAULT_WATER_COLOR, buildWaterIndex, waterMask, wetCells } from "@core/water";
import { DETAIL_STRIDE, detailInstances } from "@core/details";
import type { DetailLayer } from "@core/map-types";
import { ProjectError } from "./project-service";
import { normalizeAssetKey } from "./project-file-service";

/**
 * Headless 3D screenshots of 3D maps — a small software rasterizer (no GPU,
 * no browser), so an agent can look at its terrain anywhere Node runs.
 *
 * Deferred shading: triangles are rasterized into a G-buffer (depth, world
 * position or color, normal), then each pixel is shaded — terrain pixels
 * blend their layers' textures by the splatmap, water is composited on top.
 */

export type View3D = "iso" | "top" | "perspective";

export interface Render3DParams {
  view: View3D;
  /** Output size in pixels. */
  width: number;
  height?: number;
  /** Area to frame (world meters); defaults to the whole terrain. */
  area?: { x: number; z: number; width: number; depth: number };
  /** Degrees around the vertical axis the camera looks from (0 = from +z/south). Default 45. */
  yaw?: number;
  /** Degrees above the horizon. Default 35 (iso), 30 (perspective). */
  pitch?: number;
  /** Perspective: distance from the target in meters; target defaults to the area's center. */
  distance?: number;
  targetX?: number;
  targetZ?: number;
  /** Perspective: vertical field of view in degrees (default 50). */
  fov?: number;
  showGrid: boolean;
  /** Grid spacing in meters (default: about 10 lines across the area). */
  gridSpacing?: number;
  showCollisions: boolean;
  /** Write each placement's id next to it. */
  showLabels: boolean;
  layerIds?: string[];
}

/** How to map the image back to the world (sent as the X-Krea-Camera header). */
export interface CameraInfo {
  view: View3D;
  width: number;
  height: number;
  eye: Vec3;
  target: Vec3;
  /** Top view only: pixel (px, py) ↔ world x = originX + px * metersPerPixel, z = originZ + py * metersPerPixel. */
  metersPerPixel?: number;
  originX?: number;
  originZ?: number;
}

const MAX_PX = 2048;

interface Camera {
  eye: Vec3;
  target: Vec3;
  right: Vec3;
  up: Vec3;
  forward: Vec3;
  ortho: boolean;
  /** Ortho: meters per pixel. */
  scale: number;
  /** Perspective: focal length in pixels. */
  focal: number;
  width: number;
  height: number;
}

const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a: Vec3, b: Vec3): Vec3 => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
const norm = (a: Vec3): Vec3 => {
  const l = Math.hypot(a.x, a.y, a.z) || 1;
  return { x: a.x / l, y: a.y / l, z: a.z / l };
};

/** Camera-space coordinates: x right, y up, z forward (depth). */
function toCamera(cam: Camera, p: Vec3): Vec3 {
  const d = sub(p, cam.eye);
  return { x: dot(d, cam.right), y: dot(d, cam.up), z: dot(d, cam.forward) };
}

const NEAR = 0.05;

function toScreen(cam: Camera, c: Vec3): { sx: number; sy: number; depth: number } {
  if (cam.ortho) return { sx: cam.width / 2 + c.x / cam.scale, sy: cam.height / 2 - c.y / cam.scale, depth: c.z };
  return { sx: cam.width / 2 + (c.x / c.z) * cam.focal, sy: cam.height / 2 - (c.y / c.z) * cam.focal, depth: c.z };
}

function buildCamera(map: Map3D, p: Render3DParams, width: number, height: number): Camera {
  const t = map.terrain;
  const area = p.area ?? { x: 0, z: 0, width: t.size.width, depth: t.size.depth };
  let minY = Infinity;
  let maxY = -Infinity;
  const { dx, dz } = sampleSpacing(t);
  for (let iz = 0; iz < t.resolution; iz++) {
    const z = iz * dz;
    if (z < area.z - dz || z > area.z + area.depth + dz) continue;
    for (let ix = 0; ix < t.resolution; ix++) {
      const x = ix * dx;
      if (x < area.x - dx || x > area.x + area.width + dx) continue;
      const h = t.heights[iz * t.resolution + ix];
      if (h < minY) minY = h;
      if (h > maxY) maxY = h;
    }
  }
  if (!Number.isFinite(minY)) minY = maxY = 0;
  if (t.waterLevel !== null) {
    minY = Math.min(minY, t.waterLevel);
    maxY = Math.max(maxY, t.waterLevel);
  }
  maxY += 2; // room for objects standing on the highest point
  const center: Vec3 = { x: area.x + area.width / 2, y: (minY + maxY) / 2, z: area.z + area.depth / 2 };

  if (p.view === "top") {
    const scale = Math.max(area.width / width, area.depth / height);
    const eye = { x: center.x, y: maxY + 1000, z: center.z };
    return {
      eye,
      target: center,
      right: { x: 1, y: 0, z: 0 },
      up: { x: 0, y: 0, z: -1 },
      forward: { x: 0, y: -1, z: 0 },
      ortho: true,
      scale,
      focal: 0,
      width,
      height,
    };
  }

  const yaw = ((p.yaw ?? 45) * Math.PI) / 180;
  const pitch = ((p.pitch ?? (p.view === "iso" ? 35 : 30)) * Math.PI) / 180;
  const dir: Vec3 = { x: Math.cos(pitch) * Math.sin(yaw), y: Math.sin(pitch), z: Math.cos(pitch) * Math.cos(yaw) };
  const forward = norm({ x: -dir.x, y: -dir.y, z: -dir.z });
  const right = norm(cross(forward, { x: 0, y: 1, z: 0 }));
  const up = cross(right, forward);

  if (p.view === "iso") {
    // Fit the area's bounding box.
    const corners: Vec3[] = [];
    for (const x of [area.x, area.x + area.width]) for (const y of [minY, maxY]) for (const z of [area.z, area.z + area.depth]) corners.push({ x, y, z });
    let minR = Infinity;
    let maxR = -Infinity;
    let minU = Infinity;
    let maxU = -Infinity;
    for (const c of corners) {
      const d = sub(c, center);
      minR = Math.min(minR, dot(d, right));
      maxR = Math.max(maxR, dot(d, right));
      minU = Math.min(minU, dot(d, up));
      maxU = Math.max(maxU, dot(d, up));
    }
    const scale = Math.max((maxR - minR) / width, (maxU - minU) / height) * 1.04;
    const target: Vec3 = {
      x: center.x + right.x * ((minR + maxR) / 2) + up.x * ((minU + maxU) / 2),
      y: center.y + right.y * ((minR + maxR) / 2) + up.y * ((minU + maxU) / 2),
      z: center.z + right.z * ((minR + maxR) / 2) + up.z * ((minU + maxU) / 2),
    };
    const far = Math.hypot(area.width, area.depth, maxY - minY) + 100;
    const eye = { x: target.x + dir.x * far, y: target.y + dir.y * far, z: target.z + dir.z * far };
    return { eye, target, right, up, forward, ortho: true, scale, focal: 0, width, height };
  }

  const target: Vec3 = {
    x: p.targetX ?? center.x,
    z: p.targetZ ?? center.z,
    y: 0,
  };
  target.y = p.targetX !== undefined || p.targetZ !== undefined ? heightAt(t, target.x, target.z) : (minY + maxY) / 2;
  const fov = ((p.fov ?? 50) * Math.PI) / 180;
  const distance = p.distance ?? Math.max(area.width, area.depth) * 0.95;
  const eye = { x: target.x + dir.x * distance, y: target.y + dir.y * distance, z: target.z + dir.z * distance };
  return { eye, target, right, up, forward, ortho: false, scale: 0, focal: height / 2 / Math.tan(fov / 2), width, height };
}

// ---- G-buffer ----

const MAT_NONE = 0;
const MAT_TERRAIN = 1;
const MAT_LIT = 2; // model / marker: color + normal, lit
const MAT_UNLIT = 3; // billboard: color, lightly shaded

interface GBuffer {
  w: number;
  h: number;
  depth: Float32Array;
  mat: Uint8Array;
  /** MAT_TERRAIN: world x, y, z. MAT_LIT/MAT_UNLIT: r, g, b (0-1). */
  a: Float32Array;
  /** MAT_LIT: normal. */
  n: Float32Array;
}

function createGBuffer(w: number, h: number): GBuffer {
  return { w, h, depth: new Float32Array(w * h).fill(Infinity), mat: new Uint8Array(w * h), a: new Float32Array(w * h * 3), n: new Float32Array(w * h * 3) };
}

interface ProjectedVertex {
  sx: number;
  sy: number;
  depth: number;
  /** Camera-space z (perspective-correct interpolation). */
  cz: number;
}

/**
 * Rasterizes one triangle. `shade(i, b0, b1, b2)` receives the pixel index and
 * perspective-correct barycentrics, and returns false to discard the pixel.
 */
function rasterTriangle(
  g: GBuffer,
  ortho: boolean,
  v0: ProjectedVertex,
  v1: ProjectedVertex,
  v2: ProjectedVertex,
  shade: (i: number, b0: number, b1: number, b2: number) => boolean,
): void {
  const area = (v1.sx - v0.sx) * (v2.sy - v0.sy) - (v2.sx - v0.sx) * (v1.sy - v0.sy);
  if (Math.abs(area) < 1e-9) return;
  const minX = Math.max(0, Math.floor(Math.min(v0.sx, v1.sx, v2.sx)));
  const maxX = Math.min(g.w - 1, Math.ceil(Math.max(v0.sx, v1.sx, v2.sx)));
  const minY = Math.max(0, Math.floor(Math.min(v0.sy, v1.sy, v2.sy)));
  const maxY = Math.min(g.h - 1, Math.ceil(Math.max(v0.sy, v1.sy, v2.sy)));
  if (minX > maxX || minY > maxY) return;
  const inv = 1 / area;
  for (let py = minY; py <= maxY; py++) {
    const y = py + 0.5;
    for (let px = minX; px <= maxX; px++) {
      const x = px + 0.5;
      let w0 = ((v1.sx - x) * (v2.sy - y) - (v2.sx - x) * (v1.sy - y)) * inv;
      let w1 = ((v2.sx - x) * (v0.sy - y) - (v0.sx - x) * (v2.sy - y)) * inv;
      let w2 = 1 - w0 - w1;
      if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue;
      let depth: number;
      if (ortho) {
        depth = w0 * v0.depth + w1 * v1.depth + w2 * v2.depth;
      } else {
        const iz = w0 / v0.cz + w1 / v1.cz + w2 / v2.cz;
        depth = 1 / iz;
        w0 = w0 / v0.cz / iz;
        w1 = w1 / v1.cz / iz;
        w2 = 1 - w0 - w1;
      }
      const i = py * g.w + px;
      if (depth >= g.depth[i]) continue;
      if (!shade(i, w0, w1, w2)) continue;
      g.depth[i] = depth;
    }
  }
}

/**
 * Projects a world triangle and rasterizes it, clipping against the near
 * plane in perspective views. `attrs` are per-vertex values interpolated for
 * `shade` (e.g. world positions or UVs).
 */
function drawWorldTriangle(
  g: GBuffer,
  cam: Camera,
  p: [Vec3, Vec3, Vec3],
  attrs: [number[], number[], number[]],
  shade: (i: number, attr: number[]) => boolean,
): void {
  const cams = p.map((v) => toCamera(cam, v));
  let poly: Array<{ c: Vec3; a: number[] }> = cams.map((c, k) => ({ c, a: attrs[k] }));
  if (!cam.ortho) {
    if (cams.every((c) => c.z < NEAR)) return;
    if (cams.some((c) => c.z < NEAR)) {
      const clipped: Array<{ c: Vec3; a: number[] }> = [];
      for (let k = 0; k < poly.length; k++) {
        const A = poly[k];
        const B = poly[(k + 1) % poly.length];
        const aIn = A.c.z >= NEAR;
        const bIn = B.c.z >= NEAR;
        if (aIn) clipped.push(A);
        if (aIn !== bIn) {
          const t = (NEAR - A.c.z) / (B.c.z - A.c.z);
          clipped.push({
            c: { x: A.c.x + (B.c.x - A.c.x) * t, y: A.c.y + (B.c.y - A.c.y) * t, z: NEAR },
            a: A.a.map((v, j) => v + (B.a[j] - v) * t),
          });
        }
      }
      poly = clipped;
    }
  }
  const verts = poly.map(({ c }) => {
    const s = toScreen(cam, c);
    return { sx: s.sx, sy: s.sy, depth: s.depth, cz: c.z };
  });
  const n = poly[0].a.length;
  const scratch = new Array<number>(n);
  for (let k = 1; k + 1 < poly.length; k++) {
    const a0 = poly[0].a;
    const a1 = poly[k].a;
    const a2 = poly[k + 1].a;
    rasterTriangle(g, cam.ortho, verts[0], verts[k], verts[k + 1], (i, b0, b1, b2) => {
      for (let j = 0; j < n; j++) scratch[j] = a0[j] * b0 + a1[j] * b1 + a2[j] * b2;
      return shade(i, scratch);
    });
  }
}

// ---- Assets ----

interface Pixels {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

function createAssetCache(assets: Map<string, Uint8Array>) {
  const images = new Map<string, Pixels | null>();
  const models = new Map<string, ParsedModel | null>();
  return {
    async image(rel: string): Promise<Pixels | null> {
      if (images.has(rel)) return images.get(rel)!;
      const key = normalizeAssetKey(rel);
      const data = key ? assets.get(key) : undefined;
      let pixels: Pixels | null = null;
      if (data) {
        const img = await loadImage(Buffer.from(data)).catch(() => null);
        if (img && img.width > 0 && img.height > 0) {
          const c = createCanvas(img.width, img.height);
          const ctx = c.getContext("2d");
          ctx.drawImage(img, 0, 0);
          pixels = { width: img.width, height: img.height, data: ctx.getImageData(0, 0, img.width, img.height).data };
        }
      }
      images.set(rel, pixels);
      return pixels;
    },
    model(rel: string): ParsedModel | null {
      if (models.has(rel)) return models.get(rel)!;
      const key = normalizeAssetKey(rel);
      const data = key ? assets.get(key) : undefined;
      let model: ParsedModel | null = null;
      if (data) {
        try {
          model = parseGlb(data);
        } catch {
          model = null;
        }
      }
      models.set(rel, model);
      return model;
    },
  };
}

// ---- Render ----

const SUN = norm({ x: -0.45, y: 0.8, z: 0.35 });
const MARKER = [0.72, 0.52, 1];

function lambert(nx: number, ny: number, nz: number): number {
  return 0.42 + 0.63 * Math.max(0, nx * SUN.x + ny * SUN.y + nz * SUN.z);
}

export async function renderMap3D(
  project: KreaProject,
  assets: Map<string, Uint8Array>,
  map: Map3D,
  params: Render3DParams,
): Promise<{ png: Buffer; camera: CameraInfo }> {
  const t = map.terrain;
  const area = params.area ?? { x: 0, z: 0, width: t.size.width, depth: t.size.depth };
  if (!(area.width > 0) || !(area.depth > 0)) throw new ProjectError("The area must have a positive width and depth.", 400);
  const width = Math.round(params.width);
  const height = Math.round(params.height ?? (params.view === "top" ? (width * area.depth) / area.width : (width * 3) / 4));
  if (!(width >= 16 && height >= 16 && width <= MAX_PX && height <= MAX_PX)) {
    throw new ProjectError(`Image size must be between 16 and ${MAX_PX} pixels per side (got ${width}x${height}).`, 400);
  }

  const cam = buildCamera(map, { ...params, area }, width, height);
  const g = createGBuffer(width, height);
  const cache = createAssetCache(assets);

  // Terrain: two triangles per heightmap cell, interpolating world positions.
  const res = t.resolution;
  const { dx, dz } = sampleSpacing(t);
  const vertex = (ix: number, iz: number): Vec3 => ({ x: ix * dx, y: t.heights[iz * res + ix], z: iz * dz });
  const shadeTerrain = (i: number, a: number[]) => {
    g.mat[i] = MAT_TERRAIN;
    g.a[i * 3] = a[0];
    g.a[i * 3 + 1] = a[1];
    g.a[i * 3 + 2] = a[2];
    return true;
  };
  for (let iz = 0; iz < res - 1; iz++) {
    for (let ix = 0; ix < res - 1; ix++) {
      const a = vertex(ix, iz);
      const b = vertex(ix + 1, iz);
      const c = vertex(ix, iz + 1);
      const d = vertex(ix + 1, iz + 1);
      drawWorldTriangle(g, cam, [a, c, b], [[a.x, a.y, a.z], [c.x, c.y, c.z], [b.x, b.y, b.z]], shadeTerrain);
      drawWorldTriangle(g, cam, [b, c, d], [[b.x, b.y, b.z], [c.x, c.y, c.z], [d.x, d.y, d.z]], shadeTerrain);
    }
  }

  // Objects.
  const objectById = new Map(project.objects.map((o) => [o.id, o]));
  const layers = params.layerIds ? map.layers.filter((l) => params.layerIds!.includes(l.id)) : map.layers.filter((l) => l.visible);
  const layerIds = new Set(layers.map((l) => l.id));
  const placements = map.placements.filter((p) => layerIds.has(p.layerId));
  const boxes: Array<{ placement: Placement3D; bounds: LocalBounds }> = [];

  for (const placement of placements) {
    const def = objectById.get(placement.objectId);
    const origin = placementOrigin(t, placement);
    if (def?.kind === "3d" && def.model) {
      const model = cache.model(def.model);
      if (model) {
        drawModel(g, cam, model, origin, placement);
        boxes.push({ placement, bounds: { min: model.bounds.min, max: model.bounds.max } });
        continue;
      }
    }
    const sprite = def?.kind === "2d" ? getSprite(def, placement.spriteId) : undefined;
    const pixels = sprite ? await cache.image(sprite.image) : null;
    if (def && sprite && pixels) {
      drawBillboard(g, cam, def, pixels, origin, placement);
      boxes.push({ placement, bounds: objectLocalBounds(def, null, pixels) });
      continue;
    }
    drawMarker(g, cam, origin, placement);
    boxes.push({ placement, bounds: objectLocalBounds(undefined, null, null) });
  }

  // Grass & flowers (detail layers), generated from their painted density.
  if (t.detailLayers.length > 0) {
    const water = buildWaterIndex(map);
    const isWet = (x: number, z: number) => water.surfaceAt(x, z) !== null;
    for (let li = 0; li < t.detailLayers.length; li++) {
      const layer = t.detailLayers[li];
      const instances = detailInstances(t, layer, li, { maxInstances: layer.model ? 4000 : 80000, isWet, area });
      if (instances.length === 0) continue;
      const sprite = layer.sprite ? await cache.image(layer.sprite) : null;
      const model = layer.model ? cache.model(layer.model) : null;
      drawDetails(g, cam, layer, instances, sprite, model);
    }
  }

  // Water surfaces (composited in the shading pass): the sea plane, then each
  // lake over the grid cells of its basin. `a` holds the surface height and color.
  const waterDepth = new Float32Array(width * height).fill(Infinity);
  const wg: GBuffer = { ...g, depth: waterDepth, mat: new Uint8Array(width * height), a: new Float32Array(width * height * 4), n: g.n };
  const drawWater = (quads: Array<[Vec3, Vec3, Vec3, Vec3]>, level: number, hex: string) => {
    const [cr, cg, cb] = hexToRgb(hex).map((v) => v / 255);
    const shade = (i: number) => {
      wg.mat[i] = 1;
      wg.a[i * 4] = level;
      wg.a[i * 4 + 1] = cr;
      wg.a[i * 4 + 2] = cg;
      wg.a[i * 4 + 3] = cb;
      return true;
    };
    for (const [a, b, c, d] of quads) {
      drawWorldTriangle(wg, cam, [a, c, b], [[], [], []], shade);
      drawWorldTriangle(wg, cam, [b, c, d], [[], [], []], shade);
    }
  };
  if (t.waterLevel !== null) {
    const wl = t.waterLevel;
    const far = Math.max(t.size.width, t.size.depth) * 3;
    drawWater(
      [[{ x: -far, y: wl, z: -far }, { x: t.size.width + far, y: wl, z: -far }, { x: -far, y: wl, z: t.size.depth + far }, { x: t.size.width + far, y: wl, z: t.size.depth + far }]],
      wl,
      DEFAULT_WATER_COLOR,
    );
  }
  for (const body of map.waters) {
    const { dx, dz } = sampleSpacing(t);
    const quads = wetCells(t, waterMask(t, body)).map(({ ix, iz }): [Vec3, Vec3, Vec3, Vec3] => [
      { x: ix * dx, y: body.level, z: iz * dz },
      { x: (ix + 1) * dx, y: body.level, z: iz * dz },
      { x: ix * dx, y: body.level, z: (iz + 1) * dz },
      { x: (ix + 1) * dx, y: body.level, z: (iz + 1) * dz },
    ]);
    drawWater(quads, body.level, body.color ?? DEFAULT_WATER_COLOR);
  }

  // Terrain layer colors / textures.
  const layerPixels = await Promise.all(t.layers.map((l) => (l.texture ? cache.image(l.texture) : Promise.resolve(null))));
  const layerColors = t.layers.map((l) => hexToRgb(l.color).map((v) => v / 255));

  const gridSpacing = params.gridSpacing ?? niceSpacing(Math.max(area.width, area.depth) / 10);
  const out = new Uint8ClampedArray(width * height * 4);
  const weights = [0, 0, 0, 0];
  for (let py = 0; py < height; py++) {
    // Sky gradient.
    const skyT = py / height;
    const sky = [0.55 + 0.2 * skyT, 0.7 + 0.12 * skyT, 0.88 + 0.05 * skyT];
    for (let px = 0; px < width; px++) {
      const i = py * width + px;
      let r = sky[0];
      let gg = sky[1];
      let b = sky[2];
      const mat = g.mat[i];
      let terrainY = -Infinity;
      if (mat === MAT_TERRAIN) {
        const x = g.a[i * 3];
        const y = g.a[i * 3 + 1];
        const z = g.a[i * 3 + 2];
        terrainY = y;
        sampleSplat(t, x, z, weights);
        r = gg = b = 0;
        for (let l = 0; l < t.layers.length; l++) {
          const w = weights[l];
          if (w <= 0) continue;
          const tex = layerPixels[l];
          if (tex) {
            const tile = t.layers[l].tileSize;
            const u = wrap(x / tile) * tex.width;
            const v = wrap(z / tile) * tex.height;
            const k = (Math.min(tex.height - 1, Math.floor(v)) * tex.width + Math.min(tex.width - 1, Math.floor(u))) * 4;
            r += w * (tex.data[k] / 255);
            gg += w * (tex.data[k + 1] / 255);
            b += w * (tex.data[k + 2] / 255);
          } else {
            r += w * layerColors[l][0];
            gg += w * layerColors[l][1];
            b += w * layerColors[l][2];
          }
        }
        const n = normalAt(t, x, z);
        const light = lambert(n.x, n.y, n.z);
        r *= light;
        gg *= light;
        b *= light;
        if (params.showGrid && isGridPixel(g, i, px, py, gridSpacing)) {
          r = r * 0.55 + 0.45;
          gg = gg * 0.55 + 0.45;
          b = b * 0.55 + 0.45;
        }
      } else if (mat === MAT_LIT) {
        const light = lambert(g.n[i * 3], g.n[i * 3 + 1], g.n[i * 3 + 2]);
        r = g.a[i * 3] * light;
        gg = g.a[i * 3 + 1] * light;
        b = g.a[i * 3 + 2] * light;
      } else if (mat === MAT_UNLIT) {
        r = g.a[i * 3] * 0.95;
        gg = g.a[i * 3 + 1] * 0.95;
        b = g.a[i * 3 + 2] * 0.95;
      }
      if (waterDepth[i] < g.depth[i]) {
        // Deeper water is more opaque and darker.
        const level = wg.a[i * 4];
        const below = mat === MAT_TERRAIN ? Math.max(0, level - terrainY) : 3;
        const alpha = mat === MAT_NONE ? 0.9 : Math.min(0.9, 0.3 + below * 0.12);
        const dark = 1 - Math.min(0.45, below * 0.03);
        r = r * (1 - alpha) + wg.a[i * 4 + 1] * dark * alpha;
        gg = gg * (1 - alpha) + wg.a[i * 4 + 2] * dark * alpha;
        b = b * (1 - alpha) + wg.a[i * 4 + 3] * dark * alpha;
      }
      out[i * 4] = r * 255;
      out[i * 4 + 1] = gg * 255;
      out[i * 4 + 2] = b * 255;
      out[i * 4 + 3] = 255;
    }
  }

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  const imageData = ctx.createImageData(width, height);
  imageData.data.set(out);
  ctx.putImageData(imageData, 0, 0);

  const project2D = (p: Vec3) => {
    const c = toCamera(cam, p);
    if (!cam.ortho && c.z < NEAR) return null;
    const s = toScreen(cam, c);
    return { x: s.sx, y: s.sy };
  };

  if (params.showCollisions) {
    ctx.strokeStyle = "rgba(255, 90, 90, 0.95)";
    ctx.lineWidth = 1.5;
    for (const { placement, bounds } of boxes) {
      const corners = placementCorners(t, placement, bounds).map(project2D);
      ctx.beginPath();
      for (const [a, b] of BOX_EDGES) {
        const pa = corners[a];
        const pb = corners[b];
        if (!pa || !pb) continue;
        ctx.moveTo(pa.x, pa.y);
        ctx.lineTo(pb.x, pb.y);
      }
      ctx.stroke();
    }
  }

  if (params.showLabels) {
    ctx.font = "11px sans-serif";
    ctx.textBaseline = "bottom";
    for (const { placement, bounds } of boxes) {
      const origin = placementOrigin(t, placement);
      const top = project2D({ x: origin.x, y: origin.y + bounds.max[1] * placement.scale + 0.2, z: origin.z });
      if (!top || top.x < 0 || top.y < 0 || top.x > width || top.y > height) continue;
      const label = placement.id;
      const w = ctx.measureText(label).width + 6;
      ctx.fillStyle = "rgba(20, 20, 24, 0.75)";
      ctx.fillRect(top.x - w / 2, top.y - 15, w, 14);
      ctx.fillStyle = "#ffffff";
      ctx.fillText(label, top.x - w / 2 + 3, top.y - 2);
    }
  }

  const camera: CameraInfo = { view: params.view, width, height, eye: round3(cam.eye), target: round3(cam.target) };
  if (params.view === "top") {
    camera.metersPerPixel = cam.scale;
    camera.originX = cam.target.x - (width / 2) * cam.scale;
    camera.originZ = cam.target.z - (height / 2) * cam.scale;
  }
  return { png: canvas.toBuffer("image/png"), camera };
}

function round3(v: Vec3): Vec3 {
  return { x: Math.round(v.x * 100) / 100, y: Math.round(v.y * 100) / 100, z: Math.round(v.z * 100) / 100 };
}

function wrap(v: number): number {
  return v - Math.floor(v);
}

function niceSpacing(raw: number): number {
  const pow = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1e-3))));
  const n = raw / pow;
  return (n < 1.5 ? 1 : n < 3.5 ? 2 : n < 7.5 ? 5 : 10) * pow;
}

/** A pixel is on a grid line when a neighbor pixel falls in a different grid cell. */
function isGridPixel(g: GBuffer, i: number, px: number, py: number, spacing: number): boolean {
  const cell = (k: number, axis: 0 | 2) => Math.floor(g.a[k * 3 + axis] / spacing);
  for (const [ox, oy] of [
    [1, 0],
    [0, 1],
  ]) {
    const nx = px + ox;
    const ny = py + oy;
    if (nx >= g.w || ny >= g.h) continue;
    const k = ny * g.w + nx;
    if (g.mat[k] !== MAT_TERRAIN) continue;
    if (cell(i, 0) !== cell(k, 0) || cell(i, 2) !== cell(k, 2)) return true;
  }
  return false;
}

/** Bilinear splat weights at (x, z), normalized. */
function sampleSplat(t: Map3D["terrain"], x: number, z: number, out: number[]): void {
  const res = t.resolution;
  const { dx, dz } = sampleSpacing(t);
  const gx = Math.min(Math.max(x / dx, 0), res - 1);
  const gz = Math.min(Math.max(z / dz, 0), res - 1);
  const x0 = Math.min(Math.floor(gx), res - 2);
  const z0 = Math.min(Math.floor(gz), res - 2);
  const fx = gx - x0;
  const fz = gz - z0;
  let sum = 0;
  for (let c = 0; c < SPLAT_CHANNELS; c++) {
    const at = (ix: number, iz: number) => t.splat[(iz * res + ix) * SPLAT_CHANNELS + c];
    const v = (at(x0, z0) * (1 - fx) + at(x0 + 1, z0) * fx) * (1 - fz) + (at(x0, z0 + 1) * (1 - fx) + at(x0 + 1, z0 + 1) * fx) * fz;
    out[c] = v;
    sum += v;
  }
  for (let c = 0; c < SPLAT_CHANNELS; c++) out[c] = sum > 0 ? out[c] / sum : c === 0 ? 1 : 0;
}

function drawModel(g: GBuffer, cam: Camera, model: ParsedModel, origin: Vec3, placement: Placement3D): void {
  for (const prim of model.primitives) {
    const count = prim.positions.length / 3;
    const world: Vec3[] = new Array(count);
    for (let v = 0; v < count; v++) {
      world[v] = transformPoint(origin, placement, [prim.positions[v * 3], prim.positions[v * 3 + 1], prim.positions[v * 3 + 2]]);
    }
    const base = [linearToSrgb255(prim.color[0]) / 255, linearToSrgb255(prim.color[1]) / 255, linearToSrgb255(prim.color[2]) / 255];
    for (let k = 0; k + 2 < prim.indices.length; k += 3) {
      const ia = prim.indices[k];
      const ib = prim.indices[k + 1];
      const ic = prim.indices[k + 2];
      const a = world[ia];
      const b = world[ib];
      const c = world[ic];
      if (!a || !b || !c) continue;
      let n = norm(cross(sub(b, a), sub(c, a)));
      // Double-sided lighting: face the normal toward the camera.
      const view = cam.ortho ? cam.forward : sub(a, cam.eye);
      if (dot(n, view) > 0) n = { x: -n.x, y: -n.y, z: -n.z };
      const vc = prim.vertexColors;
      const color = (idx: number) =>
        vc ? [base[0] * (linearToSrgb255(vc[idx * 3]) / 255), base[1] * (linearToSrgb255(vc[idx * 3 + 1]) / 255), base[2] * (linearToSrgb255(vc[idx * 3 + 2]) / 255)] : base;
      drawWorldTriangle(g, cam, [a, b, c], [color(ia), color(ib), color(ic)], (i, attr) => {
        g.mat[i] = MAT_LIT;
        g.a[i * 3] = attr[0];
        g.a[i * 3 + 1] = attr[1];
        g.a[i * 3 + 2] = attr[2];
        g.n[i * 3] = n.x;
        g.n[i * 3 + 1] = n.y;
        g.n[i * 3 + 2] = n.z;
        return true;
      });
    }
  }
}

/** An upright quad facing the camera (turning around the vertical axis only), textured with the sprite. */
function drawBillboard(g: GBuffer, cam: Camera, def: MapObjectDefinition, pixels: Pixels, origin: Vec3, placement: Placement3D): void {
  const size = billboardSize(def, pixels);
  const w = (size.width * placement.scale) / 2;
  const h = size.height * placement.scale;
  let rx = cam.right.x;
  let rz = cam.right.z;
  const len = Math.hypot(rx, rz);
  if (len < 1e-3) {
    // Straight top-down: lay the sprite flat so it's still visible.
    rx = 1;
    rz = 0;
  } else {
    rx /= len;
    rz /= len;
  }
  const flat = cam.ortho && cam.forward.y < -0.99;
  const up: Vec3 = flat ? { x: 0, y: 0, z: -1 } : { x: 0, y: 1, z: 0 };
  const base: Vec3 = flat ? { x: origin.x, y: origin.y + 0.05, z: origin.z + h / 2 } : origin;
  const corner = (sx: number, sy: number): Vec3 => ({ x: base.x + rx * sx + up.x * sy, y: base.y + up.y * sy + (flat ? 0.05 : 0), z: base.z + rz * sx + up.z * sy });
  const bl = corner(-w, 0);
  const br = corner(w, 0);
  const tl = corner(-w, h);
  const tr = corner(w, h);
  const shade = (i: number, uv: number[]) => {
    const u = Math.min(pixels.width - 1, Math.max(0, Math.floor(uv[0] * pixels.width)));
    const v = Math.min(pixels.height - 1, Math.max(0, Math.floor(uv[1] * pixels.height)));
    const k = (v * pixels.width + u) * 4;
    if (pixels.data[k + 3] < 128) return false;
    g.mat[i] = MAT_UNLIT;
    g.a[i * 3] = pixels.data[k] / 255;
    g.a[i * 3 + 1] = pixels.data[k + 1] / 255;
    g.a[i * 3 + 2] = pixels.data[k + 2] / 255;
    return true;
  };
  drawWorldTriangle(g, cam, [bl, br, tl], [[0, 1], [1, 1], [0, 0]], shade);
  drawWorldTriangle(g, cam, [br, tr, tl], [[1, 1], [1, 0], [0, 0]], shade);
}

/**
 * Tufts of one detail layer: textured crossed quads (sprite), instances of a
 * model, or — by default — procedural grass: a few thin blades per tuft,
 * darker at the root.
 */
function drawDetails(g: GBuffer, cam: Camera, layer: DetailLayer, inst: Float32Array, sprite: Pixels | null, model: ParsedModel | null): void {
  const [cr, cg, cb] = hexToRgb(layer.color).map((v) => v / 255);
  const up = { x: 0, y: 1, z: 0 };
  for (let k = 0; k < inst.length; k += DETAIL_STRIDE) {
    const x = inst[k];
    const y = inst[k + 1];
    const z = inst[k + 2];
    const yaw = inst[k + 3];
    const s = inst[k + 4];
    const w = (layer.width * s) / 2;
    const h = layer.height * s;
    if (model) {
      const mh = model.bounds.max[1] - model.bounds.min[1] || 1;
      const placement = { id: "", objectId: "", layerId: "", x, z, elevation: 0, rotation: (yaw * 180) / Math.PI, scale: h / mh };
      drawModel(g, cam, model, { x, y, z }, placement);
      continue;
    }
    for (let q = 0; q < (sprite ? 2 : 5); q++) {
      const a = yaw + (sprite ? (q * Math.PI) / 2 : (q / 5) * Math.PI * 2 + q * 0.7);
      const ox = Math.cos(a) * w;
      const oz = Math.sin(a) * w;
      if (sprite) {
        const bl = { x: x - ox, y, z: z - oz };
        const br = { x: x + ox, y, z: z + oz };
        const tl = { x: x - ox, y: y + h, z: z - oz };
        const tr = { x: x + ox, y: y + h, z: z + oz };
        const shade = (i: number, uv: number[]) => {
          const u = Math.min(sprite.width - 1, Math.max(0, Math.floor(uv[0] * sprite.width)));
          const v = Math.min(sprite.height - 1, Math.max(0, Math.floor(uv[1] * sprite.height)));
          const p = (v * sprite.width + u) * 4;
          if (sprite.data[p + 3] < 128) return false;
          g.mat[i] = MAT_LIT;
          g.a[i * 3] = (sprite.data[p] / 255) * cr * 1.6;
          g.a[i * 3 + 1] = (sprite.data[p + 1] / 255) * cg * 1.6;
          g.a[i * 3 + 2] = (sprite.data[p + 2] / 255) * cb * 1.6;
          g.n[i * 3] = up.x;
          g.n[i * 3 + 1] = up.y;
          g.n[i * 3 + 2] = up.z;
          return true;
        };
        drawWorldTriangle(g, cam, [bl, br, tl], [[0, 1], [1, 1], [0, 0]], shade);
        drawWorldTriangle(g, cam, [br, tr, tl], [[1, 1], [1, 0], [0, 0]], shade);
      } else {
        // One blade: a thin triangle leaning a little, root darker than the tip.
        const lean = 0.25 * w;
        const root1 = { x: x - ox * 0.18, y, z: z - oz * 0.18 };
        const root2 = { x: x + ox * 0.18, y, z: z + oz * 0.18 };
        const tipH = h * (0.75 + (q % 3) * 0.12);
        const tip = { x: x + Math.cos(a) * lean * 2, y: y + tipH, z: z + Math.sin(a) * lean * 2 };
        const shade = (i: number, c: number[]) => {
          g.mat[i] = MAT_LIT;
          g.a[i * 3] = c[0];
          g.a[i * 3 + 1] = c[1];
          g.a[i * 3 + 2] = c[2];
          g.n[i * 3] = up.x;
          g.n[i * 3 + 1] = up.y;
          g.n[i * 3 + 2] = up.z;
          return true;
        };
        const root = [cr * 0.55, cg * 0.55, cb * 0.55];
        const top = [Math.min(1, cr * 1.15), Math.min(1, cg * 1.15), Math.min(1, cb * 1.15)];
        drawWorldTriangle(g, cam, [root1, root2, tip], [root, root, top], shade);
      }
    }
  }
}

function drawMarker(g: GBuffer, cam: Camera, origin: Vec3, placement: Placement3D): void {
  const s = MARKER_SIZE / 2;
  const faces: Array<{ n: [number, number, number]; c: Array<[number, number, number]> }> = [
    { n: [0, 1, 0], c: [[-s, 2 * s, -s], [s, 2 * s, -s], [s, 2 * s, s], [-s, 2 * s, s]] },
    { n: [1, 0, 0], c: [[s, 0, -s], [s, 0, s], [s, 2 * s, s], [s, 2 * s, -s]] },
    { n: [-1, 0, 0], c: [[-s, 0, s], [-s, 0, -s], [-s, 2 * s, -s], [-s, 2 * s, s]] },
    { n: [0, 0, 1], c: [[-s, 0, s], [s, 0, s], [s, 2 * s, s], [-s, 2 * s, s]] },
    { n: [0, 0, -1], c: [[s, 0, -s], [-s, 0, -s], [-s, 2 * s, -s], [s, 2 * s, -s]] },
  ];
  const zero: Vec3 = { x: 0, y: 0, z: 0 };
  for (const f of faces) {
    const pts = f.c.map((c) => transformPoint(origin, placement, c));
    const nWorld = sub(transformPoint(zero, placement, f.n), transformPoint(zero, placement, [0, 0, 0]));
    const n = norm(nWorld);
    const shade = (i: number) => {
      g.mat[i] = MAT_LIT;
      g.a[i * 3] = MARKER[0];
      g.a[i * 3 + 1] = MARKER[1];
      g.a[i * 3 + 2] = MARKER[2];
      g.n[i * 3] = n.x;
      g.n[i * 3 + 1] = n.y;
      g.n[i * 3 + 2] = n.z;
      return true;
    };
    drawWorldTriangle(g, cam, [pts[0], pts[1], pts[2]], [[], [], []], shade);
    drawWorldTriangle(g, cam, [pts[0], pts[2], pts[3]], [[], [], []], shade);
  }
}
