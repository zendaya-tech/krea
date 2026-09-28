import { applyCellsToMapping, applyPlacementChanges, type CellChange, type EditorCommand, type PlacementChange } from "./history";
import type {
  KreaProject,
  Map2D,
  MapDocument,
  MapLayer,
  MapObjectDefinition,
  MapObjectInstance,
  MapSettings,
  Placement3D,
} from "./map-types";
import {
  buildCellIndex,
  cellKey,
  footprintCells,
  get2DMap,
  getMap,
  getObjectSize,
  isFootprintInBounds,
  isInBounds,
  replaceMap,
} from "./map-utils";

/**
 * Pure, reusable project-editing operations. Each takes a project and returns
 * a new project plus the EditorCommand that produced it (for undo/redo), or
 * null when the edit is a no-op or not allowed (locked layer, out of bounds…).
 *
 * These are the ONLY functions that mutate project data. The editor UI calls
 * them; an AI agent or CLI calls the exact same functions, so neither needs to
 * know about React, Canvas, or the editor store. Map-level operations take a
 * `mapId`, so any map can be edited regardless of which one the UI shows.
 *
 * Instances can span multiple cells (MapObjectDefinition.sizeInTiles). A
 * map's `mapping` still holds exactly one entry per instance, keyed by its
 * origin (top-left) cell — buildCellIndex() derives the full occupied area
 * wherever a "what's at this cell" lookup is needed.
 *
 * The cell operations below work on 2D maps only (they return null for a 3D
 * map); 3D terrain and placement operations live in map3d-operations.ts.
 * Layers, maps and the object catalog are shared by both kinds.
 */
export interface OpResult {
  project: KreaProject;
  command: EditorCommand;
}

function sizeOf(project: KreaProject, objectId: string) {
  return getObjectSize(project.objects.find((o) => o.id === objectId));
}

function editableLayer(map: MapDocument, layerId: string): MapLayer | null {
  const layer = map.layers.find((l) => l.id === layerId);
  return layer && !layer.locked ? layer : null;
}

function cellsResult(project: KreaProject, map: Map2D, changes: CellChange[], label: string): OpResult {
  const mapping = applyCellsToMapping(map.mapping, changes, true);
  return {
    project: replaceMap(project, { ...map, mapping }),
    command: { kind: "cells", label, mapId: map.id, changes },
  };
}

/** An instance with its sprite choice set; `undefined` means "follow the object's default sprite". */
function withSprite(inst: MapObjectInstance, spriteId: string | undefined): MapObjectInstance {
  const { objectId, layerId, x, y } = inst;
  return spriteId ? { objectId, layerId, x, y, spriteId } : { objectId, layerId, x, y };
}

/**
 * Places an object with its origin at (x, y). Its full footprint must fit on
 * the map; any existing instance whose footprint intersects the new one is
 * replaced (the pencil "paints over"), even if that instance's own origin
 * lies outside the new footprint.
 */
export function placeObject(
  project: KreaProject,
  mapId: string,
  params: { objectId: string; layerId: string; x: number; y: number; spriteId?: string },
): OpResult | null {
  const { objectId, layerId, x, y } = params;
  const map = get2DMap(project, mapId);
  if (!map || !editableLayer(map, layerId)) return null;
  const def = project.objects.find((o) => o.id === objectId);
  if (!def || def.kind === "3d") return null;
  if (params.spriteId && !def.sprites.some((s) => s.id === params.spriteId)) return null;

  const size = getObjectSize(def);
  if (!isFootprintInBounds(x, y, size, map.settings)) return null;

  const after = withSprite({ objectId, layerId, x, y }, params.spriteId);
  const index = buildCellIndex(map.mapping, project.objects);
  const overlapping = new Set<MapObjectInstance>();
  for (const cell of footprintCells(x, y, size)) {
    const hit = index.get(cellKey(layerId, cell.x, cell.y));
    if (hit) overlapping.add(hit);
  }

  if (overlapping.size === 1) {
    const only = [...overlapping][0];
    if (only.objectId === objectId && only.x === x && only.y === y && only.spriteId === after.spriteId) return null;
  }

  const changes: CellChange[] = [...overlapping].map((inst) => ({ layerId, x: inst.x, y: inst.y, before: inst, after: null }));
  const originIdx = changes.findIndex((c) => c.x === x && c.y === y);
  if (originIdx >= 0) changes[originIdx] = { ...changes[originIdx], after };
  else changes.push({ layerId, x, y, before: null, after });

  return cellsResult(project, map, changes, "Place object");
}

