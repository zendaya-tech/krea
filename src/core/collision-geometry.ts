import type { CollisionShape, CollisionShapeType, Point } from "./map-types";

/**
 * Pure geometry for collision shapes. Shapes are authored in sprite-image
 * pixel space (see CollisionShape); these helpers hit-test them, convert
 * between a shape's local (unrotated) frame and sprite space, and map them
 * onto any target rectangle — an instance's footprint in world pixels for
 * export, or on screen for the editor overlay.
 */

export interface Size {
  width: number;
  height: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type ResolvedShape =
  | { type: "rect"; cx: number; cy: number; width: number; height: number; rotation: number; points: Point[] }
  | { type: "circle"; cx: number; cy: number; radius: number }
  | { type: "triangle"; cx: number; cy: number; rotation: number; points: Point[] };

const DEG = Math.PI / 180;

export function rotateVector(p: Point, degrees: number): Point {
  const a = degrees * DEG;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  return { x: p.x * cos - p.y * sin, y: p.x * sin + p.y * cos };
}

export function normalizeDegrees(degrees: number): number {
  let d = degrees % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

function shapeRotation(shape: CollisionShape): number {
  return shape.type === "circle" ? 0 : shape.rotation;
}

/** Sprite-space point -> the shape's local frame (centered on the shape, rotation undone). */
export function toShapeLocal(shape: CollisionShape, p: Point): Point {
  return rotateVector({ x: p.x - shape.x, y: p.y - shape.y }, -shapeRotation(shape));
}

/** The shape's local frame -> sprite space. */
export function fromShapeLocal(shape: CollisionShape, local: Point): Point {
  const r = rotateVector(local, shapeRotation(shape));
  return { x: shape.x + r.x, y: shape.y + r.y };
}

/** Local-frame vertices for polygonal shapes (rect corners clockwise, triangle points); null for circles. */
export function localVertices(shape: CollisionShape): Point[] | null {
  if (shape.type === "rect") {
    const hw = shape.width / 2;
    const hh = shape.height / 2;
    return [
      { x: -hw, y: -hh },
      { x: hw, y: -hh },
      { x: hw, y: hh },
      { x: -hw, y: hh },
    ];
  }
  if (shape.type === "triangle") return shape.points.map((p) => ({ ...p }));
  return null;
}

/** Sprite-space vertices (rotation applied) for polygonal shapes; null for circles. */
export function shapeVertices(shape: CollisionShape): Point[] | null {
  const local = localVertices(shape);
  return local ? local.map((p) => fromShapeLocal(shape, p)) : null;
}

function pointInTriangle(p: Point, a: Point, b: Point, c: Point): boolean {
  const sign = (p1: Point, p2: Point, p3: Point) => (p1.x - p3.x) * (p2.y - p3.y) - (p2.x - p3.x) * (p1.y - p3.y);
  const d1 = sign(p, a, b);
  const d2 = sign(p, b, c);
  const d3 = sign(p, c, a);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

/** Whether a sprite-space point lies inside the shape. */
export function hitTestShape(shape: CollisionShape, p: Point): boolean {
  if (shape.type === "circle") {
    return Math.hypot(p.x - shape.x, p.y - shape.y) <= shape.radius;
  }
  const local = toShapeLocal(shape, p);
  if (shape.type === "rect") {
    return Math.abs(local.x) <= shape.width / 2 && Math.abs(local.y) <= shape.height / 2;
  }
  const [a, b, c] = shape.points;
  return pointInTriangle(local, a, b, c);
}

/** A reasonable starting shape, centered on the sprite and sized relative to it. */
export function createDefaultShape(type: CollisionShapeType, sprite: Size, id: string): CollisionShape {
  const cx = sprite.width / 2;
  const cy = sprite.height / 2;
  const min = Math.min(sprite.width, sprite.height);
  if (type === "rect") {
    return { id, type, x: cx, y: cy, width: sprite.width * 0.6, height: sprite.height * 0.6, rotation: 0 };
  }
  if (type === "circle") {
    return { id, type, x: cx, y: cy, radius: min * 0.3 };
  }
  const r = min * 0.3;
  return {
    id,
    type,
    x: cx,
    y: cy,
    rotation: 0,
    points: [
      { x: 0, y: -r },
      { x: r * 0.866, y: r * 0.5 },
      { x: -r * 0.866, y: r * 0.5 },
    ],
  };
}

/**
 * Maps a sprite-space shape onto a target rectangle the sprite is drawn into
 * (the sprite is stretched to fill it, exactly like the renderer does).
 * Polygon vertices are scaled exactly; a circle's radius uses the smaller
 * axis scale, since a non-uniformly stretched circle would be an ellipse.
 */
export function resolveShapeInRect(shape: CollisionShape, sprite: Size, target: Rect): ResolvedShape {
  const sx = target.width / sprite.width;
  const sy = target.height / sprite.height;
  const map = (p: Point): Point => ({ x: target.x + p.x * sx, y: target.y + p.y * sy });
  const center = map({ x: shape.x, y: shape.y });

  if (shape.type === "circle") {
    return { type: "circle", cx: center.x, cy: center.y, radius: shape.radius * Math.min(sx, sy) };
  }
  const points = (shapeVertices(shape) ?? []).map(map);
  if (shape.type === "rect") {
    return {
      type: "rect",
      cx: center.x,
      cy: center.y,
      width: shape.width * sx,
      height: shape.height * sy,
      rotation: shape.rotation,
      points,
    };
  }
  return { type: "triangle", cx: center.x, cy: center.y, rotation: shape.rotation, points };
}

/** Structural problems with a shape, or null if it's valid. */
export function describeShapeProblem(shape: unknown): string | null {
  if (typeof shape !== "object" || shape === null) return "is not an object";
  const s = shape as Record<string, unknown>;
  const finite = (v: unknown) => typeof v === "number" && Number.isFinite(v);
  if (typeof s.id !== "string" || s.id.trim() === "") return 'has an invalid "id"';
  if (!finite(s.x) || !finite(s.y)) return 'has an invalid center "x"/"y"';
  switch (s.type) {
    case "rect":
      if (!finite(s.width) || !finite(s.height) || (s.width as number) <= 0 || (s.height as number) <= 0) {
        return "must have a positive width and height";
      }
      if (!finite(s.rotation)) return 'has an invalid "rotation"';
      return null;
    case "circle":
      if (!finite(s.radius) || (s.radius as number) <= 0) return "must have a positive radius";
      return null;
    case "triangle": {
      if (!finite(s.rotation)) return 'has an invalid "rotation"';
      const pts = s.points;
      if (!Array.isArray(pts) || pts.length !== 3 || !pts.every((p) => p && finite(p.x) && finite(p.y))) {
        return "must have exactly 3 points with numeric x/y";
      }
      return null;
    }
    default:
      return `has an unknown type "${String(s.type)}" (expected rect, circle, or triangle)`;
  }
}
