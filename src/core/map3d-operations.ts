import type { EditorCommand, PlacementChange, TerrainPatch } from "./history";
import { applyPlacementChanges } from "./history";
import { detailDab, fillDetails, removeDetailChannel } from "./details";
import {
  MAX_DETAIL_LAYERS,
  MAX_TERRAIN_LAYERS,
  type DetailLayer,
  type KreaProject,
  type Map3D,
  type Placement3D,
  type TerrainData,
  type TerrainLayer,
  type WaterBody,
} from "./map-types";
import { buildWaterIndex, findBasin, waterMask, waterSampleCount } from "./water";
import { get3DMap, isObjectAllowedOnMap, replaceMap, uniqueId } from "./map-utils";
import type { OpResult } from "./map-operations";
import {
  SPLAT_CHANNELS,
  autoPaint,
  extractRegion,
  generateHeights,
  heightAt,
  isInsideTerrain,
  paintDab,
  removeSplatChannel,
  sculptDab,
  seededRandom,
  setHeightRect,
  slopeAt,
  splatWeightsAt,
  unionRegion,
  type AutoPaintRule,
  type GenerateParams,
  type SculptMode,
  type TerrainRegion,
} from "./terrain";

/**
 * Pure operations for 3D maps — same contract as map-operations.ts: take a
 * project, return the new project plus an undoable command, or null when the
 * edit is a no-op or not allowed (unknown map, 2D map, locked layer…).
 */

// ---- Terrain ----

function terrainResult(project: KreaProject, map: Map3D, terrain: TerrainData, patch: TerrainPatch, label: string): OpResult {
  return {
    project: replaceMap(project, { ...map, terrain }),
    command: { kind: "terrain", label, mapId: map.id, patch },
  };
}

/**
 * Runs an in-place edit on copies of the terrain arrays, then records the
 * touched region's before/after samples as one undo step.
 */
function editTerrain(
  project: KreaProject,
  mapId: string,
  label: string,
  touches: { heights?: boolean; splat?: boolean; details?: boolean },
  edit: (terrain: TerrainData) => TerrainRegion | null,
): OpResult | null {
  const map = get3DMap(project, mapId);
  if (!map) return null;
  const before = map.terrain;
  const working: TerrainData = {
    ...before,
    heights: touches.heights ? before.heights.slice() : before.heights,
    splat: touches.splat ? before.splat.slice() : before.splat,
    details: touches.details ? before.details.slice() : before.details,
  };
  const region = edit(working);
  if (!region) return null;
  const res = before.resolution;
  const patch: TerrainPatch = { region };
  if (touches.heights) {
    patch.heightsBefore = extractRegion(before.heights, res, 1, region);
    patch.heightsAfter = extractRegion(working.heights, res, 1, region);
  }
  if (touches.splat) {
    patch.splatBefore = extractRegion(before.splat, res, SPLAT_CHANNELS, region);
    patch.splatAfter = extractRegion(working.splat, res, SPLAT_CHANNELS, region);
  }
  if (touches.details) {
    patch.detailsBefore = extractRegion(before.details, res, SPLAT_CHANNELS, region);
    patch.detailsAfter = extractRegion(working.details, res, SPLAT_CHANNELS, region);
  }
  return terrainResult(project, map, working, patch, label);
}

/**
 * Commits a terrain edit already computed elsewhere (the editor's live brush
 * strokes). `patch` holds the region's before/after samples.
 */
export function commitTerrainPatch(project: KreaProject, mapId: string, patch: TerrainPatch, label = "Edit terrain"): OpResult | null {
  const map = get3DMap(project, mapId);
  if (!map) return null;
  const { region } = patch;
  const res = map.terrain.resolution;
  if (region.x0 < 0 || region.z0 < 0 || region.w <= 0 || region.h <= 0 || region.x0 + region.w > res || region.z0 + region.h > res) return null;
  const terrain = { ...map.terrain };
  if (patch.heightsAfter) {
    terrain.heights = terrain.heights.slice();
    for (let row = 0; row < region.h; row++) {
      terrain.heights.set(patch.heightsAfter.subarray(row * region.w, (row + 1) * region.w), (region.z0 + row) * res + region.x0);
    }
  }
  if (patch.splatAfter) {
    terrain.splat = terrain.splat.slice();
    const w = region.w * SPLAT_CHANNELS;
    for (let row = 0; row < region.h; row++) {
      terrain.splat.set(patch.splatAfter.subarray(row * w, (row + 1) * w), ((region.z0 + row) * res + region.x0) * SPLAT_CHANNELS);
    }
  }
  if (patch.detailsAfter) {
    terrain.details = terrain.details.slice();
    const w = region.w * SPLAT_CHANNELS;
    for (let row = 0; row < region.h; row++) {
      terrain.details.set(patch.detailsAfter.subarray(row * w, (row + 1) * w), ((region.z0 + row) * res + region.x0) * SPLAT_CHANNELS);
    }
  }
  return terrainResult(project, map, terrain, patch, label);
}