/** Removes whichever instance's footprint covers (x, y) — not necessarily one whose origin is exactly there. */
export function removeObject(
  project: KreaProject,
  mapId: string,
  params: { layerId: string; x: number; y: number },
): OpResult | null {
  const map = get2DMap(project, mapId);
  if (!map || !editableLayer(map, params.layerId)) return null;
  const before = buildCellIndex(map.mapping, project.objects).get(cellKey(params.layerId, params.x, params.y));
  if (!before) return null;
  return cellsResult(project, map, [{ layerId: params.layerId, x: before.x, y: before.y, before, after: null }], "Erase object");
}

/** Moves whichever instance covers (x, y) to a new origin, displacing anything already occupying the destination. */
export function moveObject(
  project: KreaProject,
  mapId: string,
  params: { layerId: string; x: number; y: number; toX: number; toY: number },
): OpResult | null {
  const { layerId, toX, toY } = params;
  const map = get2DMap(project, mapId);
  if (!map || !editableLayer(map, layerId)) return null;

  const index = buildCellIndex(map.mapping, project.objects);
  const source = index.get(cellKey(layerId, params.x, params.y));
  if (!source) return null;
  if (source.x === toX && source.y === toY) return null;

  const size = sizeOf(project, source.objectId);
  if (!isFootprintInBounds(toX, toY, size, map.settings)) return null;

  const displaced = new Set<MapObjectInstance>();
  for (const cell of footprintCells(toX, toY, size)) {
    const hit = index.get(cellKey(layerId, cell.x, cell.y));
    if (hit && hit !== source) displaced.add(hit);
  }

  const changes: CellChange[] = [{ layerId, x: source.x, y: source.y, before: source, after: null }];
  for (const inst of displaced) changes.push({ layerId, x: inst.x, y: inst.y, before: inst, after: null });
  const moved: MapObjectInstance = { ...source, x: toX, y: toY };
  const destIdx = changes.findIndex((c) => c.x === toX && c.y === toY);
  if (destIdx >= 0) changes[destIdx] = { ...changes[destIdx], after: moved };
  else changes.push({ layerId, x: toX, y: toY, before: null, after: moved });

  return cellsResult(project, map, changes, "Move object");
}

/** Changes which of its object's sprites an instance shows; `spriteId: null` means "follow the object's default". */
export function setInstanceSprite(
  project: KreaProject,
  mapId: string,
  params: { layerId: string; x: number; y: number; spriteId: string | null },
): OpResult | null {
  const map = get2DMap(project, mapId);
  if (!map || !editableLayer(map, params.layerId)) return null;
  const inst = buildCellIndex(map.mapping, project.objects).get(cellKey(params.layerId, params.x, params.y));
  if (!inst) return null;
  const def = project.objects.find((o) => o.id === inst.objectId);
  if (!def) return null;
  if (params.spriteId !== null && !def.sprites.some((s) => s.id === params.spriteId)) return null;
  const after = withSprite(inst, params.spriteId ?? undefined);
  if (after.spriteId === inst.spriteId) return null;
  return cellsResult(project, map, [{ layerId: inst.layerId, x: inst.x, y: inst.y, before: inst, after }], "Change sprite");
}

/** Bulk-removes instances, each identified by any cell it occupies (not necessarily its origin). */
export function removeInstances(
  project: KreaProject,
  mapId: string,
  targets: Array<{ layerId: string; x: number; y: number }>,
): OpResult | null {
  const map = get2DMap(project, mapId);
  if (!map) return null;
  const index = buildCellIndex(map.mapping, project.objects);
  const toRemove = new Set<MapObjectInstance>();
  for (const t of targets) {
    if (!editableLayer(map, t.layerId)) continue;
    const hit = index.get(cellKey(t.layerId, t.x, t.y));
    if (hit) toRemove.add(hit);
  }
  if (toRemove.size === 0) return null;
  const changes: CellChange[] = [...toRemove].map((inst) => ({
    layerId: inst.layerId,
    x: inst.x,
    y: inst.y,
    before: inst,
    after: null,
  }));
  return cellsResult(project, map, changes, "Delete objects");
}

