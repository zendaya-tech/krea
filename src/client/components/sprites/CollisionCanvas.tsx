import { useEffect, useRef, useState } from "react";
import { FOOTPRINT_PX_PER_TILE, type CollisionShape, type Point } from "@core/map-types";
import {
  fromShapeLocal,
  hitTestShape,
  localVertices,
  normalizeDegrees,
  resolveShapeInRect,
  toShapeLocal,
  type Size,
} from "@core/collision-geometry";
import { traceShape } from "@shared/canvas-draw";
import { RENDER_THEME } from "@shared/render-theme";
import { ensureImageLoaded, getCachedImage, subscribeImageCache } from "../../canvas/image-cache";

const CANVAS_W = 520;
const CANVAS_H = 440;
const PADDING = 48;
const HANDLE_RADIUS = 6;
const ROTATE_HANDLE_OFFSET = 26; // screen px above the shape

type HandleKind = { kind: "corner"; index: number } | { kind: "radius" } | { kind: "vertex"; index: number } | { kind: "rotate" };
type Drag = { shapeId: string } & ({ kind: "move"; offset: Point } | HandleKind);

const round = (v: number) => Math.round(v * 10) / 10;

interface View {
  scale: number;
  ox: number;
  oy: number;
}

function computeView(size: Size): View {
  const scale = Math.min((CANVAS_W - PADDING * 2) / size.width, (CANVAS_H - PADDING * 2) / size.height);
  return { scale, ox: (CANVAS_W - size.width * scale) / 2, oy: (CANVAS_H - size.height * scale) / 2 };
}

/** Handle positions (sprite space) for the selected shape. */
function handlesFor(shape: CollisionShape, view: View): Array<{ handle: HandleKind; at: Point }> {
  const rotateLift = ROTATE_HANDLE_OFFSET / view.scale;
  if (shape.type === "circle") return [{ handle: { kind: "radius" }, at: { x: shape.x + shape.radius, y: shape.y } }];
  const verts = localVertices(shape)!;
  const topY = Math.min(...verts.map((v) => v.y));
  const kind = shape.type === "rect" ? "corner" : "vertex";
  return [
    ...verts.map((v, index) => ({ handle: { kind, index } as HandleKind, at: fromShapeLocal(shape, v) })),
    { handle: { kind: "rotate" }, at: fromShapeLocal(shape, { x: 0, y: topY - rotateLift }) },
  ];
}

/** Applies a handle drag to a shape; `p` is the pointer in sprite space. */
function dragHandle(shape: CollisionShape, handle: HandleKind, p: Point, snap: boolean): CollisionShape {
  if (handle.kind === "rotate" && shape.type !== "circle") {
    let deg = (Math.atan2(p.y - shape.y, p.x - shape.x) * 180) / Math.PI + 90;
    if (snap) deg = Math.round(deg / 15) * 15;
    return { ...shape, rotation: round(normalizeDegrees(deg)) };
  }
  if (handle.kind === "radius" && shape.type === "circle") {
    return { ...shape, radius: round(Math.max(0.5, Math.hypot(p.x - shape.x, p.y - shape.y))) };
  }
  const local = toShapeLocal(shape, p);
  if (handle.kind === "corner" && shape.type === "rect") {
    // Resizes symmetrically around the center, so rotation never makes the math drift.
    return { ...shape, width: round(Math.max(1, Math.abs(local.x) * 2)), height: round(Math.max(1, Math.abs(local.y) * 2)) };
  }
  if (handle.kind === "vertex" && shape.type === "triangle") {
    const points = shape.points.map((pt, i) => (i === handle.index ? { x: round(local.x), y: round(local.y) } : pt)) as typeof shape.points;
    return { ...shape, points };
  }
  return shape;
}

/**
 * Draws a sprite at a comfortable zoom with its collision shapes on top, and
 * lets the user move them, resize them from their handles, and rotate them.
 * All coordinates it emits are in the sprite image's own pixel space — or,
 * with `image: null` (a sprite-less object), in `footprintSize` space.
 */
