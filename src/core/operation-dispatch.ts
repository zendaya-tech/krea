import { describeShapeProblem } from "./collision-geometry";
import {
  MAX_DETAIL_LAYERS,
  MAX_TERRAIN_LAYERS,
  type CollisionShape,
  type DetailLayer,
  type KreaProject,
  type Map2D,
  type Map3D,
  type MapDocument,
  type MapLayer,
  type MapObjectDefinition,
  type SpriteDefinition,
  type TerrainLayer,
} from "./map-types";
import { getMap, uniqueId } from "./map-utils";
import * as ops from "./map-operations";
import * as ops3d from "./map3d-operations";
import type { ObjectDefinitionPatch, OpResult } from "./map-operations";
import { describeAssetPathProblem } from "./map-validator";
import { createDefaultMap, createDefaultMap3D, defaultTerrainLayers } from "./project-migration";
import { isHexColor } from "./terrain";

/**
 * JSON-driven access to the editing operations, for AI agents and scripts.
 * Each operation is named after the map-operations.ts function it calls, so
 * an agent edits a project through exactly the same code paths as the
 * editor UI. OPERATIONS is the single source of truth for both parameter
 * validation and the published API description (OpenAPI).
 */

export class OperationError extends Error {}

export type ParamType = "string" | "integer" | "number" | "boolean" | "object" | "array" | "string|null" | "number|null" | "object|null";

export interface ParamSpec {
  type: ParamType;
  required?: boolean;
  description: string;
}

export interface OperationOutcome {
  project: KreaProject;
  /** false when the operation was valid but changed nothing (see `detail`). */
  applied: boolean;
  detail?: string;
  /** Id of what a create/duplicate operation made, so the caller can reference it next. */
  createdId?: string;
  /** Ids of everything a bulk operation made (scatterObjects3D, duplicatePlacements3D). */
  createdIds?: string[];
}

type Params = Record<string, unknown>;

interface OperationSpec {
  description: string;
  params: Record<string, ParamSpec>;
  run: (project: KreaProject, p: Params) => OperationOutcome;
}

const NOOP_CELLS = "Nothing changed: already in that state, out of bounds, the object's footprint doesn't fit, or the layer is locked.";

function outcome(project: KreaProject, result: OpResult | null, noop = NOOP_CELLS): OperationOutcome {
  return result ? { project: result.project, applied: true } : { project, applied: false, detail: noop };
}

/** Reports the created id only when the operation actually applied. */
function created(result: OperationOutcome, id: string): OperationOutcome {
  return result.applied ? { ...result, createdId: id } : result;
}

function mapOf(project: KreaProject, mapId: unknown): MapDocument {
  const map = getMap(project, mapId as string);
  if (!map) {
    throw new OperationError(`Unknown mapId "${mapId}". Maps: ${project.maps.map((m) => `${m.id} (${m.kind})`).join(", ")}.`);
  }
  return map;
}

function map2dOf(project: KreaProject, mapId: unknown): Map2D {
  const map = mapOf(project, mapId);
  if (map.kind !== "2d") {
    throw new OperationError(`Map "${map.id}" is a 3D map: use the 3D operations (placeObject3D, sculptTerrain, paintTerrain…).`);
  }
  return map;
}

function map3dOf(project: KreaProject, mapId: unknown): Map3D {
  const map = mapOf(project, mapId);
  if (map.kind !== "3d") throw new OperationError(`Map "${map.id}" is a 2D map: use the grid operations (placeObject, fillRect…).`);
  return map;
}

function terrainLayerOf(map: Map3D, layerId: unknown): TerrainLayer {
  const layer = map.terrain.layers.find((l) => l.id === layerId);
  if (!layer) {
    throw new OperationError(`Unknown terrain layer "${layerId}" in map "${map.id}". Terrain layers: ${map.terrain.layers.map((l) => l.id).join(", ")}.`);
  }
  return layer;
}

function placementOf(map: Map3D, id: unknown) {
  const placement = map.placements.find((p) => p.id === id);
  if (!placement) throw new OperationError(`Unknown placement "${id}" in map "${map.id}".`);
  return placement;
}

function assetPath(value: unknown, where: string, extension?: RegExp): string {
  const problem = describeAssetPathProblem(value);
  if (problem) throw new OperationError(`${where}: ${problem}`);
  if (extension && !extension.test(value as string)) throw new OperationError(`${where}: unsupported file type "${value}".`);
  return (value as string).trim();
}

const MODEL_EXT = /\.glb$/i;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp)$/i;

function layerOf(map: MapDocument, layerId: unknown): MapLayer {
  const layer = map.layers.find((l) => l.id === layerId);
  if (!layer) throw new OperationError(`Unknown layerId "${layerId}" in map "${map.id}". Layers: ${map.layers.map((l) => l.id).join(", ")}.`);
  return layer;
}

function objectOf(project: KreaProject, objectId: unknown): MapObjectDefinition {
  const def = project.objects.find((o) => o.id === objectId);
  if (!def) throw new OperationError(`Unknown objectId "${objectId}". Objects: ${project.objects.map((o) => o.id).join(", ") || "(none)"}.`);
  return def;
}

function object2dOf(project: KreaProject, objectId: unknown): MapObjectDefinition {
  const def = objectOf(project, objectId);
  if (def.kind === "3d") throw new OperationError(`Object "${def.id}" is a 3D object: it can only be placed on 3D maps.`);
  return def;
}

function sizeParam(value: unknown, where: string): { width: number; height: number } | undefined {
  if (value === null || value === undefined) return undefined;
  const v = value as Params;
  const ok = (n: unknown) => typeof n === "number" && Number.isInteger(n) && n > 0;
  if (!ok(v.width) || !ok(v.height)) throw new OperationError(`${where}: "sizeInTiles" needs positive integer "width" and "height".`);
  return { width: v.width as number, height: v.height as number };
}

/** Validates shapes, filling in missing ids and a default rotation of 0. */
function normalizeShapes(input: unknown, where: string): CollisionShape[] {
  if (input === undefined) return [];
  if (!Array.isArray(input)) throw new OperationError(`${where}: "collisions" must be an array.`);
  const ids = new Set<string>();
  return input.map((raw, i) => {
    if (typeof raw !== "object" || raw === null) throw new OperationError(`${where}: collision #${i + 1} must be an object.`);
    const shape: Params = { ...(raw as Params) };
    if (typeof shape.id !== "string" || !shape.id.trim()) shape.id = uniqueId(ids, String(shape.type ?? "shape"));
    if (shape.type !== "circle" && shape.rotation === undefined) shape.rotation = 0;
    const problem = describeShapeProblem(shape);
    if (problem) throw new OperationError(`${where}: collision #${i + 1} ${problem}.`);
    if (ids.has(shape.id as string)) throw new OperationError(`${where}: duplicate collision id "${shape.id}".`);
    ids.add(shape.id as string);
    return shape as unknown as CollisionShape;
  });
}

function normalizeSprites(input: unknown, where: string): SpriteDefinition[] {
  if (!Array.isArray(input)) throw new OperationError(`${where}: "sprites" must be an array.`);
  const ids = new Set<string>();
  return input.map((raw, i) => {
    if (typeof raw !== "object" || raw === null) throw new OperationError(`${where}: sprite #${i + 1} must be an object.`);
    const r = raw as Params;
    if (typeof r.image !== "string" || !r.image.trim()) {
      throw new OperationError(
        `${where}: sprite #${i + 1} needs an "image" — an asset path inside the project like "assets/tree.png" (upload images first with POST /api/agent/assets).`,
      );
    }
    const name = typeof r.name === "string" && r.name.trim() ? r.name.trim() : `Sprite ${i + 1}`;
    const id = typeof r.id === "string" && r.id.trim() ? r.id.trim() : uniqueId(ids, name);
    if (ids.has(id)) throw new OperationError(`${where}: duplicate sprite id "${id}".`);
    ids.add(id);
    return { id, name, image: r.image.trim(), collisions: normalizeShapes(r.collisions, `${where}, sprite "${id}"`) };
  });
}