/** Every instance on a map matching objectId, across all its layers. */
export function findInstancesByObjectId(
  project: KreaProject,
  mapId: string,
  objectId: string,
): Array<{ layerId: string; x: number; y: number }> {
  const map = get2DMap(project, mapId);
  if (!map) return [];
  return map.mapping.filter((m) => m.objectId === objectId).map((m) => ({ layerId: m.layerId, x: m.x, y: m.y }));
}

const DUPLICATE_OFFSETS: Array<[number, number]> = [
  [1, 0],
  [0, 1],
  [-1, 0],
  [0, -1],
  [1, 1],
  [-1, 1],
  [1, -1],
  [-1, -1],
  [2, 0],
  [0, 2],
  [-2, 0],
  [0, -2],
];

/** Places a copy of an instance (same sprite) in the nearest fully-free spot on the same layer. */
export function duplicateInstance(
  project: KreaProject,
  mapId: string,
  params: { layerId: string; x: number; y: number },
): OpResult | null {
  const map = get2DMap(project, mapId);
  if (!map || !editableLayer(map, params.layerId)) return null;

  const index = buildCellIndex(map.mapping, project.objects);
  const source = index.get(cellKey(params.layerId, params.x, params.y));
  if (!source) return null;
  const size = sizeOf(project, source.objectId);

  for (const [dx, dy] of DUPLICATE_OFFSETS) {
    const nx = source.x + dx;
    const ny = source.y + dy;
    if (!isFootprintInBounds(nx, ny, size, map.settings)) continue;
    if (footprintCells(nx, ny, size).some((c) => index.has(cellKey(params.layerId, c.x, c.y)))) continue;
    const after: MapObjectInstance = { ...source, x: nx, y: ny };
    return cellsResult(project, map, [{ layerId: params.layerId, x: nx, y: ny, before: null, after }], "Duplicate object");
  }
  return null;
}

const FILL_CELL_LIMIT = 250_000;

/** Iterative BFS flood fill — never recurses, so it can't blow the stack.
 * Restricted to 1x1 objects: flood-filling multi-cell objects cell-by-cell
 * would place overlapping instances, which doesn't make sense for e.g. a house. */
export function fillArea(
  project: KreaProject,
  mapId: string,
  params: { objectId: string; layerId: string; x: number; y: number },
): OpResult | null {
  const { objectId, layerId, x, y } = params;
  const map = get2DMap(project, mapId);
  if (!map || !editableLayer(map, layerId)) return null;
  if (!isInBounds(x, y, map.settings)) return null;
  const def = project.objects.find((o) => o.id === objectId);
  if (!def || def.kind === "3d") return null;
  const size = getObjectSize(def);
  if (size.width !== 1 || size.height !== 1) return null;

  const index = buildCellIndex(map.mapping, project.objects);
  const targetObjectId = index.get(cellKey(layerId, x, y))?.objectId ?? null;
  if (targetObjectId === objectId) return null;

  const { width, height } = map.settings;
  const visited = new Set<string>();
  const queue: Array<[number, number]> = [[x, y]];
  const changes: CellChange[] = [];

  while (queue.length > 0 && changes.length < FILL_CELL_LIMIT) {
    const [cx, cy] = queue.shift()!;
    const key = cellKey(layerId, cx, cy);
    if (visited.has(key)) continue;
    visited.add(key);
    if (!isInBounds(cx, cy, map.settings)) continue;

    const current = index.get(key) ?? null;
    if ((current?.objectId ?? null) !== targetObjectId) continue;

    changes.push({ layerId, x: cx, y: cy, before: current, after: { objectId, layerId, x: cx, y: cy } });

    if (cx + 1 < width) queue.push([cx + 1, cy]);
    if (cx - 1 >= 0) queue.push([cx - 1, cy]);
    if (cy + 1 < height) queue.push([cx, cy + 1]);
    if (cy - 1 >= 0) queue.push([cx, cy - 1]);
  }

  if (changes.length === 0) return null;
  return cellsResult(project, map, changes, "Fill area");
}

/**
 * Paints a rectangle of cells with an object (a road, a lake, a wall…),
 * stepping by the object's footprint so multi-cell objects tile the area.
 * One undo step; placements that don't fit are skipped.
 */
