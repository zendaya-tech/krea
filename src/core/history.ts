import type {
  KreaProject,
  Map2D,
  Map3D,
  MapDocument,
  MapLayer,
  MapObjectDefinition,
  MapObjectInstance,
  MapSettings,
  Placement3D,
  TerrainInfo,
  WaterBody,
} from "./map-types";
import { SPLAT_CHANNELS, writeRegion, type TerrainRegion } from "./terrain";

/** A single mapping entry's before/after state, keyed by its origin cell — the atomic unit of undo for map edits. */
export interface CellChange {
  layerId: string;
  x: number;
  y: number;
  before: MapObjectInstance | null;
  after: MapObjectInstance | null;
}

/** A rectangle of terrain samples before and after an edit (heights and/or splat weights). */
export interface TerrainPatch {
  region: TerrainRegion;
  heightsBefore?: Float32Array;
  heightsAfter?: Float32Array;
  splatBefore?: Uint8Array;
  splatAfter?: Uint8Array;
  detailsBefore?: Uint8Array;
  detailsAfter?: Uint8Array;
}

/** Terrain settings that change without touching samples (layers, water). Splat/details are swapped whole when layers are removed. */
export interface TerrainInfoChange {
  before: Pick<TerrainInfo, "layers" | "waterLevel" | "detailLayers">;
  after: Pick<TerrainInfo, "layers" | "waterLevel" | "detailLayers">;
  splatBefore?: Uint8Array;
  splatAfter?: Uint8Array;
  detailsBefore?: Uint8Array;
  detailsAfter?: Uint8Array;
}

/** A placement's before/after state, keyed by its id (null = absent). */
export interface PlacementChange {
  id: string;
  before: Placement3D | null;
  after: Placement3D | null;
}

/**
 * Diff-based undo commands. Each variant stores only what changed, not a
 * full clone of the project, so painting/filling large areas stays cheap.
 * Map-level commands carry the `mapId` they apply to, so undo works on the
 * right map even after switching to another one. "batch" composes several
 * commands into one atomic undo step (e.g. deleting a catalog object also
 * removes its instances from every map).
 */
export type EditorCommand =
  | { kind: "cells"; label: string; mapId: string; changes: CellChange[] }
  | { kind: "layers"; label: string; mapId: string; before: MapLayer[]; after: MapLayer[] }
  | { kind: "settings"; label: string; mapId: string; before: MapSettings; after: MapSettings }
  | { kind: "mapName"; label: string; mapId: string; before: string; after: string }
  | { kind: "insertMap"; label: string; map: MapDocument; index: number }
  | { kind: "removeMap"; label: string; map: MapDocument; index: number }
  | { kind: "objects"; label: string; before: MapObjectDefinition[]; after: MapObjectDefinition[] }
  | { kind: "projectName"; label: string; before: string; after: string }
  | { kind: "terrain"; label: string; mapId: string; patch: TerrainPatch }
  | { kind: "terrainInfo"; label: string; mapId: string; change: TerrainInfoChange }
  | { kind: "placements"; label: string; mapId: string; changes: PlacementChange[] }
  | { kind: "waters"; label: string; mapId: string; before: WaterBody[]; after: WaterBody[] }
  | { kind: "batch"; label: string; commands: EditorCommand[] };

/** Applies cell changes to a mapping array, matching entries by their origin cell. */
export function applyCellsToMapping(
  mapping: MapObjectInstance[],
  changes: CellChange[],
  useAfter: boolean,
): MapObjectInstance[] {
  const next = mapping.slice();
  const ordered = useAfter ? changes : changes.slice().reverse();
  for (const change of ordered) {
    const idx = next.findIndex((m) => m.layerId === change.layerId && m.x === change.x && m.y === change.y);
    const value = useAfter ? change.after : change.before;
    if (idx >= 0) {
      if (value) next[idx] = value;
      else next.splice(idx, 1);
    } else if (value) {
      next.push(value);
    }
  }
  return next;
}

/** Applies placement changes, keeping untouched placements in order and appending new ones. */
export function applyPlacementChanges(placements: Placement3D[], changes: PlacementChange[], useAfter: boolean): Placement3D[] {
  const next = placements.slice();
  const ordered = useAfter ? changes : changes.slice().reverse();
  for (const change of ordered) {
    const idx = next.findIndex((p) => p.id === change.id);
    const value = useAfter ? change.after : change.before;
    if (idx >= 0) {
      if (value) next[idx] = value;
      else next.splice(idx, 1);
    } else if (value) {
      next.push(value);
    }
  }
  return next;
}

/** A copy of the terrain with the patch's before or after samples written in. */
export function applyTerrainPatchTo(map: Map3D, patch: TerrainPatch, useAfter: boolean): Map3D {
  const t = map.terrain;
  const heights = useAfter ? patch.heightsAfter : patch.heightsBefore;
  const splat = useAfter ? patch.splatAfter : patch.splatBefore;
  const details = useAfter ? patch.detailsAfter : patch.detailsBefore;
  const next = { ...t };
  if (details) {
    next.details = t.details.slice();
    writeRegion(next.details, t.resolution, SPLAT_CHANNELS, patch.region, details);
  }
  if (heights) {
    next.heights = t.heights.slice();
    writeRegion(next.heights, t.resolution, 1, patch.region, heights);
  }
  if (splat) {
    next.splat = t.splat.slice();
    writeRegion(next.splat, t.resolution, SPLAT_CHANNELS, patch.region, splat);
  }
  return { ...map, terrain: next };
}

