/**
 * Core project format (.krea). Framework-agnostic: no dependency on React,
 * Canvas, or Node — usable by the editor, a CLI, an AI agent, or a game runtime.
 *
 * A single .krea file holds the whole project: the shared object catalog and
 * every map — 2D tile maps and 3D terrain maps. Images, 3D models and 3D
 * terrain data are stored as files inside the archive (see project-codec.ts).
 */

import type { EditableModel3D } from "./model3d";

export interface MapSettings {
  width: number;
  height: number;
  tileWidth: number;
  tileHeight: number;
}

export interface MapLayer {
  id: string;
  name: string;
  visible: boolean;
  locked: boolean;
}

export interface Point {
  x: number;
  y: number;
}

/**
 * Collision shapes live in the sprite image's own pixel space (origin at the
 * image's top-left corner, units = source image pixels). `x`/`y` is the
 * shape's center and `rotation` is in degrees, clockwise, around that center.
 * Triangle `points` are offsets from the center, before rotation.
 */
export type CollisionShape =
  | { id: string; type: "rect"; x: number; y: number; width: number; height: number; rotation: number }
  | { id: string; type: "circle"; x: number; y: number; radius: number }
  | { id: string; type: "triangle"; x: number; y: number; points: [Point, Point, Point]; rotation: number };

export type CollisionShapeType = CollisionShape["type"];

export interface SpriteDefinition {
  id: string;
  name: string;
  /** Path relative to the project root, e.g. "assets/tree.png". Never absolute. */
  image: string;
  collisions: CollisionShape[];
}

/**
 * "2d": drawn from sprites — on 2D maps as tiles, on 3D maps as upright
 * billboards. "3d": a 3D model (.glb), placeable on 3D maps only.
 */
export type ObjectKind = "2d" | "3d";

export interface MapObjectDefinition {
  id: string;
  name: string;
  kind: ObjectKind;
  description?: string;
  /**
   * Footprint in grid cells, e.g. { width: 2, height: 2 } for a house.
   * Defaults to 1x1. On 3D maps, a 2D object's billboard is 1 m per tile.
   */
  sizeInTiles?: { width: number; height: number };
  /**
   * 2D objects only (empty for 3D objects). May be empty: a sprite-less
   * object is invisible in-game (spawn point, trigger zone, invisible wall…).
   * Instances show `defaultSpriteId` unless they pick another sprite.
   */
  sprites: SpriteDefinition[];
  /** Required when the object has sprites (must match one); absent when it has none. */
  defaultSpriteId?: string;
  /**
   * Collisions of a sprite-less 2D object, in "footprint space": its
   * footprint drawn at FOOTPRINT_PX_PER_TILE pixels per tile, origin
   * top-left. Ignored while the object has sprites.
   */
  collisions?: CollisionShape[];
  /** 3D objects: a .glb model inside the project (e.g. "assets/tree.glb"). Absent = invisible 3D marker. */
  model?: string;
  /** Editable source for models created in Krea; the generated .glb remains in `model`. */
  modelSource?: EditableModel3D;
}

/** Resolution of the footprint space used by sprite-less objects' collisions. */
export const FOOTPRINT_PX_PER_TILE = 32;

export interface MapObjectInstance {
  objectId: string;
  layerId: string;
  /**
   * Grid coordinates of the instance's origin (top-left cell). Multi-cell
   * objects cover x..x+width-1 / y..y+height-1 from there.
   */
  x: number;
  y: number;
  /** One of the object's sprites; omitted means the object's default sprite. */
  spriteId?: string;
}

/** A 2D tile map: objects placed on a grid of cells. */
export interface Map2D {
  kind: "2d";
  id: string;
  name: string;
  settings: MapSettings;
  layers: MapLayer[];
  mapping: MapObjectInstance[];
}

/**
 * A texture layer of a 3D terrain, blended with the others according to the
 * splatmap. `color` is used when there's no texture (and as the layer's
 * average color in previews and mesh exports).
 */
export interface TerrainLayer {
  id: string;
  name: string;
  /** Image inside the project, tiled across the terrain every `tileSize` meters. */
  texture?: string;
  /** "#rrggbb". */
  color: string;
  tileSize: number;
}

export const MAX_TERRAIN_LAYERS = 4;

/**
 * A detail layer (Unity's "Paint Details"): grass, flowers, small bushes,
 * painted as a density over the terrain rather than placed one by one. The
 * editor, screenshots and games generate the individual tufts from the
 * density map (deterministically), so a whole meadow stays light.
 * Rendered from `sprite` (crossed quads), `model` (.glb), or — with neither —
 * procedural grass blades in `color`.
 */