export function fillRect(
  project: KreaProject,
  mapId: string,
  params: { objectId: string; layerId: string; x: number; y: number; width: number; height: number; spriteId?: string },
): OpResult | null {
  const map = get2DMap(project, mapId);
  if (!map || !editableLayer(map, params.layerId)) return null;
  if (params.width <= 0 || params.height <= 0) return null;
  const size = sizeOf(project, params.objectId);

  let working = project;
  const merged = new Map<string, CellChange>();
  for (let y = params.y; y < params.y + params.height; y += size.height) {
    for (let x = params.x; x < params.x + params.width; x += size.width) {
      const step = placeObject(working, mapId, { objectId: params.objectId, layerId: params.layerId, x, y, spriteId: params.spriteId });
      if (!step || step.command.kind !== "cells") continue;
      working = step.project;
      // Keep each cell's first "before" and last "after", so the whole rect is one clean undo step.
      for (const change of step.command.changes) {
        const key = cellKey(change.layerId, change.x, change.y);
        const prev = merged.get(key);
        merged.set(key, prev ? { ...prev, after: change.after } : change);
      }
    }
  }
  if (merged.size === 0) return null;
  return { project: working, command: { kind: "cells", label: "Fill rectangle", mapId, changes: [...merged.values()] } };
}

// ---- Layers (per map, both kinds) ----

function layersResult(project: KreaProject, map: MapDocument, after: MapLayer[], label: string): OpResult {
  return {
    project: replaceMap(project, { ...map, layers: after }),
    command: { kind: "layers", label, mapId: map.id, before: map.layers, after },
  };
}

export function createLayer(project: KreaProject, mapId: string, layer: MapLayer): OpResult | null {
  const map = getMap(project, mapId);
  if (!map || map.layers.some((l) => l.id === layer.id)) return null;
  return layersResult(project, map, [...map.layers, layer], "Add layer");
}

/** Removes a layer and everything on it (cells on a 2D map, placements on a 3D map). */
export function removeLayer(project: KreaProject, mapId: string, layerId: string): OpResult | null {
  const map = getMap(project, mapId);
  if (!map || !map.layers.some((l) => l.id === layerId)) return null;

  const commands: EditorCommand[] = [];
  const after = map.layers.filter((l) => l.id !== layerId);
  let next: MapDocument;
  if (map.kind === "2d") {
    const removed = map.mapping.filter((m) => m.layerId === layerId);
    if (removed.length > 0) {
      commands.push({
        kind: "cells",
        label: "Remove layer instances",
        mapId,
        changes: removed.map((inst) => ({ layerId, x: inst.x, y: inst.y, before: inst, after: null })),
      });
    }
    next = { ...map, layers: after, mapping: map.mapping.filter((m) => m.layerId !== layerId) };
  } else {
    const removed = map.placements.filter((p) => p.layerId === layerId);
    if (removed.length > 0) {
      commands.push({
        kind: "placements",
        label: "Remove layer placements",
        mapId,
        changes: removed.map((p) => ({ id: p.id, before: p, after: null })),
      });
    }
    next = { ...map, layers: after, placements: map.placements.filter((p) => p.layerId !== layerId) };
  }
  commands.push({ kind: "layers", label: "Remove layer", mapId, before: map.layers, after });
  return { project: replaceMap(project, next), command: { kind: "batch", label: "Remove layer", commands } };
}

export function reorderLayer(project: KreaProject, mapId: string, layerId: string, toIndex: number): OpResult | null {
  const map = getMap(project, mapId);
  if (!map) return null;
  const idx = map.layers.findIndex((l) => l.id === layerId);
  if (idx < 0) return null;
  const clamped = Math.max(0, Math.min(map.layers.length - 1, toIndex));
  if (clamped === idx) return null;
  const after = map.layers.slice();
  const [moved] = after.splice(idx, 1);
  after.splice(clamped, 0, moved);
  return layersResult(project, map, after, "Reorder layers");
}

export function setLayerFlag(
  project: KreaProject,
  mapId: string,
  layerId: string,
  patch: Partial<Pick<MapLayer, "visible" | "locked" | "name">>,
): OpResult | null {
  const map = getMap(project, mapId);
  if (!map || !map.layers.some((l) => l.id === layerId)) return null;
  return layersResult(
    project,
    map,
    map.layers.map((l) => (l.id === layerId ? { ...l, ...patch } : l)),
    "Update layer",
  );
}

// ---- Maps ----

export function createMap(project: KreaProject, map: MapDocument): OpResult | null {
  if (project.maps.some((m) => m.id === map.id)) return null;
  return {
    project: { ...project, maps: [...project.maps, map] },
    command: { kind: "insertMap", label: "Add map", map, index: project.maps.length },
  };
}

