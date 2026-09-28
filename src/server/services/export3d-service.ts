import fs from "node:fs/promises";
import path from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import type { KreaProject, Map3D, TerrainData } from "@core/map-types";
import { getObjectSize, getSprite, slugifyId } from "@core/map-utils";
import { SPLAT_CHANNELS, hexToRgb, normalAt, sampleSpacing, terrainStats } from "@core/terrain";
import { floatsToBytes } from "@core/project-codec";
import { billboardSize, objectLocalBounds, placementBox, placementOrigin } from "@core/placement-geometry";
import { hexToLinear, parseGlb, writeGlb, type GlbMeshInput } from "@shared/glb";
import { DEFAULT_WATER_COLOR, waterMask, waterSampleCount, wetCells } from "@core/water";
import type { ExportRequestOptions, ExportResponse } from "@shared/api-types";
import { ProjectError } from "./project-service";
import { normalizeAssetKey } from "./project-file-service";
import { copyAssets, exists } from "./export-service";

/**
 * Exports a 3D map the way game engines import terrains:
 *
 *   <id>.json            map description: terrain info, objects used, placements
 *                        (world positions resolved on the terrain, bounding boxes)
 *   <id>.heights.f32     heightmap, resolution² little-endian float32, row-major (x first, z rows)
 *   <id>.splat.rgba      paint weights, resolution² × 4 bytes (channel i = terrain layer i)
 *   <id>.details.rgba    grass/flower density, resolution² × 4 bytes (channel i = detail layer i)
 *   <id>.terrain.glb     the terrain as a ready-to-use mesh (vertex colors = blended layers)
 *   <id>.water.glb       the water surfaces (sea + lakes), one mesh each (only if there's water)
 *   assets/…             models, sprites and terrain textures (copyAssets)
 */