const P = {
  mapId: { type: "string", required: true, description: "Id of the map to edit." },
  layerId: { type: "string", required: true, description: "Id of a layer of that map." },
  objectId: { type: "string", required: true, description: "Id of an object in the project catalog." },
  x: { type: "integer", required: true, description: "Grid column (0-based). For multi-cell objects, any cell of the footprint works for lookups; placement uses it as the top-left." },
  y: { type: "integer", required: true, description: "Grid row (0-based)." },
  spriteId: { type: "string", description: "One of the object's sprite ids; omit to show the object's default sprite." },
  name: { type: "string", required: true, description: "Display name." },
} satisfies Record<string, ParamSpec>;

const P3 = {
  x: { type: "number", required: true, description: "World x in meters, 0 to the terrain width." },
  z: { type: "number", required: true, description: "World z in meters, 0 to the terrain depth." },
} satisfies Record<string, ParamSpec>;

const SPRITES_DESC =
  'Array of { id?, name?, image, collisions? }. `image` is an asset path inside the project ("assets/x.png"). Collision shapes are in the sprite image\'s pixels, centered on x/y: { type: "rect", x, y, width, height, rotation? } | { type: "circle", x, y, radius } | { type: "triangle", x, y, points: [{x,y},{x,y},{x,y}] (offsets from the center), rotation? }. Rotation is in degrees, clockwise.';
const OBJECT_COLLISIONS_DESC =
  "Collision shapes for a sprite-less object (spawn point, trigger, invisible wall), in footprint space: 32 px per tile, origin at the footprint's top-left. Same shape format as sprite collisions.";

