import fs from "node:fs/promises";
import path from "node:path";
import type { KreaProject, Map2D } from "@core/map-types";
import { getMap, getObjectSize, getSprite, instanceCollisions, slugifyId } from "@core/map-utils";
import { validateProject } from "@core/map-validator";
import { resolveShapeInRect } from "@core/collision-geometry";
import { ProjectError } from "./project-service";
import { createImageLoader } from "./render-service";
import { normalizeAssetKey } from "./project-file-service";
import type { ExportRequestOptions, ExportResponse } from "@shared/api-types";
import { exportMap3D } from "./export3d-service";

export async function exists(p: string): Promise<boolean> {
  return fs
    .stat(p)
    .then(() => true)
    .catch(() => false);
}

/**
 * Exports one map as a self-contained, game-ready JSON file:
 * - only the objects the map uses, with all their sprites and sprite-space collisions,
 * - every instance with its pixel rect and its collisions resolved to world pixels,
 * - (by default) the sprite images copied next to the file under the same relative paths.
 */
export async function exportMap(
  project: KreaProject,
  assets: Map<string, Uint8Array>,
  options: ExportRequestOptions,
): Promise<ExportResponse> {
  const structural = validateProject(project);
  if (!structural.valid) {
    throw new ProjectError(`Project is invalid, fix it before exporting: ${structural.issues.map((i) => i.message).join("; ")}`, 400);
  }
  const map = getMap(project, options.mapId);
  if (!map) throw new ProjectError(`Map "${options.mapId}" not found in the project.`, 404);
  if (map.kind === "3d") return exportMap3D(project, assets, map, options);
  return exportMap2D(project, assets, map, options);
}

async function exportMap2D(
  project: KreaProject,
  assets: Map<string, Uint8Array>,
  map: Map2D,
  options: ExportRequestOptions,
): Promise<ExportResponse> {
  const dest = path.resolve(options.destination.trim());
  const file = path.extname(dest).toLowerCase() === ".json" ? dest : path.join(dest, `${slugifyId(map.id)}.json`);
  if (!options.overwrite && (await exists(file))) {
    throw new ProjectError(`"${file}" already exists — pass overwrite to replace it.`, 409);
  }

  const { tileWidth, tileHeight } = map.settings;
  const usedIds = new Set(map.mapping.map((m) => m.objectId));
  const usedObjects = project.objects.filter((o) => usedIds.has(o.id));
  const objectById = new Map(usedObjects.map((o) => [o.id, o]));
  const getImage = createImageLoader(assets);

  const spriteSizes = new Map<string, { width: number; height: number } | null>();
  for (const obj of usedObjects) {
    for (const sprite of obj.sprites) {
      const img = await getImage(sprite.image);
      spriteSizes.set(`${obj.id}/${sprite.id}`, img ? { width: img.width, height: img.height } : null);
    }
  }

  const instances = map.mapping.map((inst) => {
    const def = objectById.get(inst.objectId)!;
    const sprite = getSprite(def, inst.spriteId);
    const size = getObjectSize(def);
    const pixel = { x: inst.x * tileWidth, y: inst.y * tileHeight, width: size.width * tileWidth, height: size.height * tileHeight };
    // Without the image's real size, assume it was authored at footprint size.
    const imageSize = sprite ? (spriteSizes.get(`${def.id}/${sprite.id}`) ?? { width: pixel.width, height: pixel.height }) : null;
    const collisions = instanceCollisions(def, sprite, imageSize);
    return {
      objectId: inst.objectId,
      /** null for sprite-less (invisible) objects. */
      spriteId: sprite?.id ?? null,
      layerId: inst.layerId,
      x: inst.x,
      y: inst.y,
      pixel,
      collisions: (collisions?.shapes ?? []).map((shape) => ({ id: shape.id, ...resolveShapeInRect(shape, collisions!.space, pixel) })),
    };
  });

  const document = {
    format: "krea-map-export",
    version: 1,
    kind: "2d",
    project: { name: project.name },
    map: {
      id: map.id,
      name: map.name,
      width: map.settings.width,
      height: map.settings.height,
      tileWidth,
      tileHeight,
      pixelWidth: map.settings.width * tileWidth,
      pixelHeight: map.settings.height * tileHeight,
    },
    layers: map.layers.map((l, index) => ({ id: l.id, name: l.name, visible: l.visible, index })),
    objects: usedObjects.map((o) => ({
      id: o.id,
      name: o.name,
      description: o.description ?? null,
      sizeInTiles: getObjectSize(o),
      defaultSpriteId: o.defaultSpriteId ?? null,
      /** Footprint-space collisions of a sprite-less object (32 px per tile). */
      collisions: o.sprites.length === 0 ? (o.collisions ?? []) : [],
      sprites: o.sprites.map((s) => {
        const size = spriteSizes.get(`${o.id}/${s.id}`);
        return {
          id: s.id,
          name: s.name,
          image: s.image,
          imageWidth: size?.width ?? null,
          imageHeight: size?.height ?? null,
          collisions: s.collisions,
        };
      }),
    })),
    instances,
  };

  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(document, null, 2), "utf-8");

  const assetsCopied: string[] = [];
  const assetsSkipped: string[] = [];
  if (options.copyAssets !== false) {
    await copyAssets(assets, new Set(usedObjects.flatMap((o) => o.sprites.map((s) => s.image))), path.dirname(file), options.overwrite === true, assetsCopied, assetsSkipped);
  }

  return { file, assetsCopied, assetsSkipped };
}

/** Copies archive assets next to an exported file, under the same relative paths. */
export async function copyAssets(
  assets: Map<string, Uint8Array>,
  wanted: Set<string>,
  folder: string,
  overwrite: boolean,
  copied: string[],
  skipped: string[],
): Promise<void> {
  for (const rel of wanted) {
    const key = normalizeAssetKey(rel);
    const data = key ? assets.get(key) : undefined;
    if (!key || !data) {
      skipped.push(rel);
      continue;
    }
    const target = path.join(folder, key);
    if (!overwrite && (await exists(target))) {
      skipped.push(rel);
      continue;
    }
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, data);
    copied.push(rel);
  }
}