export async function exportMap3D(
  project: KreaProject,
  assets: Map<string, Uint8Array>,
  map: Map3D,
  options: ExportRequestOptions,
): Promise<ExportResponse> {
  const dest = path.resolve(options.destination.trim());
  const file = path.extname(dest).toLowerCase() === ".json" ? dest : path.join(dest, `${slugifyId(map.id)}.json`);
  const folder = path.dirname(file);
  const stem = path.basename(file, ".json");
  const t = map.terrain;
  const hasWater = t.waterLevel !== null || map.waters.length > 0;
  const terrainNames: Record<string, string> = {
    heights: `${stem}.heights.f32`,
    splat: `${stem}.splat.rgba`,
    details: `${stem}.details.rgba`,
    mesh: `${stem}.terrain.glb`,
    ...(hasWater ? { water: `${stem}.water.glb` } : {}),
  };
  if (!options.overwrite) {
    for (const f of [file, ...Object.values(terrainNames).map((n) => path.join(folder, n))]) {
      if (await exists(f)) throw new ProjectError(`"${f}" already exists — pass overwrite to replace it.`, 409);
    }
  }

  const usedIds = new Set(map.placements.map((p) => p.objectId));
  const usedObjects = project.objects.filter((o) => usedIds.has(o.id));
  const objectById = new Map(usedObjects.map((o) => [o.id, o]));

  const imageSizes = new Map<string, { width: number; height: number } | null>();
  const decode = async (rel: string) => {
    if (imageSizes.has(rel)) return imageSizes.get(rel)!;
    const key = normalizeAssetKey(rel);
    const data = key ? assets.get(key) : undefined;
    const img = data ? await loadImage(Buffer.from(data)).catch(() => null) : null;
    const size = img ? { width: img.width, height: img.height } : null;
    imageSizes.set(rel, size);
    return size;
  };
  const modelBounds = new Map<string, { min: [number, number, number]; max: [number, number, number] } | null>();
  for (const obj of usedObjects) {
    for (const s of obj.sprites) await decode(s.image);
    if (obj.model && !modelBounds.has(obj.model)) {
      const key = normalizeAssetKey(obj.model);
      const data = key ? assets.get(key) : undefined;
      try {
        modelBounds.set(obj.model, data ? parseGlb(data).bounds : null);
      } catch {
        modelBounds.set(obj.model, null);
      }
    }
  }

  const stats = terrainStats(t);
  const document = {
    format: "krea-map-export",
    version: 1,
    kind: "3d",
    project: { name: project.name },
    map: { id: map.id, name: map.name },
    coordinates: "Meters. x east, y up, z south (z grows downward on the top view). Rotation: yaw in degrees, counter-clockwise seen from above.",
    terrain: {
      width: t.size.width,
      depth: t.size.depth,
      resolution: t.resolution,
      sampleSpacing: sampleSpacing(t),
      minHeight: stats.minHeight,
      maxHeight: stats.maxHeight,
      waterLevel: t.waterLevel,
      heightsFile: terrainNames.heights,
      heightsFormat: "float32 little-endian, resolution × resolution, row-major: index = iz * resolution + ix, world x = ix * sampleSpacing.dx, z = iz * sampleSpacing.dz",
      splatFile: terrainNames.splat,
      splatFormat: "uint8 × 4 per sample, same order as heights; channel i = layers[i], weights sum to 255",
      meshFile: terrainNames.mesh,
      waterMeshFile: terrainNames.water ?? null,
      layers: t.layers.map((l, channel) => ({ ...l, texture: l.texture ?? null, channel, coverage: stats.layerCoverage[channel]?.share ?? 0 })),
      detailsFile: terrainNames.details,
      detailsFormat:
        "uint8 × 4 per sample, same order as heights; channel i = detailLayers[i]; tufts per m² = detailLayers[i].density × value / 255 (Unity: TerrainData.SetDetailLayer)",
      detailLayers: t.detailLayers.map((l, channel) => ({ ...l, sprite: l.sprite ?? null, model: l.model ?? null, channel })),
    },
    /**
     * Lakes and ponds at their own heights: water fills the basin around (x, z) up to `level`.
     * `cells` lists the wet heightmap cells [ix, iz] (the cell between samples ix..ix+1, iz..iz+1) —
     * a ready-made mask for "is the player in water" checks; the meshes are in waterMeshFile.
     */
    waters: map.waters.map((w) => {
      const mask = waterMask(t, w);
      const { dx, dz } = sampleSpacing(t);
      return {
        ...w,
        color: w.color ?? DEFAULT_WATER_COLOR,
        area: w.area ?? null,
        surfaceArea: Math.round(waterSampleCount(mask) * dx * dz),
        cells: wetCells(t, mask).map((c) => [c.ix, c.iz]),
      };
    }),
    layers: map.layers.map((l, index) => ({ id: l.id, name: l.name, visible: l.visible, index })),
    objects: usedObjects.map((o) => ({
      id: o.id,
      name: o.name,
      kind: o.kind,
      description: o.description ?? null,
      model: o.model ?? null,
      /** 2D objects on a 3D map are upright billboards (1 m per tile of width). */
      billboard: o.kind === "2d" && o.sprites.length > 0 ? billboardSize(o, imageSizes.get(getSprite(o)!.image) ?? null) : null,
      sizeInTiles: getObjectSize(o),
      defaultSpriteId: o.defaultSpriteId ?? null,
      sprites: o.sprites.map((s) => ({
        id: s.id,
        name: s.name,
        image: s.image,
        imageWidth: imageSizes.get(s.image)?.width ?? null,
        imageHeight: imageSizes.get(s.image)?.height ?? null,
        collisions: s.collisions,
      })),
    })),
    placements: map.placements.map((p) => {
      const def = objectById.get(p.objectId);
      const sprite = def?.kind === "2d" ? getSprite(def, p.spriteId) : undefined;
      const bounds = objectLocalBounds(def, def?.model ? (modelBounds.get(def.model) ?? null) : null, sprite ? (imageSizes.get(sprite.image) ?? null) : null);
      return {
        id: p.id,
        objectId: p.objectId,
        layerId: p.layerId,
        spriteId: sprite?.id ?? null,
        /** World position of the object's origin: on the terrain, plus elevation. */
        position: placementOrigin(t, p),
        elevation: p.elevation,
        rotation: p.rotation,
        scale: p.scale,
        /** Oriented bounding box (world meters) — a simple default collider. */
        bounds: placementBox(t, p, bounds),
      };
    }),
  };

  await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(file, JSON.stringify(document, null, 2), "utf-8");
  await fs.writeFile(path.join(folder, terrainNames.heights), floatsToBytes(t.heights));
  await fs.writeFile(path.join(folder, terrainNames.splat), t.splat);
  await fs.writeFile(path.join(folder, terrainNames.details), t.details);
  const layerColors = await Promise.all(t.layers.map((l) => averageLayerColor(assets, l.texture, l.color)));
  await fs.writeFile(path.join(folder, terrainNames.mesh), buildTerrainGlb(t, layerColors));
  if (terrainNames.water) await fs.writeFile(path.join(folder, terrainNames.water), buildWaterGlb(map));

  const assetsCopied: string[] = [];
  const assetsSkipped: string[] = [];
  if (options.copyAssets !== false) {
    const wanted = new Set<string>();
    for (const o of usedObjects) {
      for (const s of o.sprites) wanted.add(s.image);
      if (o.model) wanted.add(o.model);
    }
    for (const l of t.layers) if (l.texture) wanted.add(l.texture);
    for (const l of t.detailLayers) {
      if (l.sprite) wanted.add(l.sprite);
      if (l.model) wanted.add(l.model);
    }
    await copyAssets(assets, wanted, folder, options.overwrite === true, assetsCopied, assetsSkipped);
  }
  return { file, terrainFiles: Object.values(terrainNames).map((n) => path.join(folder, n)), assetsCopied, assetsSkipped };
}