export const OPERATIONS: Record<string, OperationSpec> = {
  placeObject: {
    description: "Places an object with its top-left at (x, y), replacing anything its footprint overlaps on that layer.",
    params: { mapId: P.mapId, objectId: P.objectId, layerId: P.layerId, x: P.x, y: P.y, spriteId: P.spriteId },
    run: (project, p) => {
      layerOf(map2dOf(project, p.mapId), p.layerId);
      object2dOf(project, p.objectId);
      return outcome(project, ops.placeObject(project, p.mapId as string, p as Parameters<typeof ops.placeObject>[2]));
    },
  },
  removeObject: {
    description: "Removes the instance covering cell (x, y) on a layer (any cell of a multi-cell object's footprint).",
    params: { mapId: P.mapId, layerId: P.layerId, x: P.x, y: P.y },
    run: (project, p) => {
      layerOf(map2dOf(project, p.mapId), p.layerId);
      return outcome(project, ops.removeObject(project, p.mapId as string, p as Parameters<typeof ops.removeObject>[2]), "Nothing there, or the layer is locked.");
    },
  },
  moveObject: {
    description: "Moves the instance covering (x, y) so its top-left lands on (toX, toY), replacing what it overlaps there.",
    params: {
      mapId: P.mapId,
      layerId: P.layerId,
      x: P.x,
      y: P.y,
      toX: { type: "integer", required: true, description: "Destination column of the top-left cell." },
      toY: { type: "integer", required: true, description: "Destination row of the top-left cell." },
    },
    run: (project, p) => {
      layerOf(map2dOf(project, p.mapId), p.layerId);
      return outcome(project, ops.moveObject(project, p.mapId as string, p as Parameters<typeof ops.moveObject>[2]));
    },
  },
  fillArea: {
    description: "Flood-fills the connected region around (x, y) (cells holding the same object, or empty) with a 1x1 object.",
    params: { mapId: P.mapId, objectId: P.objectId, layerId: P.layerId, x: P.x, y: P.y },
    run: (project, p) => {
      layerOf(map2dOf(project, p.mapId), p.layerId);
      object2dOf(project, p.objectId);
      return outcome(project, ops.fillArea(project, p.mapId as string, p as Parameters<typeof ops.fillArea>[2]), "Nothing changed: already filled, locked layer, or the object isn't 1x1.");
    },
  },
  fillRect: {
    description: "Paints a rectangle of cells with an object (roads, walls, lakes…), tiling multi-cell objects by their footprint.",
    params: {
      mapId: P.mapId,
      objectId: P.objectId,
      layerId: P.layerId,
      x: P.x,
      y: P.y,
      width: { type: "integer", required: true, description: "Rectangle width in cells." },
      height: { type: "integer", required: true, description: "Rectangle height in cells." },
      spriteId: P.spriteId,
    },
    run: (project, p) => {
      layerOf(map2dOf(project, p.mapId), p.layerId);
      object2dOf(project, p.objectId);
      return outcome(project, ops.fillRect(project, p.mapId as string, p as Parameters<typeof ops.fillRect>[2]));
    },
  },
  removeInstances: {
    description: "Removes several instances at once.",
    params: {
      mapId: P.mapId,
      targets: { type: "array", required: true, description: "Array of { layerId, x, y }, each identifying an instance by any cell it covers." },
    },
    run: (project, p) => {
      map2dOf(project, p.mapId);
      return outcome(project, ops.removeInstances(project, p.mapId as string, p.targets as Array<{ layerId: string; x: number; y: number }>), "Nothing found at those cells, or their layers are locked.");
    },
  },
  duplicateInstance: {
    description: "Copies the instance covering (x, y) into the nearest free spot next to it.",
    params: { mapId: P.mapId, layerId: P.layerId, x: P.x, y: P.y },
    run: (project, p) => {
      layerOf(map2dOf(project, p.mapId), p.layerId);
      return outcome(project, ops.duplicateInstance(project, p.mapId as string, p as Parameters<typeof ops.duplicateInstance>[2]), "Nothing there, or no free spot nearby.");
    },
  },
  setInstanceSprite: {
    description: "Chooses which of its object's sprites an instance shows (null = follow the object's default).",
    params: {
      mapId: P.mapId,
      layerId: P.layerId,
      x: P.x,
      y: P.y,
      spriteId: { type: "string|null", required: true, description: "A sprite id of the instance's object, or null." },
    },
    run: (project, p) => {
      layerOf(map2dOf(project, p.mapId), p.layerId);
      return outcome(project, ops.setInstanceSprite(project, p.mapId as string, p as Parameters<typeof ops.setInstanceSprite>[2]), "Nothing there, unknown sprite, or already showing it.");
    },
  },
  createLayer: {
    description: "Adds a layer on top of a map's existing layers.",
    params: { mapId: P.mapId, name: P.name, id: { type: "string", description: "Layer id; derived from the name if omitted." } },
    run: (project, p) => {
      const map = mapOf(project, p.mapId);
      const id = (p.id as string | undefined) ?? uniqueId(map.layers.map((l) => l.id), p.name as string);
      if (map.layers.some((l) => l.id === id)) throw new OperationError(`Layer id "${id}" already exists in map "${map.id}".`);
      const layer: MapLayer = { id, name: p.name as string, visible: true, locked: false };
      return created(outcome(project, ops.createLayer(project, map.id, layer)), id);
    },
  },
  removeLayer: {
    description: "Deletes a layer and every instance on it.",
    params: { mapId: P.mapId, layerId: P.layerId },
    run: (project, p) => {
      layerOf(mapOf(project, p.mapId), p.layerId);
      return outcome(project, ops.removeLayer(project, p.mapId as string, p.layerId as string));
    },
  },
  reorderLayer: {
    description: "Moves a layer to another index (0 = drawn first / bottom).",
    params: { mapId: P.mapId, layerId: P.layerId, toIndex: { type: "integer", required: true, description: "New index, clamped to the valid range." } },
    run: (project, p) => {
      layerOf(mapOf(project, p.mapId), p.layerId);
      return outcome(project, ops.reorderLayer(project, p.mapId as string, p.layerId as string, p.toIndex as number), "Already at that index.");
    },
  },
  setLayerFlag: {
    description: "Renames, shows/hides, or locks/unlocks a layer.",
    params: {
      mapId: P.mapId,
      layerId: P.layerId,
      name: { type: "string", description: "New layer name." },
      visible: { type: "boolean", description: "Whether the layer is drawn." },
      locked: { type: "boolean", description: "Locked layers reject every edit." },
    },
    run: (project, p) => {
      layerOf(mapOf(project, p.mapId), p.layerId);
      const patch: Partial<Pick<MapLayer, "name" | "visible" | "locked">> = {};
      if (p.name !== undefined) patch.name = p.name as string;
      if (p.visible !== undefined) patch.visible = p.visible as boolean;
      if (p.locked !== undefined) patch.locked = p.locked as boolean;
      if (Object.keys(patch).length === 0) throw new OperationError('setLayerFlag needs at least one of "name", "visible", "locked".');
      return outcome(project, ops.setLayerFlag(project, p.mapId as string, p.layerId as string, patch));
    },
  },
  createMap: {
    description:
      'Adds a map. kind "2d" (default): a tile grid with one empty "ground" layer. kind "3d": a flat terrain (heightmap + up to 4 painted texture layers) with one "objects" layer. The object catalog is shared by all maps.',
    params: {
      name: P.name,
      kind: { type: "string", description: '"2d" (default) or "3d".' },
      width: { type: "number", required: true, description: "2D: width in cells (integer). 3D: terrain width in meters (x axis)." },
      height: { type: "integer", description: "2D only (required): height in cells." },
      depth: { type: "number", description: "3D only: terrain depth in meters (z axis); defaults to width." },
      resolution: {
        type: "integer",
        description: "3D only: heightmap samples per side, 17-513 (default 129). More = finer sculpting, bigger file. A power of two plus one keeps samples on round coordinates.",
      },
      baseHeight: { type: "number", description: "3D only: starting height of the flat terrain in meters (default 0)." },
      waterLevel: { type: "number|null", description: "3D only: height of a water plane in meters, or null for none (default)." },
      terrainLayers: {
        type: "array",
        description: `3D only: 1-${MAX_TERRAIN_LAYERS} texture layers { id?, name, color: "#rrggbb", texture?, tileSize? } — the first covers the whole terrain. Default: grass, rock, sand, snow (plain colors).`,
      },
      tileWidth: { type: "integer", description: "2D only: cell width in pixels (default 32)." },
      tileHeight: { type: "integer", description: "2D only: cell height in pixels (default 32)." },
      id: { type: "string", description: "Map id; derived from the name if omitted." },
    },
    run: (project, p) => {
      const id = (p.id as string | undefined) ?? uniqueId(project.maps.map((m) => m.id), p.name as string);
      if (project.maps.some((m) => m.id === id)) throw new OperationError(`Map id "${id}" already exists.`);
      const kind = p.kind ?? "2d";
      if (kind === "3d") {
        for (const key of ["height", "tileWidth", "tileHeight"]) {
          if (p[key] !== undefined) throw new OperationError(`createMap: "${key}" is for 2D maps (3D maps use width/depth in meters).`);
        }
        const width = p.width as number;
        const depth = (p.depth as number | undefined) ?? width;
        const resolution = (p.resolution as number | undefined) ?? 129;
        if (!(width > 0) || !(depth > 0)) throw new OperationError("createMap: width and depth must be positive (meters).");
        if (resolution < 17 || resolution > 513) throw new OperationError("createMap: resolution must be between 17 and 513.");
        const terrainLayers = p.terrainLayers === undefined ? defaultTerrainLayers() : normalizeTerrainLayers(p.terrainLayers);
        const map = createDefaultMap3D(id, p.name as string, {
          width,
          depth,
          resolution,
          baseHeight: p.baseHeight as number | undefined,
          waterLevel: (p.waterLevel as number | null | undefined) ?? null,
          terrainLayers,
        });
        return created(outcome(project, ops.createMap(project, map)), id);
      }
      if (kind !== "2d") throw new OperationError('createMap: "kind" must be "2d" or "3d".');
      for (const key of ["depth", "resolution", "baseHeight", "waterLevel", "terrainLayers"]) {
        if (p[key] !== undefined) throw new OperationError(`createMap: "${key}" is for 3D maps — pass kind: "3d".`);
      }
      if (p.height === undefined) throw new OperationError('createMap: 2D maps need "height" (in cells).');
      const settings = {
        width: p.width as number,
        height: p.height as number,
        tileWidth: (p.tileWidth as number | undefined) ?? 32,
        tileHeight: (p.tileHeight as number | undefined) ?? 32,
      };
      if (!Number.isInteger(settings.width)) throw new OperationError("createMap: a 2D map's width is a whole number of cells.");
      if (Object.values(settings).some((v) => v <= 0)) throw new OperationError("Map sizes must be positive.");
      return created(outcome(project, ops.createMap(project, createDefaultMap(id, p.name as string, settings))), id);
    },
  },
  removeMap: {
    description: "Deletes a map (the last remaining map can't be deleted).",
    params: { mapId: P.mapId },
    run: (project, p) => {
      mapOf(project, p.mapId);
      return outcome(project, ops.removeMap(project, p.mapId as string), "It's the project's only map.");
    },
  },
  renameMap: {
    description: "Renames a map.",
    params: { mapId: P.mapId, name: P.name },
    run: (project, p) => {
      mapOf(project, p.mapId);
      return outcome(project, ops.renameMap(project, p.mapId as string, p.name as string), "Same name.");
    },
  },
  resizeMap: {
    description: "Resizes a 2D map; instances whose footprint no longer fits are removed.",
    params: {
      mapId: P.mapId,
      width: { type: "integer", required: true, description: "New width in cells." },
      height: { type: "integer", required: true, description: "New height in cells." },
    },
    run: (project, p) => {
      map2dOf(project, p.mapId);
      return outcome(project, ops.resizeMap(project, p.mapId as string, p.width as number, p.height as number), "Same size, or invalid size.");
    },
  },
  addObjectDefinition: {
    description:
      'Adds an object to the shared catalog. kind "2d" (default): drawn from sprites — tiles on 2D maps, upright billboards on 3D maps; without sprites it\'s invisible (spawn point, trigger, invisible wall…). kind "3d": a .glb model, 3D maps only; without a model it\'s an invisible 3D marker.',
    params: {
      name: P.name,
      kind: { type: "string", description: '"2d" (default) or "3d". Fixed once created.' },
      id: { type: "string", description: "Object id; derived from the name if omitted." },
      description: { type: "string", description: "Free-text notes (e.g. gameplay meaning)." },
      sizeInTiles: { type: "object", description: "{ width, height } footprint in cells; default 1x1. On 3D maps a 2D object's billboard is 1 m per tile." },
      sprites: { type: "array", description: `2D objects only. ${SPRITES_DESC}` },
      defaultSpriteId: { type: "string", description: "2D objects: sprite shown by default; defaults to the first sprite." },
      collisions: { type: "array", description: OBJECT_COLLISIONS_DESC },
      model: { type: "string", description: '3D objects only: a .glb model inside the project ("assets/tree.glb"), uploaded first with POST /api/agent/assets.' },
    },
    run: (project, p) => {
      const id = (p.id as string | undefined) ?? uniqueId(project.objects.map((o) => o.id), p.name as string);
      if (project.objects.some((o) => o.id === id)) throw new OperationError(`Object id "${id}" already exists.`);
      const where = `Object "${id}"`;
      const kind = p.kind ?? "2d";
      if (kind !== "2d" && kind !== "3d") throw new OperationError(`${where}: "kind" must be "2d" or "3d".`);
      if (kind === "3d" && (p.sprites !== undefined || p.defaultSpriteId !== undefined)) {
        throw new OperationError(`${where}: 3D objects use a "model" (.glb), not sprites.`);
      }
      if (kind === "2d" && p.model !== undefined) throw new OperationError(`${where}: "model" is for 3D objects — pass kind: "3d".`);
      const sprites = p.sprites === undefined ? [] : normalizeSprites(p.sprites, where);
      const defaultSpriteId = sprites.length ? ((p.defaultSpriteId as string | undefined) ?? sprites[0].id) : undefined;
      if (defaultSpriteId !== undefined && !sprites.some((s) => s.id === defaultSpriteId)) {
        throw new OperationError(`${where}: defaultSpriteId "${defaultSpriteId}" isn't one of its sprites.`);
      }
      if (!sprites.length && p.defaultSpriteId !== undefined) throw new OperationError(`${where}: defaultSpriteId given but no sprites.`);
      const sizeInTiles = sizeParam(p.sizeInTiles, where);
      const collisions = p.collisions === undefined ? undefined : normalizeShapes(p.collisions, where);
      const model = p.model === undefined ? undefined : assetPath(p.model, `${where}, model`, MODEL_EXT);
      const def: MapObjectDefinition = {
        id,
        name: p.name as string,
        kind,
        ...(typeof p.description === "string" && p.description.trim() ? { description: p.description.trim() } : {}),
        ...(sizeInTiles ? { sizeInTiles } : {}),
        sprites,
        ...(defaultSpriteId ? { defaultSpriteId } : {}),
        ...(collisions?.length ? { collisions } : {}),
        ...(model ? { model } : {}),
      };
      return created(outcome(project, ops.addObjectDefinition(project, def)), id);
    },
  },
  updateObjectDefinition: {
    description: "Changes a catalog object (its kind can't change). Given fields replace the old ones; instances using removed sprites fall back to the default.",
    params: {
      objectId: P.objectId,
      name: { type: "string", description: "New name." },
      description: { type: "string", description: 'New notes ("" clears them).' },
      sizeInTiles: { type: "object|null", description: "{ width, height }, or null for 1x1." },
      sprites: { type: "array", description: `2D objects: replaces all sprites (empty = sprite-less object). ${SPRITES_DESC}` },
      defaultSpriteId: { type: "string", description: "Which sprite is the default." },
      collisions: { type: "array", description: `Replaces the object-level collisions. ${OBJECT_COLLISIONS_DESC}` },
      model: { type: "string|null", description: "3D objects: a new .glb model, or null for an invisible marker." },
    },
    run: (project, p) => {
      const current = objectOf(project, p.objectId);
      const where = `Object "${current.id}"`;
      if (current.kind === "3d" && (p.sprites !== undefined || p.defaultSpriteId !== undefined)) {
        throw new OperationError(`${where} is a 3D object: it uses a "model", not sprites.`);
      }
      if (current.kind === "2d" && p.model !== undefined) throw new OperationError(`${where} is a 2D object: it can't have a model.`);
      const patch: ObjectDefinitionPatch = {};
      if (p.name !== undefined) patch.name = p.name as string;
      if (p.description !== undefined) patch.description = (p.description as string).trim() || undefined;
      if (p.sizeInTiles !== undefined) patch.sizeInTiles = sizeParam(p.sizeInTiles, where);
      if (p.collisions !== undefined) {
        const shapes = normalizeShapes(p.collisions, where);
        patch.collisions = shapes.length ? shapes : undefined;
      }
      if (p.model !== undefined) patch.model = p.model === null ? undefined : assetPath(p.model, `${where}, model`, MODEL_EXT);
      const sprites = p.sprites === undefined ? current.sprites : normalizeSprites(p.sprites, where);
      if (p.sprites !== undefined) patch.sprites = sprites;
      if (p.defaultSpriteId !== undefined) {
        if (!sprites.some((s) => s.id === p.defaultSpriteId)) throw new OperationError(`${where}: defaultSpriteId "${p.defaultSpriteId}" isn't one of its sprites.`);
        patch.defaultSpriteId = p.defaultSpriteId as string;
      } else if (p.sprites !== undefined) {
        patch.defaultSpriteId = sprites.some((s) => s.id === current.defaultSpriteId) ? current.defaultSpriteId : sprites[0]?.id;
      }
      return outcome(project, ops.updateObjectDefinition(project, current.id, patch), "Nothing changed.");
    },
  },
  duplicateObjectDefinition: {
    description: "Copies a catalog object (sprites and collisions included) under a new id.",
    params: {
      objectId: P.objectId,
      newId: { type: "string", description: "Id of the copy; derived if omitted." },
      newName: { type: "string", description: 'Name of the copy; defaults to "<name> copy".' },
    },
    run: (project, p) => {
      const source = objectOf(project, p.objectId);
      const newId = (p.newId as string | undefined) ?? uniqueId(project.objects.map((o) => o.id), `${source.id}-copy`);
      if (project.objects.some((o) => o.id === newId)) throw new OperationError(`Object id "${newId}" already exists.`);
      const newName = (p.newName as string | undefined) ?? `${source.name} copy`;
      return created(outcome(project, ops.duplicateObjectDefinition(project, source.id, newId, newName)), newId);
    },
  },
  removeObjectDefinition: {
    description: "Deletes a catalog object and every instance of it in every map.",
    params: { objectId: P.objectId },
    run: (project, p) => {
      objectOf(project, p.objectId);
      return outcome(project, ops.removeObjectDefinition(project, p.objectId as string));
    },
  },
  renameProject: {
    description: "Renames the project.",
    params: { name: P.name },
    run: (project, p) => outcome(project, ops.renameProject(project, p.name as string), "Same name."),
  },

  // ---- 3D maps: terrain ----

  sculptTerrain: {
    description:
      "Sculpts the terrain with a round brush at (x, z) — or along a stroke to (toX, toZ): raise (hills, ridges), lower (valleys, riverbeds), smooth (soften), flatten (level toward `height`).",
    params: {
      mapId: P.mapId,
      mode: { type: "string", required: true, description: '"raise", "lower", "smooth" or "flatten".' },
      x: P3.x,
      z: P3.z,
      toX: { type: "number", description: "Stroke end x (meters). Omit for a single dab." },
      toZ: { type: "number", description: "Stroke end z (meters)." },
      radius: { type: "number", required: true, description: "Brush radius in meters (smooth falloff to the edge)." },
      strength: { type: "number", required: true, description: "raise/lower: meters at the center. smooth/flatten: 0-1 blend." },
      height: { type: "number", description: "flatten: target height in meters (default: height at x, z)." },
    },
    run: (project, p) => {
      map3dOf(project, p.mapId);
      if (!["raise", "lower", "smooth", "flatten"].includes(p.mode as string)) {
        throw new OperationError('sculptTerrain: "mode" must be "raise", "lower", "smooth" or "flatten".');
      }
      if ((p.toX === undefined) !== (p.toZ === undefined)) throw new OperationError("sculptTerrain: give both toX and toZ, or neither.");
      if (!((p.radius as number) > 0)) throw new OperationError("sculptTerrain: radius must be positive.");
      return outcome(project, ops3d.sculptTerrain(project, p.mapId as string, p as unknown as ops3d.SculptParams), "The brush is entirely outside the terrain.");
    },
  },
  paintTerrain: {
    description: "Paints a terrain texture layer with a round brush at (x, z) — or along a stroke to (toX, toZ): paths, beaches, rocky patches.",
    params: {
      mapId: P.mapId,
      layerId: { type: "string", required: true, description: "Id of a terrain texture layer of that map (see terrain.layers)." },
      x: P3.x,
      z: P3.z,
      toX: { type: "number", description: "Stroke end x (meters)." },
      toZ: { type: "number", description: "Stroke end z (meters)." },
      radius: { type: "number", required: true, description: "Brush radius in meters." },
      strength: { type: "number", required: true, description: "0-1: how fully the layer covers at the brush center (1 = replace)." },
    },
    run: (project, p) => {
      terrainLayerOf(map3dOf(project, p.mapId), p.layerId);
      if ((p.toX === undefined) !== (p.toZ === undefined)) throw new OperationError("paintTerrain: give both toX and toZ, or neither.");
      return outcome(project, ops3d.paintTerrain(project, p.mapId as string, p as unknown as ops3d.PaintParams), "The brush is entirely outside the terrain.");
    },
  },
  generateTerrain: {
    description:
      "Generates natural relief with fractal noise (deterministic for a seed). Use island: true with a waterLevel for islands. Follow with autoPaintTerrain to texture it.",
    params: {
      mapId: P.mapId,
      seed: { type: "integer", description: "Random seed (default 1)." },
      amplitude: { type: "number", description: "Height range of the relief in meters (default 12)." },
      featureSize: { type: "number", description: "Typical size of hills in meters (default 40). Larger = broader shapes." },
      octaves: { type: "integer", description: "Detail levels 1-8 (default 5). Higher = more rugged." },
      baseHeight: { type: "number", description: "Height added everywhere (default 0)." },
      mode: { type: "string", description: '"replace" (default) or "add" on top of the current relief.' },
      island: { type: "boolean", description: "Sink the edges below 0 so the land forms an island (default false)." },
    },
    run: (project, p) => {
      map3dOf(project, p.mapId);
      if (p.mode !== undefined && p.mode !== "replace" && p.mode !== "add") throw new OperationError('generateTerrain: "mode" must be "replace" or "add".');
      const { mapId: _m, op: _o, ...params } = p;
      return outcome(project, ops3d.generateTerrain(project, p.mapId as string, params), "Invalid parameters (featureSize must be positive).");
    },
  },
  setTerrainHeightRect: {
    description: "Sets a world rectangle to one height — a flat plot for buildings, a plateau, a pit. Smooth the edges afterwards with sculptTerrain mode smooth.",
    params: {
      mapId: P.mapId,
      x: { type: "number", required: true, description: "Rectangle min x (meters)." },
      z: { type: "number", required: true, description: "Rectangle min z (meters)." },
      width: { type: "number", required: true, description: "Size along x (meters)." },
      depth: { type: "number", required: true, description: "Size along z (meters)." },
      height: { type: "number", required: true, description: "Target height (meters)." },
    },
    run: (project, p) => {
      map3dOf(project, p.mapId);
      return outcome(project, ops3d.setTerrainHeightRect(project, p.mapId as string, p as unknown as Parameters<typeof ops3d.setTerrainHeightRect>[2]), "The rectangle doesn't cover any terrain sample.");
    },
  },
  autoPaintTerrain: {
    description:
      "Textures the whole terrain from rules on height and slope; for each point the first matching rule wins, e.g. [{layerId:'sand',maxHeight:1},{layerId:'rock',minSlope:35},{layerId:'snow',minHeight:20},{layerId:'grass'}].",
    params: {
      mapId: P.mapId,
      rules: {
        type: "array",
        required: true,
        description: "Array of { layerId, minHeight?, maxHeight?, minSlope?, maxSlope? } (meters, degrees). Points matching no rule keep their paint.",
      },
      blend: { type: "boolean", description: "Soften the borders between layers (default true)." },
    },
    run: (project, p) => {
      const map = map3dOf(project, p.mapId);
      const rules = (p.rules as unknown[]).map((r, i) => {
        if (typeof r !== "object" || r === null) throw new OperationError(`autoPaintTerrain: rule #${i + 1} must be an object.`);
        const rule = r as Params;
        terrainLayerOf(map, rule.layerId);
        for (const key of Object.keys(rule)) {
          if (!["layerId", "minHeight", "maxHeight", "minSlope", "maxSlope"].includes(key)) throw new OperationError(`autoPaintTerrain: rule #${i + 1} has unknown field "${key}".`);
          if (key !== "layerId" && typeof rule[key] !== "number") throw new OperationError(`autoPaintTerrain: rule #${i + 1} "${key}" must be a number.`);
        }
        return rule as unknown as ops3d.AutoPaintRuleById;
      });
      return outcome(project, ops3d.autoPaintTerrain(project, map.id, { rules, blend: p.blend as boolean | undefined }), "No rules given.");
    },
  },
  setWaterLevel: {
    description: "Adds, moves or removes (null) the sea: a flat water plane covering every part of the terrain lower than `level`. For lakes at other heights (mountain lakes, ponds), use addWaterBody.",
    params: { mapId: P.mapId, level: { type: "number|null", required: true, description: "Water height in meters, or null for no water." } },
    run: (project, p) => {
      map3dOf(project, p.mapId);
      return outcome(project, ops3d.setWaterLevel(project, p.mapId as string, p.level as number | null), "Already at that level.");
    },
  },
  addTerrainLayer: {
    description: `Adds a texture layer to a terrain (at most ${MAX_TERRAIN_LAYERS}). Paint it with paintTerrain or autoPaintTerrain.`,
    params: {
      mapId: P.mapId,
      name: P.name,
      id: { type: "string", description: "Layer id; derived from the name if omitted." },
      color: { type: "string", required: true, description: 'Average color "#rrggbb" (used when there\'s no texture, and in previews).' },
      texture: { type: "string", description: 'A tiling image inside the project ("assets/grass.png").' },
      tileSize: { type: "number", description: "Meters covered by one repetition of the texture (default 4)." },
    },
    run: (project, p) => {
      const map = map3dOf(project, p.mapId);
      if (map.terrain.layers.length >= MAX_TERRAIN_LAYERS) throw new OperationError(`Map "${map.id}" already has ${MAX_TERRAIN_LAYERS} terrain layers.`);
      const [layer] = normalizeTerrainLayers([{ ...p, id: p.id ?? uniqueId(map.terrain.layers.map((l) => l.id), p.name as string) }]);
      if (map.terrain.layers.some((l) => l.id === layer.id)) throw new OperationError(`Terrain layer "${layer.id}" already exists.`);
      return created(outcome(project, ops3d.addTerrainLayer(project, map.id, layer)), layer.id);
    },
  },
  updateTerrainLayer: {
    description: "Changes a terrain texture layer's name, color, texture or tiling.",
    params: {
      mapId: P.mapId,
      layerId: { type: "string", required: true, description: "Terrain layer id." },
      name: { type: "string", description: "New name." },
      color: { type: "string", description: '"#rrggbb".' },
      texture: { type: "string|null", description: "A tiling image inside the project, or null to use the plain color." },
      tileSize: { type: "number", description: "Meters per texture repetition." },
    },
    run: (project, p) => {
      terrainLayerOf(map3dOf(project, p.mapId), p.layerId);
      const patch: Partial<TerrainLayer> = {};
      if (p.name !== undefined) patch.name = p.name as string;
      if (p.color !== undefined) {
        if (!isHexColor(p.color)) throw new OperationError('updateTerrainLayer: "color" must be "#rrggbb".');
        patch.color = p.color;
      }
      if (p.texture !== undefined) patch.texture = p.texture === null ? undefined : assetPath(p.texture, "updateTerrainLayer: texture", IMAGE_EXT);
      if (p.tileSize !== undefined) {
        if (!((p.tileSize as number) > 0)) throw new OperationError('updateTerrainLayer: "tileSize" must be positive.');
        patch.tileSize = p.tileSize as number;
      }
      return outcome(project, ops3d.updateTerrainLayer(project, p.mapId as string, p.layerId as string, patch), "Nothing changed.");
    },
  },
  removeTerrainLayer: {
    description: "Removes a terrain texture layer; where it was painted, the remaining layers take over. The last layer can't be removed.",
    params: { mapId: P.mapId, layerId: { type: "string", required: true, description: "Terrain layer id." } },
    run: (project, p) => {
      terrainLayerOf(map3dOf(project, p.mapId), p.layerId);
      return outcome(project, ops3d.removeTerrainLayer(project, p.mapId as string, p.layerId as string), "It's the terrain's only layer.");
    },
  },

  addDetailLayer: {
    description: `Adds a detail layer (like Unity's "Paint Details"): grass, flowers or small bushes painted as a density, not placed one by one — a whole meadow stays light. Without sprite/model it's procedural grass blades in \`color\`. At most ${MAX_DETAIL_LAYERS} per map. Then fill it with autoPaintDetails or paintDetails.`,
    params: {
      mapId: P.mapId,
      name: P.name,
      id: { type: "string", description: "Layer id; derived from the name if omitted." },
      color: { type: "string", description: 'Blade color / tint "#rrggbb" (default "#6b9a3c").' },
      sprite: { type: "string", description: 'A tuft image (transparent PNG, "assets/grass-tuft.png"), drawn as two crossed quads.' },
      model: { type: "string", description: 'Or a small .glb (flower, bush), scaled to `height`.' },
      width: { type: "number", description: "Tuft width in meters (default 0.5)." },
      height: { type: "number", description: "Tuft height in meters (default 0.45)." },
      sizeVariation: { type: "number", description: "0-1 random size variation (default 0.35)." },
      density: { type: "number", description: "Tufts per m² at 100% painted density (default 6; flowers 0.5-1, bushes 0.05-0.2)." },
    },
    run: (project, p) => {
      const map = map3dOf(project, p.mapId);
      if (map.terrain.detailLayers.length >= MAX_DETAIL_LAYERS) throw new OperationError(`Map "${map.id}" already has ${MAX_DETAIL_LAYERS} detail layers.`);
      const id = (p.id as string | undefined) ?? uniqueId(map.terrain.detailLayers.map((l) => l.id), p.name as string);
      if (map.terrain.detailLayers.some((l) => l.id === id)) throw new OperationError(`Detail layer "${id}" already exists.`);
      if (p.color !== undefined && !isHexColor(p.color)) throw new OperationError('addDetailLayer: "color" must be "#rrggbb".');
      if (p.sprite !== undefined && p.model !== undefined) throw new OperationError("addDetailLayer: give a sprite or a model, not both.");
      const layer: DetailLayer = {
        id,
        name: p.name as string,
        color: (p.color as string | undefined) ?? "#6b9a3c",
        width: (p.width as number | undefined) ?? 0.5,
        height: (p.height as number | undefined) ?? 0.45,
        sizeVariation: (p.sizeVariation as number | undefined) ?? 0.35,
        density: (p.density as number | undefined) ?? 6,
        ...(p.sprite !== undefined ? { sprite: assetPath(p.sprite, "addDetailLayer: sprite", IMAGE_EXT) } : {}),
        ...(p.model !== undefined ? { model: assetPath(p.model, "addDetailLayer: model", MODEL_EXT) } : {}),
      };
      if (!(layer.width > 0) || !(layer.height > 0) || !(layer.density >= 0) || !(layer.sizeVariation >= 0 && layer.sizeVariation <= 1)) {
        throw new OperationError("addDetailLayer: width/height must be positive, density ≥ 0, sizeVariation 0-1.");
      }
      return created(outcome(project, ops3d.addDetailLayer(project, map.id, layer)), id);
    },
  },
  updateDetailLayer: {
    description: "Changes a detail layer's look (color, sprite, model, size, variation) or its tufts per m².",
    params: {
      mapId: P.mapId,
      layerId: { type: "string", required: true, description: "Detail layer id." },
      name: { type: "string", description: "New name." },
      color: { type: "string", description: '"#rrggbb".' },
      sprite: { type: "string|null", description: "Tuft image, or null for procedural blades." },
      model: { type: "string|null", description: ".glb model, or null." },
      width: { type: "number", description: "Meters." },
      height: { type: "number", description: "Meters." },
      sizeVariation: { type: "number", description: "0-1." },
      density: { type: "number", description: "Tufts per m² at 100%." },
    },
    run: (project, p) => {
      const map = map3dOf(project, p.mapId);
      detailLayerOf(map, p.layerId);
      if (p.color !== undefined && !isHexColor(p.color)) throw new OperationError('updateDetailLayer: "color" must be "#rrggbb".');
      const { mapId: _m, op: _o, layerId, ...patch } = p;
      if (typeof patch.sprite === "string") patch.sprite = assetPath(patch.sprite, "updateDetailLayer: sprite", IMAGE_EXT);
      if (typeof patch.model === "string") patch.model = assetPath(patch.model, "updateDetailLayer: model", MODEL_EXT);
      return outcome(project, ops3d.updateDetailLayer(project, map.id, layerId as string, patch as ops3d.DetailLayerPatch), "Nothing changed, or an invalid value.");
    },
  },
  removeDetailLayer: {
    description: "Removes a detail layer and its painted density.",
    params: { mapId: P.mapId, layerId: { type: "string", required: true, description: "Detail layer id." } },
    run: (project, p) => {
      detailLayerOf(map3dOf(project, p.mapId), p.layerId);
      return outcome(project, ops3d.removeDetailLayer(project, p.mapId as string, p.layerId as string));
    },
  },
  paintDetails: {
    description: "Paints (or erases) grass/flower density with a round brush at (x, z), or along a stroke to (toX, toZ) — e.g. erase grass along a path.",
    params: {
      mapId: P.mapId,
      layerId: { type: "string", required: true, description: "Detail layer id." },
      x: P3.x,
      z: P3.z,
      toX: { type: "number", description: "Stroke end x." },
      toZ: { type: "number", description: "Stroke end z." },
      radius: { type: "number", required: true, description: "Brush radius (meters)." },
      strength: { type: "number", required: true, description: "0-1: 1 = full density (or none with erase) at the center." },
      erase: { type: "boolean", description: "Remove instead of add." },
    },
    run: (project, p) => {
      detailLayerOf(map3dOf(project, p.mapId), p.layerId);
      if ((p.toX === undefined) !== (p.toZ === undefined)) throw new OperationError("paintDetails: give both toX and toZ, or neither.");
      return outcome(project, ops3d.paintDetails(project, p.mapId as string, p as unknown as ops3d.PaintDetailsParams), "The brush is entirely outside the terrain.");
    },
  },
  autoPaintDetails: {
    description:
      "Fills a whole detail layer from rules: where a terrain texture dominates, between heights, below a slope, out of water, with natural clumps (patchiness). Replaces what was painted on that layer; density 0 clears it.",
    params: {
      mapId: P.mapId,
      layerId: { type: "string", required: true, description: "Detail layer id." },
      density: { type: "number", description: "0-1 painted density where the rules match (default 1)." },
      onTerrainLayerId: { type: "string", description: 'Only where this terrain texture layer dominates (e.g. "grass").' },
      minHeight: { type: "number", description: "Meters." },
      maxHeight: { type: "number", description: "Meters." },
      maxSlope: { type: "number", description: "Degrees." },
      patchiness: { type: "number", description: "0-1: clumps and clearings instead of a uniform carpet (0.4 looks natural)." },
      patchSize: { type: "number", description: "Clump size in meters (default 12)." },
      seed: { type: "integer", description: "Random seed for the clumps." },
      avoidWater: { type: "boolean", description: "No grass in the sea or lakes (default true)." },
    },
    run: (project, p) => {
      const map = map3dOf(project, p.mapId);
      detailLayerOf(map, p.layerId);
      if (p.onTerrainLayerId !== undefined) terrainLayerOf(map, p.onTerrainLayerId);
      const { mapId: _m, op: _o, ...params } = p;
      return outcome(project, ops3d.autoPaintDetails(project, map.id, params as unknown as ops3d.FillDetailsParams), "Nothing changed.");
    },
  },

  addWaterBody: {
    description:
      "Adds a lake/pond at its own height, anywhere (even high in the mountains): water poured at (x, z) fills the connected basin up to `level`. Dig the basin first (sculptTerrain lower) so the water has banks, then use fill: true to fill it exactly to the brim. A level above the lowest bank overflows as far as the terrain lets it (unless `area` limits it). Independent of the sea (setWaterLevel).",
    params: {
      mapId: P.mapId,
      x: { type: "number", required: true, description: "Seed x (meters): a low spot inside the basin." },
      z: { type: "number", required: true, description: "Seed z (meters)." },
      level: { type: "number", description: "Water surface height (meters). Default: 1.5 m above the ground at the seed." },
      depth: { type: "number", description: "Alternative to level: surface height above the ground at the seed (meters)." },
      fill: {
        type: "boolean",
        description: "Fill the hollow to the brim: the highest level before the water would overflow its lowest bank (recommended — no guessing, no leaks). Ignores level/depth.",
      },
      name: { type: "string", description: 'Display name (default "Lake").' },
      color: { type: "string", description: 'Tint "#rrggbb" (default water blue).' },
      area: { type: "object", description: "{ x, z, width, depth }: world rectangle the water can't spread beyond." },
      id: { type: "string", description: "Water id; derived from the name if omitted." },
    },
    run: (project, p) => {
      const map = map3dOf(project, p.mapId);
      if (p.color !== undefined && !isHexColor(p.color)) throw new OperationError('addWaterBody: "color" must be "#rrggbb".');
      if (p.area !== undefined) waterArea(p.area);
      if (typeof p.id === "string" && map.waters.some((w) => w.id === p.id)) throw new OperationError(`Water id "${p.id}" already exists.`);
      const { mapId: _m, op: _o, ...params } = p;
      const result = ops3d.addWaterBody(project, map.id, params as unknown as ops3d.WaterBodyParams);
      return result
        ? { project: result.project, applied: true, createdId: result.id }
        : {
            project,
            applied: false,
            detail: p.fill
              ? "No hollow to fill there (a slope or a peak): dig a basin first with sculptTerrain lower, or give a level."
              : "No water: the seed is outside the terrain, or the level isn't above the ground there.",
          };
    },
  },
  updateWaterBody: {
    description: "Changes a lake/pond: its level (raise it to flood more, lower it to shrink), seed point, name, color or limiting area.",
    params: {
      mapId: P.mapId,
      waterId: { type: "string", required: true, description: "Water body id." },
      level: { type: "number", description: "New surface height (meters)." },
      x: { type: "number", description: "New seed x." },
      z: { type: "number", description: "New seed z." },
      name: { type: "string", description: "New name." },
      color: { type: "string|null", description: '"#rrggbb", or null for the default blue.' },
      area: { type: "object|null", description: "{ x, z, width, depth } limit, or null for none." },
    },
    run: (project, p) => {
      const map = map3dOf(project, p.mapId);
      if (!map.waters.some((w) => w.id === p.waterId)) {
        throw new OperationError(`Unknown water "${p.waterId}" in map "${map.id}". Waters: ${map.waters.map((w) => w.id).join(", ") || "(none)"}.`);
      }
      if (p.color !== undefined && p.color !== null && !isHexColor(p.color)) throw new OperationError('updateWaterBody: "color" must be "#rrggbb".');
      if (p.area !== undefined && p.area !== null) waterArea(p.area);
      const { mapId: _m, op: _o, waterId, ...patch } = p;
      return outcome(project, ops3d.updateWaterBody(project, map.id, waterId as string, patch as ops3d.WaterBodyPatch), "Nothing changed, or the seed is outside the terrain.");
    },
  },
  removeWaterBody: {
    description: "Removes a lake/pond.",
    params: { mapId: P.mapId, waterId: { type: "string", required: true, description: "Water body id." } },
    run: (project, p) => {
      map3dOf(project, p.mapId);
      return outcome(project, ops3d.removeWaterBody(project, p.mapId as string, p.waterId as string), "No such water.");
    },
  },

  // ---- 3D maps: objects ----

  placeObject3D: {
    description:
      "Places an object on a 3D terrain at (x, z) in meters; it stands on the ground (+ elevation). 3D objects show their model, 2D objects an upright billboard of their sprite.",
    params: {
      mapId: P.mapId,
      objectId: P.objectId,
      layerId: P.layerId,
      x: P3.x,
      z: P3.z,
      elevation: { type: "number", description: "Meters above the ground (default 0)." },
      rotation: { type: "number", description: "Yaw in degrees, counter-clockwise seen from above (default 0)." },
      scale: { type: "number", description: "Uniform scale (default 1)." },
      spriteId: { type: "string", description: "2D objects: which sprite the billboard shows (default sprite if omitted)." },
      id: { type: "string", description: "Placement id; derived from the object id if omitted." },
    },
    run: (project, p) => {
      const map = map3dOf(project, p.mapId);
      layerOf(map, p.layerId);
      objectOf(project, p.objectId);
      if (typeof p.id === "string" && map.placements.some((q) => q.id === p.id)) throw new OperationError(`Placement id "${p.id}" already exists.`);
      const result = ops3d.placeObject3D(project, map.id, p as unknown as ops3d.PlaceObject3DParams);
      return result
        ? { project: result.project, applied: true, createdId: result.id }
        : { project, applied: false, detail: "Not placed: outside the terrain, locked layer, unknown sprite, or invalid scale." };
    },
  },
  updatePlacement3D: {
    description: "Moves, rotates, scales or re-layers a placed object (only the given fields change).",
    params: {
      mapId: P.mapId,
      placementId: { type: "string", required: true, description: "Placement id." },
      x: { type: "number", description: "New x (meters)." },
      z: { type: "number", description: "New z (meters)." },
      elevation: { type: "number", description: "Meters above the ground." },
      rotation: { type: "number", description: "Yaw in degrees." },
      scale: { type: "number", description: "Uniform scale." },
      layerId: { type: "string", description: "Move to another layer." },
      spriteId: { type: "string|null", description: "2D objects: sprite to show, or null for the default." },
    },
    run: (project, p) => {
      const map = map3dOf(project, p.mapId);
      placementOf(map, p.placementId);
      if (p.layerId !== undefined) layerOf(map, p.layerId);
      const { mapId: _m, op: _o, placementId, ...patch } = p;
      return outcome(project, ops3d.updatePlacement3D(project, map.id, placementId as string, patch as ops3d.PlacementPatch), "Nothing changed, outside the terrain, locked layer, or invalid value.");
    },
  },
  removePlacements3D: {
    description: "Removes placed objects by id.",
    params: { mapId: P.mapId, placementIds: { type: "array", required: true, description: "Array of placement ids." } },
    run: (project, p) => {
      map3dOf(project, p.mapId);
      return outcome(project, ops3d.removePlacements3D(project, p.mapId as string, (p.placementIds as unknown[]).map(String)), "None of those placements exist, or their layers are locked.");
    },
  },
  duplicatePlacements3D: {
    description: "Copies placed objects, offset by (dx, dz) meters (default 2 m along x).",
    params: {
      mapId: P.mapId,
      placementIds: { type: "array", required: true, description: "Array of placement ids." },
      dx: { type: "number", description: "Offset along x (meters, default 2)." },
      dz: { type: "number", description: "Offset along z (meters, default 0)." },
    },
    run: (project, p) => {
      map3dOf(project, p.mapId);
      const result = ops3d.duplicatePlacements3D(project, p.mapId as string, {
        ids: (p.placementIds as unknown[]).map(String),
        dx: p.dx as number | undefined,
        dz: p.dz as number | undefined,
      });
      return result
        ? { project: result.project, applied: true, createdIds: result.ids }
        : { project, applied: false, detail: "None of those placements exist, or their layers are locked." };
    },
  },
  scatterObjects3D: {
    description:
      "Places many copies of an object at random spots that pass the filters (height, slope, dominant terrain layer, spacing, water) — forests, rocks, bushes. Deterministic for a given seed.",
    params: {
      mapId: P.mapId,
      objectId: P.objectId,
      layerId: P.layerId,
      count: { type: "integer", required: true, description: "How many to place (fewer if the filters leave too little room)." },
      seed: { type: "integer", description: "Random seed (default 1)." },
      area: { type: "object", description: "{ x, z, width, depth } world rectangle (default: the whole terrain)." },
      circle: { type: "object", description: "{ x, z, radius } circular area around a point, in meters." },
      minHeight: { type: "number", description: "Skip terrain lower than this (meters)." },
      maxHeight: { type: "number", description: "Skip terrain higher than this (meters)." },
      maxSlope: { type: "number", description: "Skip slopes steeper than this (degrees)." },
      onTerrainLayerId: { type: "string", description: "Only where this terrain layer dominates (e.g. trees on grass)." },
      water: { type: "string", description: '"avoid" (default): dry land only. "only": under water only (sea and lakes) — fish, seaweed, shells. "any": both.' },
      floatInWater: { type: "boolean", description: 'With water "only": random heights between the bottom and the surface (fish) instead of on the bottom.' },
      avoidWater: { type: "boolean", description: 'Deprecated: false = water "any".' },
      minDistance: { type: "number", description: "Minimum spacing in meters from each other and from existing placements." },
      avoidOtherObjects: { type: "boolean", description: "False: spacing only considers existing copies of this object (default true)." },
      scaleMin: { type: "number", description: "Random scale range min (default 1)." },
      scaleMax: { type: "number", description: "Random scale range max (default scaleMin)." },
      randomRotation: { type: "boolean", description: "Random yaw (default true)." },
      spriteId: { type: "string", description: "2D objects: sprite shown by the billboards." },
    },
    run: (project, p) => {
      const map = map3dOf(project, p.mapId);
      layerOf(map, p.layerId);
      objectOf(project, p.objectId);
      if (p.onTerrainLayerId !== undefined) terrainLayerOf(map, p.onTerrainLayerId);
      if (p.water !== undefined && !["avoid", "only", "any"].includes(p.water as string)) {
        throw new OperationError('scatterObjects3D: "water" must be "avoid", "only" or "any".');
      }
      if ((p.count as number) < 1 || (p.count as number) > 5000) throw new OperationError("scatterObjects3D: count must be between 1 and 5000.");
      if (p.area !== undefined) {
        const a = p.area as Params;
        if (!["x", "z", "width", "depth"].every((k) => typeof a[k] === "number") || !((a.width as number) > 0) || !((a.depth as number) > 0)) {
          throw new OperationError('scatterObjects3D: "area" needs numbers x, z and positive width, depth.');
        }
      }
      if (p.circle !== undefined) {
        const c = p.circle as Params;
        if (![c.x, c.z, c.radius].every((v) => typeof v === "number" && Number.isFinite(v)) || !((c.radius as number) > 0)) {
          throw new OperationError('scatterObjects3D: "circle" needs finite x, z and a positive radius.');
        }
      }
      const { mapId: _m, op: _o, ...params } = p;
      const result = ops3d.scatterObjects3D(project, map.id, params as unknown as ops3d.ScatterParams);
      return result
        ? { project: result.project, applied: true, createdIds: result.ids, ...(result.ids.length < (p.count as number) ? { detail: `Only ${result.ids.length} spots passed the filters.` } : {}) }
        : { project, applied: false, detail: "No spot passed the filters (or the layer is locked / the sprite unknown)." };
    },
  },
};