/** Points along a stroke from (x, z) to (toX, toZ), spaced a quarter radius apart. */
function strokePoints(p: { x: number; z: number; toX?: number; toZ?: number; radius: number }): Array<{ x: number; z: number }> {
  if (p.toX === undefined || p.toZ === undefined) return [{ x: p.x, z: p.z }];
  const length = Math.hypot(p.toX - p.x, p.toZ - p.z);
  const steps = Math.max(1, Math.ceil(length / Math.max(p.radius / 4, 0.05)));
  return Array.from({ length: steps + 1 }, (_, i) => ({ x: p.x + ((p.toX! - p.x) * i) / steps, z: p.z + ((p.toZ! - p.z) * i) / steps }));
}

export interface SculptParams {
  mode: SculptMode;
  x: number;
  z: number;
  /** Optional end point: sculpts a stroke from (x, z) to (toX, toZ) — ridges, valleys, riverbeds, ramps. */
  toX?: number;
  toZ?: number;
  radius: number;
  /** raise/lower: meters at the brush center per dab. smooth/flatten: 0-1. */
  strength: number;
  /** flatten: target height (default: height at the start point). */
  height?: number;
}

export function sculptTerrain(project: KreaProject, mapId: string, p: SculptParams): OpResult | null {
  return editTerrain(project, mapId, "Sculpt terrain", { heights: true }, (t) => {
    const height = p.mode === "flatten" ? p.height ?? heightAt(t, p.x, p.z) : undefined;
    // A stroke raises/lowers its center line by about `strength` meters overall, not
    // once per dab: dabs spaced `step` apart overlap about radius/step times.
    const points = strokePoints(p);
    const step = points.length > 1 ? Math.hypot(p.toX! - p.x, p.toZ! - p.z) / (points.length - 1) : 0;
    const perDab = (p.mode === "raise" || p.mode === "lower") && step > 0 ? (p.strength * step) / p.radius : p.strength;
    let region: TerrainRegion | null = null;
    for (const pt of points) {
      region = unionRegion(region, sculptDab(t, t.heights, { ...pt, radius: p.radius, strength: perDab, mode: p.mode, height }));
    }
    return region;
  });
}

export interface PaintParams {
  layerId: string;
  x: number;
  z: number;
  toX?: number;
  toZ?: number;
  radius: number;
  /** 0-1: how much the layer covers at the brush center. */
  strength: number;
}

export function paintTerrain(project: KreaProject, mapId: string, p: PaintParams): OpResult | null {
  const map = get3DMap(project, mapId);
  const layerIndex = map?.terrain.layers.findIndex((l) => l.id === p.layerId) ?? -1;
  if (layerIndex < 0) return null;
  return editTerrain(project, mapId, "Paint terrain", { splat: true }, (t) => {
    let region: TerrainRegion | null = null;
    for (const pt of strokePoints(p)) region = unionRegion(region, paintDab(t, t.splat, { ...pt, radius: p.radius, strength: p.strength, layerIndex }));
    return region;
  });
}

export const DEFAULT_GENERATE: GenerateParams = {
  seed: 1,
  amplitude: 12,
  featureSize: 40,
  octaves: 5,
  baseHeight: 0,
  mode: "replace",
  island: false,
};

export function generateTerrain(project: KreaProject, mapId: string, params: Partial<GenerateParams>): OpResult | null {
  const p = { ...DEFAULT_GENERATE, ...params };
  if (!(p.featureSize > 0) || !Number.isFinite(p.amplitude)) return null;
  return editTerrain(project, mapId, "Generate terrain", { heights: true }, (t) => generateHeights(t, t.heights, p));
}