export function CollisionCanvas({
  image,
  footprintSize,
  shapes,
  selectedShapeId,
  onSelect,
  onChange,
  onImageSize,
}: {
  image: string | null;
  /** Editing space when there's no image: the object's footprint at FOOTPRINT_PX_PER_TILE. */
  footprintSize?: Size;
  shapes: CollisionShape[];
  selectedShapeId: string | null;
  onSelect: (id: string | null) => void;
  onChange: (shape: CollisionShape) => void;
  onImageSize: (size: Size | null) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef<Drag | null>(null);
  const [imageTick, setImageTick] = useState(0);

  const entry = image ? getCachedImage(image) : undefined;
  const img = entry?.status === "loaded" ? (entry.img ?? null) : null;
  const size: Size | null = image ? (img ? { width: img.naturalWidth, height: img.naturalHeight } : null) : (footprintSize ?? null);
  const view = size ? computeView(size) : null;

  useEffect(() => {
    if (!image) return;
    ensureImageLoaded(image);
    return subscribeImageCache(() => setImageTick((t) => t + 1));
  }, [image]);

  // Keyed on the dimensions: `size` is a new object every render.
  useEffect(() => {
    onImageSize(size);
  }, [size?.width, size?.height, image]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = CANVAS_W * dpr;
    canvas.height = CANVAS_H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Checkerboard so transparent sprite areas are visible.
    for (let y = 0; y < CANVAS_H; y += 16) {
      for (let x = 0; x < CANVAS_W; x += 16) {
        ctx.fillStyle = (x / 16 + y / 16) % 2 === 0 ? "#2a2c31" : "#232529";
        ctx.fillRect(x, y, 16, 16);
      }
    }
    if (!size || !view || (image && !img)) {
      ctx.fillStyle = "#9aa0a8";
      ctx.font = "13px sans-serif";
      ctx.fillText(entry?.status === "error" ? "Image not found in project." : "Loading sprite…", 20, 30);
      return;
    }

    const spriteRect = { x: view.ox, y: view.oy, width: size.width * view.scale, height: size.height * view.scale };
    if (img) {
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(img, spriteRect.x, spriteRect.y, spriteRect.width, spriteRect.height);
    } else {
      // Sprite-less object: show its footprint, one cell per FOOTPRINT_PX_PER_TILE pixels.
      ctx.fillStyle = RENDER_THEME.markerFill;
      ctx.fillRect(spriteRect.x, spriteRect.y, spriteRect.width, spriteRect.height);
      ctx.strokeStyle = "rgba(190, 150, 255, 0.35)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      const cell = FOOTPRINT_PX_PER_TILE * view.scale;
      for (let x = spriteRect.x + cell; x < spriteRect.x + spriteRect.width - 0.5; x += cell) {
        ctx.moveTo(x, spriteRect.y);
        ctx.lineTo(x, spriteRect.y + spriteRect.height);
      }
      for (let y = spriteRect.y + cell; y < spriteRect.y + spriteRect.height - 0.5; y += cell) {
        ctx.moveTo(spriteRect.x, y);
        ctx.lineTo(spriteRect.x + spriteRect.width, y);
      }
      ctx.stroke();
    }
    ctx.strokeStyle = "rgba(255,255,255,0.35)";
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 1;
    ctx.strokeRect(spriteRect.x - 0.5, spriteRect.y - 0.5, spriteRect.width + 1, spriteRect.height + 1);
    ctx.setLineDash([]);

    for (const shape of shapes) {
      const selected = shape.id === selectedShapeId;
      traceShape(ctx, resolveShapeInRect(shape, size, spriteRect));
      ctx.fillStyle = selected ? "rgba(90, 169, 255, 0.28)" : "rgba(255, 80, 80, 0.25)";
      ctx.strokeStyle = selected ? "#5aa9ff" : "rgba(255, 110, 110, 0.95)";
      ctx.lineWidth = selected ? 2 : 1.5;
      ctx.fill();
      ctx.stroke();
    }

    const selected = shapes.find((s) => s.id === selectedShapeId);
    if (selected) {
      const toCanvas = (p: Point) => ({ x: view.ox + p.x * view.scale, y: view.oy + p.y * view.scale });
      const center = toCanvas({ x: selected.x, y: selected.y });
      for (const { handle, at } of handlesFor(selected, view)) {
        const c = toCanvas(at);
        if (handle.kind === "rotate") {
          ctx.strokeStyle = "#5aa9ff";
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(center.x, center.y);
          ctx.lineTo(c.x, c.y);
          ctx.stroke();
        }
        ctx.beginPath();
        if (handle.kind === "rotate" || handle.kind === "radius") ctx.arc(c.x, c.y, HANDLE_RADIUS, 0, Math.PI * 2);
        else ctx.rect(c.x - HANDLE_RADIUS, c.y - HANDLE_RADIUS, HANDLE_RADIUS * 2, HANDLE_RADIUS * 2);
        ctx.fillStyle = handle.kind === "rotate" ? "#5aa9ff" : "#ffffff";
        ctx.strokeStyle = "#10131a";
        ctx.lineWidth = 1.5;
        ctx.fill();
        ctx.stroke();
      }
      ctx.fillStyle = "#5aa9ff";
      ctx.beginPath();
      ctx.arc(center.x, center.y, 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
    // imageTick forces a redraw once the sprite image finishes loading.
  }, [img, size?.width, size?.height, shapes, selectedShapeId, imageTick, entry?.status, view?.scale]);

  function eventPoints(e: React.PointerEvent<HTMLCanvasElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const canvasPt = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    const spritePt = view ? { x: (canvasPt.x - view.ox) / view.scale, y: (canvasPt.y - view.oy) / view.scale } : canvasPt;
    return { canvasPt, spritePt };
  }

  function handlePointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!view) return;
    const { canvasPt, spritePt } = eventPoints(e);
    e.currentTarget.setPointerCapture(e.pointerId);

    const selected = shapes.find((s) => s.id === selectedShapeId);
    if (selected) {
      for (const { handle, at } of handlesFor(selected, view)) {
        const c = { x: view.ox + at.x * view.scale, y: view.oy + at.y * view.scale };
        if (Math.hypot(c.x - canvasPt.x, c.y - canvasPt.y) <= HANDLE_RADIUS + 3) {
          dragRef.current = { shapeId: selected.id, ...handle };
          return;
        }
      }
    }
    for (let i = shapes.length - 1; i >= 0; i--) {
      const shape = shapes[i];
      if (hitTestShape(shape, spritePt)) {
        onSelect(shape.id);
        dragRef.current = { shapeId: shape.id, kind: "move", offset: { x: spritePt.x - shape.x, y: spritePt.y - shape.y } };
        return;
      }
    }
    onSelect(null);
  }

  function handlePointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    const drag = dragRef.current;
    if (!drag) return;
    const shape = shapes.find((s) => s.id === drag.shapeId);
    if (!shape) return;
    const { spritePt } = eventPoints(e);
    if (drag.kind === "move") {
      onChange({ ...shape, x: round(spritePt.x - drag.offset.x), y: round(spritePt.y - drag.offset.y) });
    } else {
      onChange(dragHandle(shape, drag, spritePt, e.shiftKey));
    }
  }

  function handlePointerUp(e: React.PointerEvent<HTMLCanvasElement>) {
    e.currentTarget.releasePointerCapture(e.pointerId);
    dragRef.current = null;
  }

  return (
    <canvas
      ref={canvasRef}
      className="collision-canvas"
      style={{ width: CANVAS_W, height: CANVAS_H }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
    />
  );
}
