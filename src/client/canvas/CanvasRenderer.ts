import type { EditorCamera, EditorTool, Map2D, MapObjectDefinition, MapObjectInstance } from "@core/map-types";
import { cellKey, getObjectSize, getSprite, instanceCollisions } from "@core/map-utils";
import { resolveShapeInRect, type ResolvedShape } from "@core/collision-geometry";
import { RENDER_THEME } from "@shared/render-theme";
import { drawCollisionOverlays, drawInvisibleMarker } from "@shared/canvas-draw";
import { ensureImageLoaded, getCachedImage } from "./image-cache";

export interface RenderSnapshot {
  map: Map2D;
  objects: MapObjectDefinition[];
  cellIndex: Map<string, MapObjectInstance>;
  camera: EditorCamera;
  showGrid: boolean;
  showCollisions: boolean;
  activeLayerId: string | null;
  selectedInstances: Array<{ layerId: string; x: number; y: number }>;
  hoverCell: { x: number; y: number } | null;
  tool: EditorTool;
  /** Object currently loaded on the pencil, so the hover preview can show its true footprint. */
  paintObjectId: string | null;
}

const HOVER_COLOR = "rgba(120, 170, 255, 0.25)";
const SELECTION_COLOR = "#5aa9ff";

/**
 * Imperative Canvas 2D renderer, deliberately kept outside React. It draws
 * only the cells currently in view (via the shared cellIndex, not a scan of
 * every mapping entry) so large maps stay cheap to redraw.
 */