/** Sets a world rectangle to one height — a building plot, a plateau, a pit. */
export function setTerrainHeightRect(
  project: KreaProject,
  mapId: string,
  p: { x: number; z: number; width: number; depth: number; height: number },
): OpResult | null {
  if (!(p.width > 0) || !(p.depth > 0) || !Number.isFinite(p.height)) return null;
  return editTerrain(project, mapId, "Set terrain height", { heights: true }, (t) => setHeightRect(t, t.heights, p));
}

export interface AutoPaintRuleById extends Omit<AutoPaintRule, "layerIndex"> {
  layerId: string;
}

/** Paints the whole terrain from height/slope rules (first matching rule wins), e.g. sand below 1 m, rock above 35°. */
export function autoPaintTerrain(project: KreaProject, mapId: string, p: { rules: AutoPaintRuleById[]; blend?: boolean }): OpResult | null {
  const map = get3DMap(project, mapId);
  if (!map || p.rules.length === 0) return null;
  const rules: AutoPaintRule[] = [];
  for (const r of p.rules) {
    const layerIndex = map.terrain.layers.findIndex((l) => l.id === r.layerId);
    if (layerIndex < 0) return null;
    const { layerId: _id, ...rest } = r;
    rules.push({ ...rest, layerIndex });
  }
  return editTerrain(project, mapId, "Auto-paint terrain", { splat: true }, (t) => autoPaint(t, t.heights, t.splat, rules, p.blend ?? true));
}

function terrainInfoResult(
  project: KreaProject,
  map: Map3D,
  changes: Partial<{ layers: TerrainLayer[]; waterLevel: number | null; detailLayers: DetailLayer[] }>,
  label: string,
  arrays: { splatAfter?: Uint8Array; detailsAfter?: Uint8Array } = {},
): OpResult {
  const t = map.terrain;
  const before = { layers: t.layers, waterLevel: t.waterLevel, detailLayers: t.detailLayers };
  const after = { ...before, ...changes };
  const command: EditorCommand = {
    kind: "terrainInfo",
    label,
    mapId: map.id,
    change: {
      before,
      after,
      ...(arrays.splatAfter ? { splatBefore: t.splat, splatAfter: arrays.splatAfter } : {}),
      ...(arrays.detailsAfter ? { detailsBefore: t.details, detailsAfter: arrays.detailsAfter } : {}),
    },
  };
  const terrain = {
    ...t,
    ...after,
    ...(arrays.splatAfter ? { splat: arrays.splatAfter } : {}),
    ...(arrays.detailsAfter ? { details: arrays.detailsAfter } : {}),
  };
  return { project: replaceMap(project, { ...map, terrain }), command };
}

/** A flat water plane at `level` meters, or none with null. */
export function setWaterLevel(project: KreaProject, mapId: string, level: number | null): OpResult | null {
  const map = get3DMap(project, mapId);
  if (!map || (level !== null && !Number.isFinite(level)) || level === map.terrain.waterLevel) return null;
  return terrainInfoResult(project, map, { waterLevel: level }, level === null ? "Remove water" : "Set water level");
}

export function addTerrainLayer(project: KreaProject, mapId: string, layer: TerrainLayer): OpResult | null {
  const map = get3DMap(project, mapId);
  if (!map || map.terrain.layers.length >= MAX_TERRAIN_LAYERS || map.terrain.layers.some((l) => l.id === layer.id)) return null;
  return terrainInfoResult(project, map, { layers: [...map.terrain.layers, layer] }, "Add terrain layer");
}

export function updateTerrainLayer(
  project: KreaProject,
  mapId: string,
  layerId: string,
  patch: Partial<Pick<TerrainLayer, "name" | "color" | "texture" | "tileSize">>,
): OpResult | null {
  const map = get3DMap(project, mapId);
  if (!map || !map.terrain.layers.some((l) => l.id === layerId)) return null;
  const layers = map.terrain.layers.map((l) => {
    if (l.id !== layerId) return l;
    const next = { ...l, ...patch };
    if ("texture" in patch && !patch.texture) delete next.texture;
    return next;
  });
  return terrainInfoResult(project, map, { layers }, "Update terrain layer");
}