/** Removes a map; the last remaining map can't be removed. */
export function removeMap(project: KreaProject, mapId: string): OpResult | null {
  const index = project.maps.findIndex((m) => m.id === mapId);
  if (index < 0 || project.maps.length <= 1) return null;
  return {
    project: { ...project, maps: project.maps.filter((m) => m.id !== mapId) },
    command: { kind: "removeMap", label: "Delete map", map: project.maps[index], index },
  };
}

export function renameMap(project: KreaProject, mapId: string, name: string): OpResult | null {
  const map = getMap(project, mapId);
  const trimmed = name.trim();
  if (!map || !trimmed || trimmed === map.name) return null;
  return {
    project: replaceMap(project, { ...map, name: trimmed }),
    command: { kind: "mapName", label: "Rename map", mapId, before: map.name, after: trimmed },
  };
}

/** Resizes a 2D map; instances whose footprint no longer fits are removed (restored on undo). */
export function resizeMap(project: KreaProject, mapId: string, width: number, height: number): OpResult | null {
  const map = get2DMap(project, mapId);
  if (!map) return null;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) return null;
  if (width === map.settings.width && height === map.settings.height) return null;

  const after: MapSettings = { ...map.settings, width, height };
  const removed = map.mapping.filter((m) => !isFootprintInBounds(m.x, m.y, sizeOf(project, m.objectId), after));

  const commands: EditorCommand[] = [];
  if (removed.length > 0) {
    commands.push({
      kind: "cells",
      label: "Remove out-of-bounds instances",
      mapId,
      changes: removed.map((inst) => ({ layerId: inst.layerId, x: inst.x, y: inst.y, before: inst, after: null })),
    });
  }
  commands.push({ kind: "settings", label: "Resize map", mapId, before: map.settings, after });

  const removedSet = new Set(removed);
  const next: Map2D = { ...map, settings: after, mapping: map.mapping.filter((m) => !removedSet.has(m)) };
  return { project: replaceMap(project, next), command: { kind: "batch", label: "Resize map", commands } };
}

// ---- Object catalog (shared by every map) ----

/**
 * 2D objects: sprite-less ones have no default sprite, others point at one of
 * their sprites, and none has a model. 3D objects have no sprites.
 */
function hasConsistentSprites(def: MapObjectDefinition): boolean {
  if (def.kind === "3d") return def.sprites.length === 0 && def.defaultSpriteId === undefined && (!def.modelSource || !!def.model);
  if (def.model !== undefined) return false;
  if (def.modelSource !== undefined) return false;
  if (def.sprites.length === 0) return def.defaultSpriteId === undefined;
  return def.sprites.some((s) => s.id === def.defaultSpriteId);
}

export function addObjectDefinition(project: KreaProject, def: MapObjectDefinition): OpResult | null {
  if (project.objects.some((o) => o.id === def.id)) return null;
  if (def.kind !== "2d" && def.kind !== "3d") return null;
  if (!hasConsistentSprites(def)) return null;
  const after = [...project.objects, def];
  return {
    project: { ...project, objects: after },
    command: { kind: "objects", label: "Add object", before: project.objects, after },
  };
}

/** An object's kind is fixed at creation (instances on 2D maps depend on it). */
export type ObjectDefinitionPatch = Partial<
  Pick<MapObjectDefinition, "name" | "description" | "sizeInTiles" | "sprites" | "defaultSpriteId" | "collisions" | "model" | "modelSource">
>;

