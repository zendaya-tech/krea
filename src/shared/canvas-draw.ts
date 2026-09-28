import type { ResolvedShape } from "@core/collision-geometry";
import { RENDER_THEME } from "./render-theme";

/**
 * The Canvas 2D subset these helpers need. Both the browser's context and
 * @napi-rs/canvas's (server screenshots) satisfy it, so the editor and the
 * headless renderer draw collisions and markers identically.
 */
export interface Draw2D {
  fillStyle: unknown;
  strokeStyle: unknown;
  lineWidth: number;
  beginPath(): void;
  closePath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  arc(x: number, y: number, radius: number, startAngle: number, endAngle: number): void;
  fill(): void;
  stroke(): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  strokeRect(x: number, y: number, w: number, h: number): void;
  setLineDash(segments: number[]): void;
}

/** Traces a resolved collision shape as the current path. */
export function traceShape(ctx: Draw2D, shape: ResolvedShape): void {
  ctx.beginPath();
  if (shape.type === "circle") {
    ctx.arc(shape.cx, shape.cy, shape.radius, 0, Math.PI * 2);
  } else {
    shape.points.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
    ctx.closePath();
  }
}

export function drawCollisionOverlays(ctx: Draw2D, shapes: ResolvedShape[]): void {
  ctx.fillStyle = RENDER_THEME.collisionFill;
  ctx.strokeStyle = RENDER_THEME.collisionStroke;
  ctx.lineWidth = 1.5;
  for (const shape of shapes) {
    traceShape(ctx, shape);
    ctx.fill();
    ctx.stroke();
  }
}

/** A sprite-less (invisible) object: a dashed, crossed box over its footprint. */
export function drawInvisibleMarker(ctx: Draw2D, rect: { x: number; y: number; width: number; height: number }): void {
  const inset = 1.5;
  const x = rect.x + inset;
  const y = rect.y + inset;
  const w = rect.width - inset * 2;
  const h = rect.height - inset * 2;
  ctx.fillStyle = RENDER_THEME.markerFill;
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = RENDER_THEME.markerStroke;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([4, 3]);
  ctx.strokeRect(x, y, w, h);
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + w, y + h);
  ctx.moveTo(x + w, y);
  ctx.lineTo(x, y + h);
  ctx.stroke();
}