/** Removes a terrain layer; its painted weight goes to the remaining layers. The last layer can't be removed. */
export function removeTerrainLayer(project: KreaProject, mapId: string, layerId: string): OpResult | null {
  const map = get3DMap(project, mapId);
  const index = map?.terrain.layers.findIndex((l) => l.id === layerId) ?? -1;
  if (!map || index < 0 || map.terrain.layers.length <= 1) return null;
  const layers = map.terrain.layers.filter((l) => l.id !== layerId);
  return terrainInfoResult(project, map, { layers }, "Remove terrain layer", { splatAfter: removeSplatChannel(map.terrain.splat, index) });
}

// ---- Detail layers (grass, flowers…) ----

export function addDetailLayer(project: KreaProject, mapId: string, layer: DetailLayer): OpResult | null {
  const map = get3DMap(project, mapId);
  const layers = map?.terrain.detailLayers;
  if (!map || !layers || layers.length >= MAX_DETAIL_LAYERS || layers.some((l) => l.id === layer.id)) return null;
  return terrainInfoResult(project, map, { detailLayers: [...layers, layer] }, "Add detail layer");
}

export type DetailLayerPatch = Partial<Omit<DetailLayer, "id" | "sprite" | "model">> & { sprite?: string | null; model?: string | null };

export function updateDetailLayer(project: KreaProject, mapId: string, layerId: string, patch: DetailLayerPatch): OpResult | null {
  const map = get3DMap(project, mapId);
  const current = map?.terrain.detailLayers.find((l) => l.id === layerId);
  if (!map || !current) return null;
  const { sprite, model, ...rest } = patch;
  const next: DetailLayer = { ...current, ...rest };
  if (sprite === null) delete next.sprite;
  else if (sprite !== undefined) next.sprite = sprite;
  if (model === null) delete next.model;
  else if (model !== undefined) next.model = model;
  if (!(next.width > 0) || !(next.height > 0) || !(next.density >= 0) || !(next.sizeVariation >= 0 && next.sizeVariation <= 1)) return null;
  if (JSON.stringify(next) === JSON.stringify(current)) return null;
  return terrainInfoResult(project, map, { detailLayers: map.terrain.detailLayers.map((l) => (l.id === layerId ? next : l)) }, "Update detail layer");
}

export function removeDetailLayer(project: KreaProject, mapId: string, layerId: string): OpResult | null {
  const map = get3DMap(project, mapId);
  const index = map?.terrain.detailLayers.findIndex((l) => l.id === layerId) ?? -1;
  if (!map || index < 0) return null;
  return terrainInfoResult(
    project,
    map,
    { detailLayers: map.terrain.detailLayers.filter((l) => l.id !== layerId) },
    "Remove detail layer",
    { detailsAfter: removeDetailChannel(map.terrain.details, index) },
  );
}

export interface PaintDetailsParams {
  layerId: string;
  x: number;
  z: number;
  toX?: number;
  toZ?: number;
  radius: number;
  /** 0-1 per dab: how fast the density goes to 100% (or 0% with erase). */
  strength: number;
  erase?: boolean;
}

/** Paints (or erases) grass/flower density with a round brush, or along a stroke. */
export function paintDetails(project: KreaProject, mapId: string, p: PaintDetailsParams): OpResult | null {
  const map = get3DMap(project, mapId);
  const layerIndex = map?.terrain.detailLayers.findIndex((l) => l.id === p.layerId) ?? -1;
  if (layerIndex < 0) return null;
  return editTerrain(project, mapId, p.erase ? "Erase details" : "Paint details", { details: true }, (t) => {
    let region: TerrainRegion | null = null;
    for (const pt of strokePoints(p)) {
      region = unionRegion(region, detailDab(t, t.details, { ...pt, radius: p.radius, strength: p.strength, layerIndex, erase: p.erase }));
    }
    return region;
  });
}

export interface FillDetailsParams {
  layerId: string;
  /** 0-1 density where the filters match (0 clears the layer). Default 1. */
  density?: number;
  onTerrainLayerId?: string;
  minHeight?: number;
  maxHeight?: number;
  maxSlope?: number;
  /** 0-1: clumps and clearings instead of a uniform carpet. */
  patchiness?: number;
  patchSize?: number;
  seed?: number;
  /** Keep water free of grass (default true). */
  avoidWater?: boolean;
}