/** Placements (3D maps) and instances (2D maps) of an object whose sprite no longer exists, reset to the default sprite. */
function resetRemovedSprites(project: KreaProject, next: KreaProject, objectId: string, remaining: Set<string>): {
  project: KreaProject;
  commands: EditorCommand[];
} {
  const commands: EditorCommand[] = [];
  for (const map of project.maps) {
    if (map.kind === "2d") {
      const changes: CellChange[] = [];
      for (const inst of map.mapping) {
        if (inst.objectId !== objectId || inst.spriteId === undefined || remaining.has(inst.spriteId)) continue;
        changes.push({ layerId: inst.layerId, x: inst.x, y: inst.y, before: inst, after: withSprite(inst, undefined) });
      }
      if (changes.length > 0) {
        commands.push({ kind: "cells", label: "Reset instance sprites", mapId: map.id, changes });
        next = replaceMap(next, { ...map, mapping: applyCellsToMapping(map.mapping, changes, true) });
      }
    } else {
      const changes: PlacementChange[] = [];
      for (const p of map.placements) {
        if (p.objectId !== objectId || p.spriteId === undefined || remaining.has(p.spriteId)) continue;
        const { spriteId: _dropped, ...rest } = p;
        changes.push({ id: p.id, before: p, after: rest as Placement3D });
      }
      if (changes.length > 0) {
        commands.push({ kind: "placements", label: "Reset placement sprites", mapId: map.id, changes });
        next = replaceMap(next, { ...map, placements: applyPlacementChanges(map.placements, changes, true) });
      }
    }
  }
  return { project: next, commands };
}

/**
 * Updates a catalog entry. If the patch removes sprites that placed instances
 * were using, those instances fall back to the object's default sprite (in
 * every map, as part of the same undo step).
 */
export function updateObjectDefinition(project: KreaProject, objectId: string, patch: ObjectDefinitionPatch): OpResult | null {
  const current = project.objects.find((o) => o.id === objectId);
  if (!current) return null;
  const updated: MapObjectDefinition = { ...current, ...patch, kind: current.kind };
  for (const key of ["description", "sizeInTiles", "defaultSpriteId", "collisions", "model"] as const) {
    if (key in patch && patch[key] === undefined) delete updated[key];
  }
  if (!hasConsistentSprites(updated)) return null;

  const afterObjects = project.objects.map((o) => (o.id === objectId ? updated : o));
  const reset = resetRemovedSprites(project, { ...project, objects: afterObjects }, objectId, new Set(updated.sprites.map((s) => s.id)));

  const objectsCommand: EditorCommand = { kind: "objects", label: "Update object", before: project.objects, after: afterObjects };
  if (reset.commands.length === 0) return { project: reset.project, command: objectsCommand };
  return { project: reset.project, command: { kind: "batch", label: "Update object", commands: [objectsCommand, ...reset.commands] } };
}

export function duplicateObjectDefinition(
  project: KreaProject,
  sourceObjectId: string,
  newId: string,
  newName: string,
): OpResult | null {
  const source = project.objects.find((o) => o.id === sourceObjectId);
  if (!source || project.objects.some((o) => o.id === newId)) return null;
  const copy: MapObjectDefinition = structuredClone({ ...source, id: newId, name: newName });
  const after = [...project.objects, copy];
  return {
    project: { ...project, objects: after },
    command: { kind: "objects", label: "Duplicate object", before: project.objects, after },
  };
}

/** Removes an object from the catalog and cascades to every instance/placement of it, in every map. */
export function removeObjectDefinition(project: KreaProject, objectId: string): OpResult | null {
  if (!project.objects.some((o) => o.id === objectId)) return null;
  const after = project.objects.filter((o) => o.id !== objectId);

  const commands: EditorCommand[] = [];
  const maps = project.maps.map((map): MapDocument => {
    if (map.kind === "2d") {
      const removed = map.mapping.filter((m) => m.objectId === objectId);
      if (removed.length === 0) return map;
      commands.push({
        kind: "cells",
        label: "Remove object instances",
        mapId: map.id,
        changes: removed.map((inst) => ({ layerId: inst.layerId, x: inst.x, y: inst.y, before: inst, after: null })),
      });
      return { ...map, mapping: map.mapping.filter((m) => m.objectId !== objectId) };
    }
    const removed = map.placements.filter((p) => p.objectId === objectId);
    if (removed.length === 0) return map;
    commands.push({
      kind: "placements",
      label: "Remove object placements",
      mapId: map.id,
      changes: removed.map((p) => ({ id: p.id, before: p, after: null })),
    });
    return { ...map, placements: map.placements.filter((p) => p.objectId !== objectId) };
  });
  commands.push({ kind: "objects", label: "Remove object", before: project.objects, after });

  return { project: { ...project, objects: after, maps }, command: { kind: "batch", label: "Remove object", commands } };
}

export function renameProject(project: KreaProject, name: string): OpResult | null {
  const trimmed = name.trim();
  if (!trimmed || trimmed === project.name) return null;
  return {
    project: { ...project, name: trimmed },
    command: { kind: "projectName", label: "Rename project", before: project.name, after: trimmed },
  };
}