export interface DetailLayer {
  id: string;
  name: string;
  /** Image of one tuft (transparent PNG) — drawn as two crossed quads. */
  sprite?: string;
  /** Or a small .glb model (a flower, a bush). */
  model?: string;
  /** "#rrggbb": blade color for procedural grass, tint otherwise. */
  color: string;
  /** Tuft size in meters (a model is scaled so its height matches `height`). */
  width: number;
  height: number;
  /** 0-1: random height variation between tufts. */
  sizeVariation: number;
  /** Tufts per square meter where the painted density is 100%. */
  density: number;
}

export const MAX_DETAIL_LAYERS = 4;

/** Terrain settings; the heights and splat weights themselves are in TerrainData. */
export interface TerrainInfo {
  /** Samples per side of the heightmap (vertices), e.g. 129 → a 129×129 grid. */
  resolution: number;
  /** World size in meters: x spans [0, width], z spans [0, depth]. */
  size: { width: number; depth: number };
  /** Up to MAX_TERRAIN_LAYERS texture layers; index = splatmap channel. */
  layers: TerrainLayer[];
  /** Height of a flat water plane covering the terrain, or null for no water. */
  waterLevel: number | null;
  /** Up to MAX_DETAIL_LAYERS grass/flower layers; index = channel of `details`. */
  detailLayers: DetailLayer[];
}

/**
 * In-memory terrain. `heights` is resolution² heights in meters, row-major
 * (index = iz * resolution + ix, x first). `splat` is resolution² × 4 weights
 * (0-255, one channel per terrain layer). Sample (ix, iz) sits at world
 * x = ix * width / (resolution - 1), z = iz * depth / (resolution - 1).
 */
export interface TerrainData extends TerrainInfo {
  heights: Float32Array;
  splat: Uint8Array;
  /** resolution² × 4 painted densities (0-255), one channel per detail layer, same order as heights. */
  details: Uint8Array;
}

/** An object placed freely on a 3D terrain. It follows the terrain: y = terrain height at (x, z) + elevation. */
export interface Placement3D {
  id: string;
  objectId: string;
  layerId: string;
  /** World position in meters on the terrain. */
  x: number;
  z: number;
  /** Meters above the terrain surface (0 = standing on the ground). */
  elevation: number;
  /** Yaw in degrees around the vertical axis (glTF/Three.js convention: counter-clockwise seen from above). */
  rotation: number;
  /** Uniform scale. */
  scale: number;
  /** 2D objects shown as billboards: which sprite (default sprite if omitted). */
  spriteId?: string;
}

/**
 * A local body of water (lake, pond, pool, mountain tarn) at its own height.
 * It fills the basin around its seed point: every terrain sample below
 * `level` connected to the seed (4-neighborhood) is under water — like
 * pouring water at that point until it reaches `level`. An open basin
 * overflows as far as the terrain lets it, unless `area` clips it.
 * Independent of the terrain's global `waterLevel` (the sea).
 */
export interface WaterBody {
  id: string;
  name: string;
  /** Seed point (meters): a spot at the bottom of the basin to fill. */
  x: number;
  z: number;
  /** Water surface height in meters. */
  level: number;
  /** "#rrggbb" tint (default water blue). */
  color?: string;
  /** Optional world rectangle the water can't spread beyond. */
  area?: { x: number; z: number; width: number; depth: number };
}

/** A 3D map: a sculptable, texture-painted terrain with objects placed freely on it. */
export interface Map3D {
  kind: "3d";
  id: string;
  name: string;
  terrain: TerrainData;
  /** Lakes and ponds at their own heights (the sea is terrain.waterLevel). */
  waters: WaterBody[];
  layers: MapLayer[];
  placements: Placement3D[];
}

export type MapDocument = Map2D | Map3D;
export type MapKind = MapDocument["kind"];

export interface KreaProject {
  format: "krea";
  version: 3;
  name: string;
  /** Shared by every map: an object is defined once, placed anywhere. */
  objects: MapObjectDefinition[];
  maps: MapDocument[];
}

export const KREA_FORMAT = "krea";
export const KREA_VERSION = 3;
export const KREA_EXTENSION = ".krea";
export const DEFAULT_PROJECT_FILE = "project.krea";

export type EditorTool = "select" | "pencil" | "eraser" | "fill" | "pan";

export interface EditorCamera {
  x: number;
  y: number;
  zoom: number;
}

export const ZOOM_LEVELS = [0.25, 0.5, 0.75, 1, 1.5, 2, 4] as const;