/** Fills a whole detail layer from rules — e.g. grass wherever the grass texture dominates, not on slopes nor in water. */
export function autoPaintDetails(project: KreaProject, mapId: string, p: FillDetailsParams): OpResult | null {
  const map = get3DMap(project, mapId);
  const layerIndex = map?.terrain.detailLayers.findIndex((l) => l.id === p.layerId) ?? -1;
  if (!map || layerIndex < 0) return null;
  const onIndex = p.onTerrainLayerId === undefined ? undefined : map.terrain.layers.findIndex((l) => l.id === p.onTerrainLayerId);
  if (onIndex === -1) return null;
  const water = p.avoidWater === false ? null : buildWaterIndex(map);
  return editTerrain(project, mapId, "Auto-paint details", { details: true }, (t) =>
    fillDetails(t, t.details, layerIndex, {
      density: p.density ?? 1,
      onTerrainLayerIndex: onIndex,
      minHeight: p.minHeight,
      maxHeight: p.maxHeight,
      maxSlope: p.maxSlope,
      patchiness: p.patchiness,
      patchSize: p.patchSize,
      seed: p.seed,
      isWet: water ? (x, z) => water.surfaceAt(x, z) !== null : undefined,
    }),
  );
}

// ---- Placements ----

function placementsResult(project: KreaProject, map: Map3D, changes: PlacementChange[], label: string): OpResult {
  return {
    project: replaceMap(project, { ...map, placements: applyPlacementChanges(map.placements, changes, true) }),
    command: { kind: "placements", label, mapId: map.id, changes },
  };
}

function editable3DLayer(map: Map3D, layerId: string): boolean {
  const layer = map.layers.find((l) => l.id === layerId);
  return !!layer && !layer.locked;
}

export interface PlaceObject3DParams {
  objectId: string;
  layerId: string;
  x: number;
  z: number;
  elevation?: number;
  rotation?: number;
  scale?: number;
  spriteId?: string;
  /** Optional id for the new placement (default: derived from the object id). */
  id?: string;
}

function makePlacement(project: KreaProject, map: Map3D, p: PlaceObject3DParams, takenIds: Set<string>): Placement3D | null {
  const def = project.objects.find((o) => o.id === p.objectId);
  if (!def || !isObjectAllowedOnMap(def, "3d")) return null;
  if (!editable3DLayer(map, p.layerId) || !isInsideTerrain(map.terrain, p.x, p.z)) return null;
  if (p.spriteId && !def.sprites.some((s) => s.id === p.spriteId)) return null;
  const scale = p.scale ?? 1;
  if (!(scale > 0)) return null;
  if (p.id !== undefined && (!p.id.trim() || takenIds.has(p.id))) return null;
  const id = p.id ?? uniqueId(takenIds, p.objectId);
  takenIds.add(id);
  return {
    id,
    objectId: p.objectId,
    layerId: p.layerId,
    x: p.x,
    z: p.z,
    elevation: p.elevation ?? 0,
    rotation: p.rotation ?? 0,
    scale,
    ...(p.spriteId ? { spriteId: p.spriteId } : {}),
  };
}

/** Places an object on the terrain at (x, z); it stands on the ground (+ elevation). */
export function placeObject3D(project: KreaProject, mapId: string, p: PlaceObject3DParams): (OpResult & { id: string }) | null {
  const map = get3DMap(project, mapId);
  if (!map) return null;
  const placement = makePlacement(project, map, p, new Set(map.placements.map((q) => q.id)));
  if (!placement) return null;
  return { ...placementsResult(project, map, [{ id: placement.id, before: null, after: placement }], "Place object"), id: placement.id };
}

export interface PlacementPatch {
  x?: number;
  z?: number;
  elevation?: number;
  rotation?: number;
  scale?: number;
  layerId?: string;
  /** null = back to the object's default sprite. */
  spriteId?: string | null;
}

export function updatePlacement3D(project: KreaProject, mapId: string, placementId: string, patch: PlacementPatch): OpResult | null {
  return updatePlacements3D(project, mapId, [{ id: placementId, ...patch }]);
}