/** The water surfaces as glTF meshes: "sea" (a plane over the whole terrain) and one mesh per lake (its wet cells). */
export function buildWaterGlb(map: Map3D): Uint8Array {
  const t = map.terrain;
  const { dx, dz } = sampleSpacing(t);
  const meshes: GlbMeshInput[] = [];
  const surface = (quads: Array<[number, number, number, number]>, level: number) => {
    const positions: number[] = [];
    const indices: number[] = [];
    for (const [x0, z0, x1, z1] of quads) {
      const base = positions.length / 3;
      positions.push(x0, level, z0, x1, level, z0, x0, level, z1, x1, level, z1);
      indices.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
    }
    return {
      positions: Float32Array.from(positions),
      normals: Float32Array.from(positions.map((_, i) => (i % 3 === 1 ? 1 : 0))),
      indices: Uint32Array.from(indices),
    };
  };
  if (t.waterLevel !== null) {
    meshes.push({ name: "sea", primitives: [{ ...surface([[0, 0, t.size.width, t.size.depth]], t.waterLevel), color: hexToLinear(DEFAULT_WATER_COLOR, 0.7), roughness: 0.1, doubleSided: true }] });
  }
  for (const w of map.waters) {
    const cells = wetCells(t, waterMask(t, w));
    if (cells.length === 0) continue;
    const quads = cells.map((c): [number, number, number, number] => [c.ix * dx, c.iz * dz, (c.ix + 1) * dx, (c.iz + 1) * dz]);
    meshes.push({ name: w.id, primitives: [{ ...surface(quads, w.level), color: hexToLinear(w.color ?? DEFAULT_WATER_COLOR, 0.7), roughness: 0.1, doubleSided: true }] });
  }
  return writeGlb(meshes);
}

/** A layer's average color: its texture's mean pixel, or its plain color. Returned as sRGB 0-1. */
async function averageLayerColor(assets: Map<string, Uint8Array>, texture: string | undefined, color: string): Promise<[number, number, number]> {
  const fallback = hexToRgb(color).map((v) => v / 255) as [number, number, number];
  const key = texture ? normalizeAssetKey(texture) : null;
  const data = key ? assets.get(key) : undefined;
  if (!data) return fallback;
  const img = await loadImage(Buffer.from(data)).catch(() => null);
  if (!img) return fallback;
  const w = Math.min(img.width, 64);
  const h = Math.min(img.height, 64);
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0, w, h);
  const px = ctx.getImageData(0, 0, w, h).data;
  const sum = [0, 0, 0];
  for (let i = 0; i < px.length; i += 4) for (let c = 0; c < 3; c++) sum[c] += px[i + c];
  const n = px.length / 4;
  return [sum[0] / n / 255, sum[1] / n / 255, sum[2] / n / 255];
}

/** The terrain as a glTF mesh: one vertex per heightmap sample, colored by its blended layers. */
export function buildTerrainGlb(t: TerrainData, layerColors: Array<[number, number, number]>): Uint8Array {
  const res = t.resolution;
  const { dx, dz } = sampleSpacing(t);
  const count = res * res;
  const positions = new Float32Array(count * 3);
  const normals = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  for (let iz = 0; iz < res; iz++) {
    for (let ix = 0; ix < res; ix++) {
      const i = iz * res + ix;
      const x = ix * dx;
      const z = iz * dz;
      positions.set([x, t.heights[i], z], i * 3);
      const n = normalAt(t, x, z);
      normals.set([n.x, n.y, n.z], i * 3);
      let sum = 0;
      const rgb = [0, 0, 0];
      for (let c = 0; c < Math.min(SPLAT_CHANNELS, layerColors.length); c++) {
        const w = t.splat[i * SPLAT_CHANNELS + c];
        sum += w;
        for (let k = 0; k < 3; k++) rgb[k] += w * layerColors[c][k];
      }
      for (let k = 0; k < 3; k++) colors[i * 3 + k] = toLinear(sum > 0 ? rgb[k] / sum : 0.5);
    }
  }
  const indices = new Uint32Array((res - 1) * (res - 1) * 6);
  let k = 0;
  for (let iz = 0; iz < res - 1; iz++) {
    for (let ix = 0; ix < res - 1; ix++) {
      const a = iz * res + ix;
      const b = a + 1;
      const c = a + res;
      const d = c + 1;
      // Counter-clockwise seen from above (+y), so faces point up.
      indices.set([a, c, b, b, c, d], k);
      k += 6;
    }
  }
  return writeGlb([{ name: "terrain", primitives: [{ positions, normals, colors, indices, color: [1, 1, 1, 1], roughness: 1 }] }]);
}