export class CanvasRenderer {
  private ctx: CanvasRenderingContext2D;
  private canvas: HTMLCanvasElement;
  private dpr = 1;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D context unavailable");
    this.ctx = ctx;
  }

  resize(cssWidth: number, cssHeight: number): void {
    this.dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(cssWidth * this.dpr));
    const h = Math.max(1, Math.round(cssHeight * this.dpr));
    if (this.canvas.width !== w) this.canvas.width = w;
    if (this.canvas.height !== h) this.canvas.height = h;
    this.canvas.style.width = `${cssWidth}px`;
    this.canvas.style.height = `${cssHeight}px`;
  }

  render(snapshot: RenderSnapshot | null): void {
    const { ctx, canvas, dpr } = this;
    const cssWidth = canvas.width / dpr;
    const cssHeight = canvas.height / dpr;

    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = RENDER_THEME.background;
    ctx.fillRect(0, 0, cssWidth, cssHeight);

    if (!snapshot) {
      ctx.restore();
      return;
    }

    const { map, camera } = snapshot;
    const { tileWidth, tileHeight, width, height } = map.settings;
    const toScreenX = (worldX: number) => (worldX - camera.x) * camera.zoom;
    const toScreenY = (worldY: number) => (worldY - camera.y) * camera.zoom;

    const boundsX = toScreenX(0);
    const boundsY = toScreenY(0);
    const boundsW = width * tileWidth * camera.zoom;
    const boundsH = height * tileHeight * camera.zoom;
    ctx.fillStyle = RENDER_THEME.mapBackground;
    ctx.fillRect(boundsX, boundsY, boundsW, boundsH);

    const minCellX = Math.max(0, Math.floor(camera.x / tileWidth) - 1);
    const minCellY = Math.max(0, Math.floor(camera.y / tileHeight) - 1);
    const maxCellX = Math.min(width - 1, Math.ceil((camera.x + cssWidth / camera.zoom) / tileWidth) + 1);
    const maxCellY = Math.min(height - 1, Math.ceil((camera.y + cssHeight / camera.zoom) / tileHeight) + 1);

    ctx.imageSmoothingEnabled = false;
    const objectById = new Map(snapshot.objects.map((o) => [o.id, o]));
    const collisionOverlays: ResolvedShape[] = [];

    if (minCellX <= maxCellX && minCellY <= maxCellY) {
      for (const layer of map.layers) {
        if (!layer.visible) continue;
        const drawn = new Set<MapObjectInstance>();
        for (let cy = minCellY; cy <= maxCellY; cy++) {
          for (let cx = minCellX; cx <= maxCellX; cx++) {
            const inst = snapshot.cellIndex.get(cellKey(layer.id, cx, cy));
            if (!inst || drawn.has(inst)) continue;
            drawn.add(inst);

            const def = objectById.get(inst.objectId);
            const sprite = getSprite(def, inst.spriteId);
            const size = getObjectSize(def);
            const rect = {
              x: toScreenX(inst.x * tileWidth),
              y: toScreenY(inst.y * tileHeight),
              width: tileWidth * size.width * camera.zoom,
              height: tileHeight * size.height * camera.zoom,
            };
            if (!def) {
              ctx.fillStyle = RENDER_THEME.error;
              ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
              continue;
            }
            let imageSize: { width: number; height: number } | null = null;
            if (!sprite) {
              drawInvisibleMarker(ctx, rect);
            } else {
              const entry = getCachedImage(sprite.image);
              if (!entry) ensureImageLoaded(sprite.image);
              if (entry?.status === "loaded" && entry.img) {
                ctx.drawImage(entry.img, rect.x, rect.y, rect.width, rect.height);
                imageSize = { width: entry.img.naturalWidth, height: entry.img.naturalHeight };
              } else {
                ctx.fillStyle = entry?.status === "error" ? RENDER_THEME.error : RENDER_THEME.placeholder;
                ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
              }
            }
            if (snapshot.showCollisions) {
              const collisions = instanceCollisions(def, sprite, imageSize);
              for (const shape of collisions?.shapes ?? []) collisionOverlays.push(resolveShapeInRect(shape, collisions!.space, rect));
            }
          }
        }
      }
    }

    if (snapshot.showGrid && camera.zoom >= 0.2) {
      ctx.strokeStyle = RENDER_THEME.grid;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let cx = minCellX; cx <= maxCellX + 1; cx++) {
        const x = Math.round(toScreenX(cx * tileWidth)) + 0.5;
        ctx.moveTo(x, Math.max(0, boundsY));
        ctx.lineTo(x, Math.min(cssHeight, boundsY + boundsH));
      }
      for (let cy = minCellY; cy <= maxCellY + 1; cy++) {
        const y = Math.round(toScreenY(cy * tileHeight)) + 0.5;
        ctx.moveTo(Math.max(0, boundsX), y);
        ctx.lineTo(Math.min(cssWidth, boundsX + boundsW), y);
      }
      ctx.stroke();
    }

    drawCollisionOverlays(ctx, collisionOverlays);

    ctx.strokeStyle = RENDER_THEME.bounds;
    ctx.lineWidth = 2;
    ctx.strokeRect(boundsX, boundsY, boundsW, boundsH);

    // Hover highlight — sized to the object the pencil would place.
    if (snapshot.hoverCell) {
      const { x: hx, y: hy } = snapshot.hoverCell;
      if (hx >= 0 && hy >= 0 && hx < width && hy < height) {
        const paintDef = snapshot.tool === "pencil" ? objectById.get(snapshot.paintObjectId ?? "") : undefined;
        const size = getObjectSize(paintDef);
        ctx.fillStyle = HOVER_COLOR;
        ctx.fillRect(toScreenX(hx * tileWidth), toScreenY(hy * tileHeight), tileWidth * size.width * camera.zoom, tileHeight * size.height * camera.zoom);
      }
    }

    // Selection outlines, sized to each selected instance's own footprint.
    if (snapshot.selectedInstances.length > 0) {
      ctx.strokeStyle = SELECTION_COLOR;
      ctx.lineWidth = 2;
      for (const sel of snapshot.selectedInstances) {
        const inst = snapshot.cellIndex.get(cellKey(sel.layerId, sel.x, sel.y));
        const size = getObjectSize(inst ? objectById.get(inst.objectId) : undefined);
        ctx.strokeRect(
          toScreenX(sel.x * tileWidth) + 1,
          toScreenY(sel.y * tileHeight) + 1,
          tileWidth * size.width * camera.zoom - 2,
          tileHeight * size.height * camera.zoom - 2,
        );
      }
    }

    ctx.restore();
  }
}