/** Moves/rotates/scales several placements as one undo step (e.g. a transform gizmo drag on a selection). */
export function updatePlacements3D(project: KreaProject, mapId: string, updates: Array<PlacementPatch & { id: string }>): OpResult | null {
  const map = get3DMap(project, mapId);
  if (!map) return null;
  const changes: PlacementChange[] = [];
  for (const { id, ...patch } of updates) {
    const current = map.placements.find((p) => p.id === id);
    if (!current || !editable3DLayer(map, current.layerId)) return null;
    const { spriteId, ...rest } = patch;
    const next: Placement3D = { ...current, ...rest };
    if (spriteId === null) delete next.spriteId;
    else if (spriteId !== undefined) next.spriteId = spriteId;
    const def = project.objects.find((o) => o.id === next.objectId);
    if (!def || !isInsideTerrain(map.terrain, next.x, next.z) || !(next.scale > 0) || !editable3DLayer(map, next.layerId)) return null;
    if (next.spriteId !== undefined && !def.sprites.some((s) => s.id === next.spriteId)) return null;
    if (![next.elevation, next.rotation].every(Number.isFinite)) return null;
    if (JSON.stringify(next) !== JSON.stringify(current)) changes.push({ id, before: current, after: next });
  }
  if (changes.length === 0) return null;
  return placementsResult(project, map, changes, changes.length > 1 ? "Transform objects" : "Transform object");
}

export function removePlacements3D(project: KreaProject, mapId: string, placementIds: string[]): OpResult | null {
  const map = get3DMap(project, mapId);
  if (!map) return null;
  const wanted = new Set(placementIds);
  const changes = map.placements
    .filter((p) => wanted.has(p.id) && editable3DLayer(map, p.layerId))
    .map((p): PlacementChange => ({ id: p.id, before: p, after: null }));
  if (changes.length === 0) return null;
  return placementsResult(project, map, changes, changes.length > 1 ? "Delete objects" : "Delete object");
}

/** Copies placements, offset by (dx, dz) meters (default 2 m along x); new copies are clamped to the terrain. */
export function duplicatePlacements3D(
  project: KreaProject,
  mapId: string,
  p: { ids: string[]; dx?: number; dz?: number },
): (OpResult & { ids: string[] }) | null {
  const map = get3DMap(project, mapId);
  if (!map) return null;
  const taken = new Set(map.placements.map((q) => q.id));
  const changes: PlacementChange[] = [];
  for (const id of p.ids) {
    const source = map.placements.find((q) => q.id === id);
    if (!source || !editable3DLayer(map, source.layerId)) continue;
    const copyId = uniqueId(taken, source.objectId);
    taken.add(copyId);
    const copy: Placement3D = {
      ...source,
      id: copyId,
      x: Math.min(Math.max(source.x + (p.dx ?? 2), 0), map.terrain.size.width),
      z: Math.min(Math.max(source.z + (p.dz ?? 0), 0), map.terrain.size.depth),
    };
    changes.push({ id: copyId, before: null, after: copy });
  }
  if (changes.length === 0) return null;
  return { ...placementsResult(project, map, changes, "Duplicate objects"), ids: changes.map((c) => c.id) };
}

export function findPlacementsByObjectId(project: KreaProject, mapId: string, objectId: string): string[] {
  return get3DMap(project, mapId)?.placements.filter((p) => p.objectId === objectId).map((p) => p.id) ?? [];
}

export interface ScatterParams {
  objectId: string;
  layerId: string;
  count: number;
  seed?: number;
  /** World rectangle to scatter in (default: the whole terrain). */
  area?: { x: number; z: number; width: number; depth: number };
  /** Optional circular area, useful for scattering around a click in the editor. */
  circle?: { x: number; z: number; radius: number };
  minHeight?: number;
  maxHeight?: number;
  /** Degrees: skip slopes steeper than this. */
  maxSlope?: number;
  /** Only where this terrain layer dominates (weight ≥ 50%) — e.g. trees on grass only. */
  onTerrainLayerId?: string;
  /**
   * "avoid" (default): dry land only. "only": under water only (sea or lakes) —
   * fish, seaweed, wrecks. "any": both. `avoidWater: false` is the same as "any".
   */
  water?: "avoid" | "only" | "any";
  /** @deprecated use `water`. */
  avoidWater?: boolean;
  /**
   * With water "only": spread objects through the water column at random
   * heights between the bottom and the surface (fish), instead of on the bottom.
   */
  floatInWater?: boolean;
  /** Minimum distance in meters between scattered objects (and existing placements of any object on the map). */
  minDistance?: number;
  /** When false, spacing only checks existing placements of the selected object type. */
  avoidOtherObjects?: boolean;
  scaleMin?: number;
  scaleMax?: number;
  /** Random yaw (default true). */
  randomRotation?: boolean;
  spriteId?: string;
}

