import { createCanvas, loadImage, type Image } from "@napi-rs/canvas";
import type { KreaProject, MapObjectInstance } from "@core/map-types";
import { buildCellIndex, cellKey, get2DMap, getObjectSize, getSprite, instanceCollisions } from "@core/map-utils";
import { resolveShapeInRect, type ResolvedShape } from "@core/collision-geometry";
import { RENDER_THEME } from "@shared/render-theme";
import { drawCollisionOverlays, drawInvisibleMarker } from "@shared/canvas-draw";
import { ProjectError } from "./project-service";
import { normalizeAssetKey } from "./project-file-service";

export interface RenderParams {
  /** Top-left grid cell of the capture region. */
  x: number;
  y: number;
  cols: number;
  rows: number;
  zoom: number;
  showGrid: boolean;
  showCollisions: boolean;
  /** Restrict to these layer ids (rendered even if hidden); defaults to the map's visible layers. */
  layerIds?: string[];
}

const MAX_OUTPUT_PX = 4096;

/** Decodes archive images once per render, keyed by asset path. */
export function createImageLoader(assets: Map<string, Uint8Array>) {
  const cache = new Map<string, Image | null>();
  return async (relPath: string): Promise<Image | null> => {
    const cached = cache.get(relPath);
    if (cached !== undefined) return cached;
    const key = normalizeAssetKey(relPath);
    const data = key ? assets.get(key) : undefined;
    let img: Image | null = null;
    if (data) img = await loadImage(Buffer.from(data)).catch(() => null);
    cache.set(relPath, img);
    return img;
  };
}

/** Renders a region of one map to PNG, server-side (no browser). */
export async function renderRegion(
  project: KreaProject,
  assets: Map<string, Uint8Array>,
  mapId: string,
  params: RenderParams,
): Promise<Buffer> {
  const map = get2DMap(project, mapId);
  if (!map) throw new ProjectError(`2D map "${mapId}" not found in the project.`, 404);

  const { tileWidth, tileHeight } = map.settings;
  const zoom = params.zoom > 0 ? params.zoom : 1;
  const cols = Math.max(1, Math.floor(params.cols));
  const rows = Math.max(1, Math.floor(params.rows));
  const outWidth = Math.round(cols * tileWidth * zoom);
  const outHeight = Math.round(rows * tileHeight * zoom);
  if (outWidth > MAX_OUTPUT_PX || outHeight > MAX_OUTPUT_PX) {
    throw new ProjectError(`Requested output ${outWidth}x${outHeight}px exceeds the ${MAX_OUTPUT_PX}px limit.`, 400);
  }

  const canvas = createCanvas(outWidth, outHeight);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = RENDER_THEME.mapBackground;
  ctx.fillRect(0, 0, outWidth, outHeight);
  ctx.imageSmoothingEnabled = false;

  const objectById = new Map(project.objects.map((o) => [o.id, o]));
  const cellIndex = buildCellIndex(map.mapping, project.objects);
  const getImage = createImageLoader(assets);
  // An explicit layer list is an override: render those layers even if hidden.
  const layers = params.layerIds ? map.layers.filter((l) => params.layerIds!.includes(l.id)) : map.layers.filter((l) => l.visible);
  const collisionOverlays: ResolvedShape[] = [];

  for (const layer of layers) {
    const drawn = new Set<MapObjectInstance>();
    for (let cy = 0; cy < rows; cy++) {
      for (let cx = 0; cx < cols; cx++) {
        const inst = cellIndex.get(cellKey(layer.id, params.x + cx, params.y + cy));
        if (!inst || drawn.has(inst)) continue;
        drawn.add(inst);

        const def = objectById.get(inst.objectId);
        const sprite = getSprite(def, inst.spriteId);
        const size = getObjectSize(def);
        // Relative to the capture region, from the instance's true origin — a multi-cell
        // object first seen mid-footprint must still be drawn from its top-left.
        const rect = {
          x: (inst.x - params.x) * tileWidth * zoom,
          y: (inst.y - params.y) * tileHeight * zoom,
          width: tileWidth * size.width * zoom,
          height: tileHeight * size.height * zoom,
        };
        const img = sprite ? await getImage(sprite.image) : null;
        if (img) {
          ctx.drawImage(img, rect.x, rect.y, rect.width, rect.height);
        } else if (def && !sprite) {
          drawInvisibleMarker(ctx, rect);
        } else {
          ctx.fillStyle = def ? RENDER_THEME.placeholder : RENDER_THEME.error;
          ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
        }
        if (params.showCollisions) {
          const collisions = instanceCollisions(def, sprite, img ? { width: img.width, height: img.height } : null);
          for (const shape of collisions?.shapes ?? []) collisionOverlays.push(resolveShapeInRect(shape, collisions!.space, rect));
        }
      }
    }
  }

  if (params.showGrid && zoom >= 0.2) {
    ctx.strokeStyle = RENDER_THEME.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let cx = 0; cx <= cols; cx++) {
      const px = Math.round(cx * tileWidth * zoom) + 0.5;
      ctx.moveTo(px, 0);
      ctx.lineTo(px, outHeight);
    }
    for (let cy = 0; cy <= rows; cy++) {
      const py = Math.round(cy * tileHeight * zoom) + 0.5;
      ctx.moveTo(0, py);
      ctx.lineTo(outWidth, py);
    }
    ctx.stroke();
  }

  drawCollisionOverlays(ctx, collisionOverlays);

  return canvas.toBuffer("image/png");
}