function applyTerrainInfo(map: Map3D, change: TerrainInfoChange, useAfter: boolean): Map3D {
  const info = useAfter ? change.after : change.before;
  const splat = useAfter ? change.splatAfter : change.splatBefore;
  const details = useAfter ? change.detailsAfter : change.detailsBefore;
  return { ...map, terrain: { ...map.terrain, ...info, ...(splat ? { splat } : {}), ...(details ? { details } : {}) } };
}

function updateMap(project: KreaProject, mapId: string, update: (map: MapDocument) => MapDocument): KreaProject {
  return { ...project, maps: project.maps.map((m) => (m.id === mapId ? update(m) : m)) };
}

function update2D(project: KreaProject, mapId: string, update: (map: Map2D) => Map2D): KreaProject {
  return updateMap(project, mapId, (m) => (m.kind === "2d" ? update(m) : m));
}

function update3D(project: KreaProject, mapId: string, update: (map: Map3D) => Map3D): KreaProject {
  return updateMap(project, mapId, (m) => (m.kind === "3d" ? update(m) : m));
}

function insertMapAt(project: KreaProject, map: MapDocument, index: number): KreaProject {
  const maps = project.maps.filter((m) => m.id !== map.id);
  maps.splice(Math.min(index, maps.length), 0, map);
  return { ...project, maps };
}

function removeMapById(project: KreaProject, mapId: string): KreaProject {
  return { ...project, maps: project.maps.filter((m) => m.id !== mapId) };
}

function run(project: KreaProject, command: EditorCommand, forward: boolean): KreaProject {
  switch (command.kind) {
    case "cells":
      return update2D(project, command.mapId, (m) => ({ ...m, mapping: applyCellsToMapping(m.mapping, command.changes, forward) }));
    case "layers":
      return updateMap(project, command.mapId, (m) => ({ ...m, layers: forward ? command.after : command.before }));
    case "settings":
      return update2D(project, command.mapId, (m) => ({ ...m, settings: forward ? command.after : command.before }));
    case "mapName":
      return updateMap(project, command.mapId, (m) => ({ ...m, name: forward ? command.after : command.before }));
    case "insertMap":
      return forward ? insertMapAt(project, command.map, command.index) : removeMapById(project, command.map.id);
    case "removeMap":
      return forward ? removeMapById(project, command.map.id) : insertMapAt(project, command.map, command.index);
    case "objects":
      return { ...project, objects: forward ? command.after : command.before };
    case "projectName":
      return { ...project, name: forward ? command.after : command.before };
    case "terrain":
      return update3D(project, command.mapId, (m) => applyTerrainPatchTo(m, command.patch, forward));
    case "terrainInfo":
      return update3D(project, command.mapId, (m) => applyTerrainInfo(m, command.change, forward));
    case "placements":
      return update3D(project, command.mapId, (m) => ({ ...m, placements: applyPlacementChanges(m.placements, command.changes, forward) }));
    case "waters":
      return update3D(project, command.mapId, (m) => ({ ...m, waters: forward ? command.after : command.before }));
    case "batch":
      return forward
        ? command.commands.reduce((p, c) => run(p, c, true), project)
        : command.commands
            .slice()
            .reverse()
            .reduce((p, c) => run(p, c, false), project);
  }
}

export function applyCommand(project: KreaProject, command: EditorCommand): KreaProject {
  return run(project, command, true);
}

export function invertCommand(project: KreaProject, command: EditorCommand): KreaProject {
  return run(project, command, false);
}

/** The map a command affects, if it's map-scoped — lets the editor jump to it on undo/redo. */
export function commandMapId(command: EditorCommand): string | null {
  switch (command.kind) {
    case "insertMap":
    case "removeMap":
      return command.map.id;
    case "batch":
      for (const c of command.commands) {
        const id = commandMapId(c);
        if (id) return id;
      }
      return null;
    case "objects":
    case "projectName":
      return null;
    default:
      return command.mapId;
  }
}

export interface History {
  past: EditorCommand[];
  future: EditorCommand[];
}

export const EMPTY_HISTORY: History = { past: [], future: [] };

/** Terrain patches can be large; old steps are dropped past this depth. */
export const MAX_HISTORY = 200;

export function pushCommand(history: History, command: EditorCommand): History {
  const past = [...history.past, command];
  return { past: past.length > MAX_HISTORY ? past.slice(past.length - MAX_HISTORY) : past, future: [] };
}

export function undo(
  project: KreaProject,
  history: History,
): { project: KreaProject; history: History; command: EditorCommand } | null {
  const command = history.past[history.past.length - 1];
  if (!command) return null;
  return {
    project: invertCommand(project, command),
    history: { past: history.past.slice(0, -1), future: [command, ...history.future] },
    command,
  };
}

export function redo(
  project: KreaProject,
  history: History,
): { project: KreaProject; history: History; command: EditorCommand } | null {
  const command = history.future[0];
  if (!command) return null;
  return {
    project: applyCommand(project, command),
    history: { past: [...history.past, command], future: history.future.slice(1) },
    command,
  };
}