/** Places up to `count` copies at random spots that pass the filters — forests, rocks, grass tufts. Deterministic for a given seed. */
export function scatterObjects3D(project: KreaProject, mapId: string, p: ScatterParams): (OpResult & { ids: string[] }) | null {
  const map = get3DMap(project, mapId);
  if (!map || !Number.isInteger(p.count) || p.count < 1 || p.count > 5000) return null;
  const t = map.terrain;
  const circle = p.circle;
  if (circle && (![circle.x, circle.z, circle.radius].every(Number.isFinite) || circle.radius <= 0)) return null;
  const area = p.area ?? { x: 0, z: 0, width: t.size.width, depth: t.size.depth };
  const layerIndex = p.onTerrainLayerId === undefined ? -1 : t.layers.findIndex((l) => l.id === p.onTerrainLayerId);
  if (p.onTerrainLayerId !== undefined && layerIndex < 0) return null;
  const rand = seededRandom(p.seed ?? 1);
  const taken = new Set(map.placements.map((q) => q.id));
  const minDist = p.minDistance ?? 0;
  if (!Number.isFinite(minDist) || minDist < 0) return null;
  const occupied = map.placements
    .filter((q) => p.avoidOtherObjects !== false || q.objectId === p.objectId)
    .map((q) => ({ x: q.x, z: q.z }));
  const scaleMin = p.scaleMin ?? 1;
  const scaleMax = Math.max(scaleMin, p.scaleMax ?? scaleMin);
  const waterMode = p.water ?? (p.avoidWater === false ? "any" : "avoid");
  const water = waterMode === "any" && !p.floatInWater ? null : buildWaterIndex(map);

  const changes: PlacementChange[] = [];
  const maxAttempts = Math.min(200_000, p.count * 40);
  for (let attempt = 0; attempt < maxAttempts && changes.length < p.count; attempt++) {
    const angle = circle ? rand() * Math.PI * 2 : 0;
    const distance = circle ? Math.sqrt(rand()) * circle.radius : 0;
    const x = circle ? circle.x + Math.cos(angle) * distance : area.x + rand() * area.width;
    const z = circle ? circle.z + Math.sin(angle) * distance : area.z + rand() * area.depth;
    const rotation = p.randomRotation === false ? 0 : Math.round(rand() * 360);
    const scale = Math.round((scaleMin + rand() * (scaleMax - scaleMin)) * 100) / 100;
    if (!isInsideTerrain(t, x, z)) continue;
    const h = heightAt(t, x, z);
    if (p.minHeight !== undefined && h < p.minHeight) continue;
    if (p.maxHeight !== undefined && h > p.maxHeight) continue;
    const surface = water ? water.surfaceAt(x, z) : null;
    if (waterMode === "avoid" && surface) continue;
    if (waterMode === "only" && !surface) continue;
    if (p.maxSlope !== undefined && slopeAt(t, x, z) > p.maxSlope) continue;
    if (layerIndex >= 0 && splatWeightsAt(t, x, z)[layerIndex] < 0.5) continue;
    if (minDist > 0 && occupied.some((o) => Math.hypot(o.x - x, o.z - z) < minDist)) continue;
    // Fish: somewhere in the water column, keeping a margin from the bottom and the surface.
    const column = surface ? surface.level - h : 0;
    const elevation = p.floatInWater && surface && column > 0.6 ? round2(0.3 + rand() * (column - 0.6)) : 0;
    const placement = makePlacement(
      project,
      map,
      { objectId: p.objectId, layerId: p.layerId, x: round2(x), z: round2(z), rotation, scale, spriteId: p.spriteId, elevation },
      taken,
    );
    if (!placement) return null; // unknown object, locked layer…: every attempt would fail the same way
    occupied.push({ x, z });
    changes.push({ id: placement.id, before: null, after: placement });
  }
  if (changes.length === 0) return null;
  return { ...placementsResult(project, map, changes, "Scatter objects"), ids: changes.map((c) => c.id) };
}