function detailLayerOf(map: Map3D, layerId: unknown): DetailLayer {
  const layer = map.terrain.detailLayers.find((l) => l.id === layerId);
  if (!layer) {
    throw new OperationError(
      `Unknown detail layer "${layerId}" in map "${map.id}". Detail layers: ${map.terrain.detailLayers.map((l) => l.id).join(", ") || "(none — addDetailLayer first)"}.`,
    );
  }
  return layer;
}

function waterArea(value: unknown): void {
  const a = value as Params;
  if (!["x", "z", "width", "depth"].every((k) => typeof a[k] === "number") || !((a.width as number) > 0) || !((a.depth as number) > 0)) {
    throw new OperationError('"area" needs numbers x, z and positive width, depth.');
  }
}

function normalizeTerrainLayers(input: unknown): TerrainLayer[] {
  if (!Array.isArray(input) || input.length === 0 || input.length > MAX_TERRAIN_LAYERS) {
    throw new OperationError(`"terrainLayers" must be an array of 1 to ${MAX_TERRAIN_LAYERS} layers.`);
  }
  const ids = new Set<string>();
  return input.map((raw, i) => {
    if (typeof raw !== "object" || raw === null) throw new OperationError(`Terrain layer #${i + 1} must be an object.`);
    const r = raw as Params;
    const name = typeof r.name === "string" && r.name.trim() ? r.name.trim() : `Layer ${i + 1}`;
    const id = typeof r.id === "string" && r.id.trim() ? r.id.trim() : uniqueId(ids, name);
    if (ids.has(id)) throw new OperationError(`Duplicate terrain layer id "${id}".`);
    ids.add(id);
    if (!isHexColor(r.color)) throw new OperationError(`Terrain layer "${id}": "color" must be "#rrggbb".`);
    const tileSize = r.tileSize === undefined ? 4 : Number(r.tileSize);
    if (!(tileSize > 0)) throw new OperationError(`Terrain layer "${id}": "tileSize" must be positive.`);
    const texture = r.texture === undefined || r.texture === null ? undefined : assetPath(r.texture, `Terrain layer "${id}": texture`, IMAGE_EXT);
    return { id, name, color: r.color, tileSize, ...(texture ? { texture } : {}) };
  });
}

