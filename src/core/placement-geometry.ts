import type { MapObjectDefinition, Placement3D, TerrainData } from "./map-types";
import { getObjectSize } from "./map-utils";
import { heightAt } from "./terrain";

/**
 * World-space geometry of objects placed on 3D maps, shared by the server
 * renderer, the exporter and the editor. World axes: x east, y up, z south
 * (as on the 2D top view: x right, z down). Rotation is a yaw in degrees,
 * counter-clockwise seen from above (Three.js/glTF convention).
 */

export type Vec3 = { x: number; y: number; z: number };

/** Model bounds in the model's own space (before placement scale/rotation). */
export interface LocalBounds {
  min: [number, number, number];
  max: [number, number, number];
}

/** Size of the invisible marker drawn for sprite-less and model-less objects. */
export const MARKER_SIZE = 0.6;

/** A 2D object's billboard on a 3D map: 1 m per tile of width, height from the sprite's aspect ratio. */
export function billboardSize(def: MapObjectDefinition, imageSize: { width: number; height: number } | null): { width: number; height: number } {
  const tiles = getObjectSize(def);
  const width = tiles.width;
  const height = imageSize && imageSize.width > 0 ? (width * imageSize.height) / imageSize.width : tiles.height;
  return { width, height };
}

/** The local bounds of what a placement shows: its model, its billboard, or a marker cube. */
export function objectLocalBounds(
  def: MapObjectDefinition | undefined,
  modelBounds: LocalBounds | null,
  imageSize: { width: number; height: number } | null,
): LocalBounds {
  if (def?.kind === "3d" && modelBounds) return modelBounds;
  if (def?.kind === "2d" && def.sprites.length > 0) {
    const size = billboardSize(def, imageSize);
    return { min: [-size.width / 2, 0, -0.05], max: [size.width / 2, size.height, 0.05] };
  }
  const h = MARKER_SIZE / 2;
  return { min: [-h, 0, -h], max: [h, MARKER_SIZE, h] };
}

/** World position of a placement's origin: on the terrain surface, plus its elevation. */
export function placementOrigin(terrain: TerrainData, p: Placement3D): Vec3 {
  return { x: p.x, y: heightAt(terrain, p.x, p.z) + p.elevation, z: p.z };
}

/** Transforms a local point by a placement (scale, yaw, then translation to its origin). */
export function transformPoint(origin: Vec3, p: Placement3D, local: [number, number, number]): Vec3 {
  const a = (p.rotation * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const lx = local[0] * p.scale;
  const ly = local[1] * p.scale;
  const lz = local[2] * p.scale;
  // Yaw around +y (counter-clockwise seen from above, right-handed).
  return { x: origin.x + lx * cos + lz * sin, y: origin.y + ly, z: origin.z - lx * sin + lz * cos };
}

/** An oriented box: center, half extents (after scale) and yaw. */
export interface OrientedBox {
  center: Vec3;
  halfSize: Vec3;
  rotation: number;
}

export function placementBox(terrain: TerrainData, p: Placement3D, bounds: LocalBounds): OrientedBox {
  const origin = placementOrigin(terrain, p);
  const localCenter: [number, number, number] = [
    (bounds.min[0] + bounds.max[0]) / 2,
    (bounds.min[1] + bounds.max[1]) / 2,
    (bounds.min[2] + bounds.max[2]) / 2,
  ];
  return {
    center: transformPoint(origin, p, localCenter),
    halfSize: {
      x: ((bounds.max[0] - bounds.min[0]) / 2) * p.scale,
      y: ((bounds.max[1] - bounds.min[1]) / 2) * p.scale,
      z: ((bounds.max[2] - bounds.min[2]) / 2) * p.scale,
    },
    rotation: p.rotation,
  };
}

/** The 8 world-space corners of a placement's box. */
export function placementCorners(terrain: TerrainData, p: Placement3D, bounds: LocalBounds): Vec3[] {
  const origin = placementOrigin(terrain, p);
  const corners: Vec3[] = [];
  for (const x of [bounds.min[0], bounds.max[0]]) {
    for (const y of [bounds.min[1], bounds.max[1]]) {
      for (const z of [bounds.min[2], bounds.max[2]]) corners.push(transformPoint(origin, p, [x, y, z]));
    }
  }
  return corners;
}

/** Edges of placementCorners() as index pairs. */
export const BOX_EDGES: Array<[number, number]> = [
  [0, 1], [2, 3], [4, 5], [6, 7],
  [0, 2], [1, 3], [4, 6], [5, 7],
  [0, 4], [1, 5], [2, 6], [3, 7],
];