// ---- Water bodies (lakes, ponds at their own height) ----

function watersResult(project: KreaProject, map: Map3D, after: WaterBody[], label: string): OpResult {
  return {
    project: replaceMap(project, { ...map, waters: after }),
    command: { kind: "waters", label, mapId: map.id, before: map.waters, after },
  };
}

export interface WaterBodyParams {
  /** Seed point (meters): a spot in the basin to fill. */
  x: number;
  z: number;
  /** Surface height (meters). Default: 1.5 m above the ground at the seed. */
  level?: number;
  /** Surface depth above the seed instead of an absolute level (ignored when `level` is given). */
  depth?: number;
  /** Fill the hollow to the brim: the level just below where the water would overflow (ignores level/depth). */
  fill?: boolean;
  name?: string;
  color?: string;
  area?: { x: number; z: number; width: number; depth: number };
  id?: string;
}

/**
 * Adds a lake/pond: water poured at (x, z) fills the connected basin up to its
 * level, at any altitude (mountain lakes above the sea, ponds, pools).
 */
export function addWaterBody(project: KreaProject, mapId: string, p: WaterBodyParams): (OpResult & { id: string }) | null {
  const map = get3DMap(project, mapId);
  if (!map || !isInsideTerrain(map.terrain, p.x, p.z)) return null;
  // Filling: the water runs down to the bottom of the hollow, which becomes the seed.
  const basin = p.fill ? findBasin(map.terrain, p.x, p.z, p.area) : null;
  const seed = basin ? { x: basin.x, z: basin.z } : { x: p.x, z: p.z };
  const ground = heightAt(map.terrain, seed.x, seed.z);
  const level = basin ? basin.level - 0.05 : (p.level ?? ground + (p.depth ?? 1.5));
  if (!Number.isFinite(level) || level <= ground) return null;
  const waters = map.waters ?? [];
  if (p.id !== undefined && (!p.id.trim() || waters.some((w) => w.id === p.id))) return null;
  const name = p.name?.trim() || "Lake";
  const id = p.id ?? uniqueId(waters.map((w) => w.id), name);
  const body: WaterBody = {
    id,
    name,
    x: round2(seed.x),
    z: round2(seed.z),
    level: round2(level),
    ...(p.color ? { color: p.color } : {}),
    ...(p.area ? { area: p.area } : {}),
  };
  if (waterSampleCount(waterMask(map.terrain, body)) === 0) return null;
  return { ...watersResult(project, map, [...waters, body], "Add water"), id };
}

export type WaterBodyPatch = Partial<Omit<WaterBody, "id" | "area" | "color">> & { color?: string | null; area?: WaterBody["area"] | null };

export function updateWaterBody(project: KreaProject, mapId: string, waterId: string, patch: WaterBodyPatch): OpResult | null {
  const map = get3DMap(project, mapId);
  const current = map?.waters.find((w) => w.id === waterId);
  if (!map || !current) return null;
  const { color, area, ...rest } = patch;
  const next: WaterBody = { ...current, ...rest };
  if (color === null) delete next.color;
  else if (color !== undefined) next.color = color;
  if (area === null) delete next.area;
  else if (area !== undefined) next.area = area;
  if (!isInsideTerrain(map.terrain, next.x, next.z) || !Number.isFinite(next.level)) return null;
  if (JSON.stringify(next) === JSON.stringify(current)) return null;
  return watersResult(project, map, map.waters.map((w) => (w.id === waterId ? next : w)), "Update water");
}

export function removeWaterBody(project: KreaProject, mapId: string, waterId: string): OpResult | null {
  const map = get3DMap(project, mapId);
  if (!map || !map.waters.some((w) => w.id === waterId)) return null;
  return watersResult(project, map, map.waters.filter((w) => w.id !== waterId), "Remove water");
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