function matchesType(value: unknown, type: ParamType): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
    case "array":
      return Array.isArray(value);
    case "string|null":
      return value === null || typeof value === "string";
    case "number|null":
      return value === null || (typeof value === "number" && Number.isFinite(value));
    case "object|null":
      return value === null || (typeof value === "object" && !Array.isArray(value));
  }
}

/** Validates one JSON operation against OPERATIONS and runs it. Throws OperationError on bad input. */
export function applyOperation(project: KreaProject, input: unknown): OperationOutcome {
  if (typeof input !== "object" || input === null || typeof (input as Params).op !== "string") {
    throw new OperationError('Each operation must be an object with an "op" field.');
  }
  const p = input as Params;
  const opName = p.op as string;
  const spec = Object.prototype.hasOwnProperty.call(OPERATIONS, opName) ? OPERATIONS[opName] : undefined;
  if (!spec) throw new OperationError(`Unknown op "${opName}". Available: ${Object.keys(OPERATIONS).join(", ")}.`);

  for (const key of Object.keys(p)) {
    if (key !== "op" && !(key in spec.params)) {
      throw new OperationError(`${opName}: unknown parameter "${key}". Expected: ${Object.keys(spec.params).join(", ")}.`);
    }
  }
  for (const [name, param] of Object.entries(spec.params)) {
    const value = p[name];
    if (value === undefined) {
      if (param.required) throw new OperationError(`${opName}: missing required parameter "${name}" (${param.type}).`);
      continue;
    }
    if (!matchesType(value, param.type)) throw new OperationError(`${opName}: "${name}" must be ${param.type}.`);
    if (param.required && param.type === "string" && !(value as string).trim()) {
      throw new OperationError(`${opName}: "${name}" can't be empty.`);
    }
  }
  return spec.run(project, p);
}

/** Machine-readable catalog of the operations (name, description, parameters). */
export function describeOperations(): Array<{ op: string; description: string; params: Record<string, ParamSpec> }> {
  return Object.entries(OPERATIONS).map(([op, spec]) => ({ op, description: spec.description, params: spec.params }));
}
