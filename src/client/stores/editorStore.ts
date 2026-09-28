import { create } from "zustand";
import type {
  EditorCamera,
  EditorTool,
  KreaProject,
  Map2D,
  Map3D,
  MapDocument,
  MapLayer,
  MapObjectDefinition,
  MapObjectInstance,
  MapSettings,
  ObjectKind,
  DetailLayer,
  TerrainLayer,
} from "@core/map-types";
import { ZOOM_LEVELS } from "@core/map-types";
import type { ValidationIssue } from "@core/map-validator";
import { validateProject } from "@core/map-validator";
import {
  EMPTY_HISTORY,
  commandMapId,
  pushCommand,
  redo as redoHistory,
  undo as undoHistory,
  type CellChange,
  type EditorCommand,
  type History,
  type TerrainPatch,
} from "@core/history";
import { buildCellIndex, cellKey, generateId, getMap, screenToWorld, uniqueId } from "@core/map-utils";
import * as ops from "@core/map-operations";
import * as ops3d from "@core/map3d-operations";
import type { ObjectDefinitionPatch, OpResult } from "@core/map-operations";
import { DEFAULT_SPRITE_ID, createDefaultMap, createDefaultMap3D, type Map3DParams } from "@core/project-migration";
import type { GenerateParams, SculptMode } from "@core/terrain";
import type { ExportRequestOptions, ExportResponse, ProjectInfo } from "@shared/api-types";
import * as api from "../net/client";
import { clearImageCache } from "../canvas/image-cache";
import { rememberRecentProject } from "../recent-projects";

export interface SelectedInstance {
  layerId: string;
  x: number;
  y: number;
}

export type SaveStatus = "idle" | "saving" | "saved" | "error";

/** Tools of the 3D editor. Camera: right-drag orbits, middle-drag pans, wheel zooms — in every tool. */
export type Tool3D = "select" | "place" | "sculpt" | "paint" | "water";
export type TransformMode = "translate" | "rotate" | "scale";

export interface Brush {
  /** Meters. */
  radius: number;
  /** 0-1: raise/lower speed, or smooth/flatten/paint blend. */
  strength: number;
}

export type NewMapParams =
  | ({ kind: "2d"; name: string } & MapSettings)
  | ({ kind: "3d"; name: string } & Pick<Map3DParams, "width" | "depth" | "resolution" | "waterLevel">);

interface EditorState {
  project: KreaProject | null;
  projectInfo: ProjectInfo | null;
  activeMapId: string | null;
  /** Footprint-aware cell lookup for the active map (2D maps; empty for 3D). */
  cellIndex: Map<string, MapObjectInstance>;
  migratedFrom: string | null;

  tool: EditorTool;
  selectedObjectId: string | null;
  activeLayerId: string | null;
  selectedInstances: SelectedInstance[];

  // 3D editor
  tool3d: Tool3D;
  sculptMode: SculptMode;
  brush: Brush;
  paintLayerId: string | null;
  /** Kept for editing detail layers in older projects. New vegetation uses objects. */
  detailLayerId: string | null;
  detailErase: boolean;
  transformMode: TransformMode;
  selectedPlacementIds: string[];
  /** The lake/pond shown in the water panel. */
  selectedWaterId: string | null;
  /** Feedback of the water tool (e.g. "no hollow here"). */
  waterHint: string | null;
  /** Randomize yaw and scale a little when placing (natural-looking vegetation). */
  placeRandomize: boolean;
  placeScatter: boolean;
  placeCount: number;
  placeRadius: number;
  placeSpacing: number;
  placeMaxSlope: number;
  placeOnTerrainLayerId: string | null;
  placeWater: "avoid" | "only" | "any";
  placeHint: string | null;
  /** World point under the cursor on the terrain. */
  hoverPoint: { x: number; y: number; z: number } | null;

  camera: EditorCamera;
  showGrid: boolean;
  showCollisions: boolean;
  hoverCell: { x: number; y: number } | null;

  history: History;
  dirty: boolean;
  issues: ValidationIssue[];
  saveStatus: SaveStatus;
  saveError: string | null;
  loadError: string | null;

  strokeChanges: CellChange[] | null;

  openProject: (path: string) => Promise<void>;
  newProject: (params: api.NewProjectParams) => Promise<void>;
  closeProject: () => void;

  switchMap: (mapId: string) => void;
  createMap: (params: NewMapParams) => void;
  renameMap: (mapId: string, name: string) => void;
  deleteMap: (mapId: string) => void;
  resizeMap: (width: number, height: number) => void;
  renameProject: (name: string) => void;

  setTool: (tool: EditorTool) => void;
  selectObject: (objectId: string | null) => void;
  setActiveLayer: (layerId: string) => void;
  selectInstanceAt: (layerId: string, x: number, y: number) => void;
  selectAllOfType: (objectId: string) => void;
  clearSelection: () => void;
  deleteSelectedInstances: () => void;
  deleteAllOfType: (objectId: string) => void;
  duplicateInstanceAt: (layerId: string, x: number, y: number) => void;
  setSelectedSprite: (spriteId: string | null) => void;

  beginStroke: () => void;
  paintAt: (x: number, y: number) => void;
  endStroke: () => void;
  fillAt: (x: number, y: number) => void;
  updateSelectedPosition: (toX: number, toY: number) => void;

  // 3D editor
  setTool3d: (tool: Tool3D) => void;
  setSculptMode: (mode: SculptMode) => void;
  setBrush: (brush: Partial<Brush>) => void;
  setPaintLayer: (layerId: string) => void;
  setDetailLayer: (layerId: string) => void;
  setDetailErase: (erase: boolean) => void;
  addDetailLayer: (layer: Omit<DetailLayer, "id">) => void;
  updateDetailLayer: (layerId: string, patch: ops3d.DetailLayerPatch) => void;
  removeDetailLayer: (layerId: string) => void;
  autoPaintDetails: (params: ops3d.FillDetailsParams) => void;
  setTransformMode: (mode: TransformMode) => void;
  setPlaceRandomize: (on: boolean) => void;
  setPlaceSettings: (settings: Partial<Pick<EditorState, "placeScatter" | "placeCount" | "placeRadius" | "placeSpacing" | "placeMaxSlope" | "placeOnTerrainLayerId" | "placeWater">>) => void;
  setHoverPoint: (p: { x: number; y: number; z: number } | null) => void;
  commitTerrainPatch: (patch: TerrainPatch, label: string) => void;
  generateTerrain: (params: Partial<GenerateParams>) => void;
  autoPaintTerrain: (rules: ops3d.AutoPaintRuleById[]) => void;
  setWaterLevel: (level: number | null) => void;
  addTerrainLayer: (layer: Omit<TerrainLayer, "id">) => void;
  updateTerrainLayer: (layerId: string, patch: Partial<Omit<TerrainLayer, "id">>) => void;
  removeTerrainLayer: (layerId: string) => void;
  placeObjectAt3D: (x: number, z: number) => void;
  selectPlacement: (id: string | null, additive?: boolean) => void;
  selectAllPlacementsOfType: (objectId: string) => void;
  updatePlacements: (updates: Array<ops3d.PlacementPatch & { id: string }>) => void;
  deleteSelectedPlacements: () => void;
  deleteAllPlacementsOfType: (objectId: string) => void;
  duplicateSelectedPlacements: () => void;
  scatter: (params: Omit<ops3d.ScatterParams, "objectId" | "layerId">) => number;
  /** Water tool: a lake poured at (x, z), 1.5 m deep at that point; adjust its level afterwards. */
  addWaterAt: (x: number, z: number) => void;
  selectWater: (id: string | null) => void;
  updateWaterBody: (id: string, patch: ops3d.WaterBodyPatch) => void;
  removeWaterBody: (id: string) => void;

  addLayer: (name: string) => void;
  removeLayer: (layerId: string) => void;
  reorderLayer: (layerId: string, toIndex: number) => void;
  toggleLayerVisibility: (layerId: string) => void;
  toggleLayerLock: (layerId: string) => void;
  renameLayer: (layerId: string, name: string) => void;

  /**
   * 2D objects: without `image` the object is sprite-less (invisible: spawn point, trigger…).
   * 3D objects: `model` is a .glb; without it the object is an invisible 3D marker.
   */
  addObjectDefinition: (params: {
    name: string;
    kind: ObjectKind;
    image?: string;
    model?: string;
    modelSource?: import("@core/model3d").EditableModel3D;
    description?: string;
    sizeInTiles?: { width: number; height: number };
  }) => void;
  updateObjectDefinition: (objectId: string, patch: ObjectDefinitionPatch) => void;
  duplicateObjectDefinition: (sourceObjectId: string) => void;
  removeObjectDefinition: (objectId: string) => void;

  undo: () => void;
  redo: () => void;

  setCamera: (partial: Partial<EditorCamera>) => void;
  zoomTo: (level: number, anchor: { x: number; y: number }) => void;
  zoomStep: (direction: 1 | -1, anchor: { x: number; y: number }) => void;
  setShowGrid: (show: boolean) => void;
  setShowCollisions: (show: boolean) => void;
  setHoverCell: (cell: { x: number; y: number } | null) => void;

  save: () => Promise<void>;
  exportActiveMap: (options: Omit<ExportRequestOptions, "mapId">) => Promise<ExportResponse>;
  runLocalValidation: () => void;
}

type SetState = (partial: Partial<EditorState> | ((s: EditorState) => Partial<EditorState>)) => void;

function indexFor(project: KreaProject | null, mapId: string | null): Map<string, MapObjectInstance> {
  const map = project && mapId ? getMap(project, mapId) : undefined;
  return map?.kind === "2d" ? buildCellIndex(map.mapping, project!.objects) : new Map();
}

/** The map the editor currently shows. */
export function selectActiveMap(s: Pick<EditorState, "project" | "activeMapId">): MapDocument | null {
  return (s.project && s.activeMapId && getMap(s.project, s.activeMapId)) || null;
}

export function selectActive2DMap(s: Pick<EditorState, "project" | "activeMapId">): Map2D | null {
  const map = selectActiveMap(s);
  return map?.kind === "2d" ? map : null;
}

export function selectActive3DMap(s: Pick<EditorState, "project" | "activeMapId">): Map3D | null {
  const map = selectActiveMap(s);
  return map?.kind === "3d" ? map : null;
}

/** Selections that still exist after an edit (undo can remove placements). */
function survivingPlacements(project: KreaProject, mapId: string | null, ids: string[]): string[] {
  const map = mapId ? getMap(project, mapId) : undefined;
  if (map?.kind !== "3d" || ids.length === 0) return map?.kind === "3d" ? ids : [];
  const existing = new Set(map.placements.map((p) => p.id));
  return ids.filter((id) => existing.has(id));
}

function commitResult(set: SetState, result: OpResult) {
  set((s) => ({
    project: result.project,
    cellIndex: indexFor(result.project, s.activeMapId),
    history: pushCommand(s.history, result.command),
    dirty: true,
    issues: validateProject(result.project).issues,
    selectedPlacementIds: survivingPlacements(result.project, s.activeMapId, s.selectedPlacementIds),
  }));
}

/** Fresh per-map view state: used when opening a project or switching maps. */
function mapViewState(project: KreaProject, mapId: string): Partial<EditorState> {
  const map = getMap(project, mapId);
  return {
    activeMapId: mapId,
    cellIndex: indexFor(project, mapId),
    activeLayerId: map?.layers[0]?.id ?? null,
    selectedInstances: [],
    selectedPlacementIds: [],
    selectedWaterId: null,
    paintLayerId: map?.kind === "3d" ? (map.terrain.layers[0]?.id ?? null) : null,
    detailLayerId: map?.kind === "3d" ? (map.terrain.detailLayers[0]?.id ?? null) : null,
    hoverCell: null,
    hoverPoint: null,
    placeHint: null,
    camera: { x: 0, y: 0, zoom: 1 },
  };
}

export const useEditorStore = create<EditorState>((set, get) => {
  /** Runs a map-level operation against the active map and commits it. */
  function onActiveMap(run: (project: KreaProject, mapId: string) => OpResult | null): OpResult | null {
    const { project, activeMapId } = get();
    if (!project || !activeMapId) return null;
    const result = run(project, activeMapId);
    if (result) commitResult(set, result);
    return result;
  }

  function onProject(run: (project: KreaProject) => OpResult | null): OpResult | null {
    const { project } = get();
    if (!project) return null;
    const result = run(project);
    if (result) commitResult(set, result);
    return result;
  }

  function afterHistoryMove(project: KreaProject, history: History, command: EditorCommand) {
    const target = commandMapId(command);
    const current = get().activeMapId;
    const nextMapId =
      target && getMap(project, target) ? target : current && getMap(project, current) ? current : project.maps[0].id;
    set((s) => ({
      project,
      history,
      dirty: true,
      issues: validateProject(project).issues,
      ...(nextMapId !== current
        ? mapViewState(project, nextMapId)
        : {
            cellIndex: indexFor(project, nextMapId),
            activeMapId: nextMapId,
            selectedPlacementIds: survivingPlacements(project, nextMapId, s.selectedPlacementIds),
          }),
    }));
  }

  function selectedPlacementUpdates(map: Map3D, ids: string[]) {
    return map.placements.filter((p) => ids.includes(p.id));
  }

  return {
    project: null,
    projectInfo: null,
    activeMapId: null,
    cellIndex: new Map(),
    migratedFrom: null,

    tool: "pencil",
    selectedObjectId: null,
    activeLayerId: null,
    selectedInstances: [],

    tool3d: "sculpt",
    sculptMode: "raise",
    brush: { radius: 6, strength: 0.5 },
    paintLayerId: null,
    detailLayerId: null,
    detailErase: false,
    transformMode: "translate",
    selectedPlacementIds: [],
    selectedWaterId: null,
    waterHint: null,
    placeRandomize: false,
    placeScatter: false,
    placeCount: 20,
    placeRadius: 8,
    placeSpacing: 0.8,
    placeMaxSlope: 35,
    placeOnTerrainLayerId: null,
    placeWater: "avoid",
    placeHint: null,
    hoverPoint: null,

    camera: { x: 0, y: 0, zoom: 1 },
    showGrid: true,
    showCollisions: false,
    hoverCell: null,

    history: EMPTY_HISTORY,
    dirty: false,
    issues: [],
    saveStatus: "idle",
    saveError: null,
    loadError: null,

    strokeChanges: null,

    openProject: async (path) => {
      set({ loadError: null });
      try {
        const res = await api.openProject(path);
        clearImageCache();
        set({
          project: res.project,
          projectInfo: res.info,
          migratedFrom: res.migratedFrom,
          history: EMPTY_HISTORY,
          // A migrated legacy project only exists as .krea once saved.
          dirty: res.migratedFrom !== null,
          issues: res.issues,
          selectedObjectId: res.project.objects[0]?.id ?? null,
          saveStatus: "idle",
          ...mapViewState(res.project, res.project.maps[0].id),
        });
        rememberRecentProject(res.info.file, res.project.name);
      } catch (e) {
        set({ loadError: e instanceof Error ? e.message : "Failed to open project." });
        throw e;
      }
    },

    newProject: async (params) => {
      set({ loadError: null });
      try {
        const res = await api.createProject(params);
        clearImageCache();
        set({
          project: res.project,
          projectInfo: res.info,
          migratedFrom: null,
          history: EMPTY_HISTORY,
          // Not written to disk yet — the first Save creates the .krea file.
          dirty: true,
          issues: [],
          selectedObjectId: null,
          saveStatus: "idle",
          ...mapViewState(res.project, res.project.maps[0].id),
        });
      } catch (e) {
        set({ loadError: e instanceof Error ? e.message : "Failed to create project." });
        throw e;
      }
    },

    closeProject: () => {
      clearImageCache();
      set({ project: null, projectInfo: null, activeMapId: null, cellIndex: new Map(), history: EMPTY_HISTORY, dirty: false, issues: [] });
    },

    switchMap: (mapId) => {
      const { project, activeMapId } = get();
      if (!project || mapId === activeMapId || !getMap(project, mapId)) return;
      set({ ...mapViewState(project, mapId), strokeChanges: null });
    },

    createMap: (params) => {
      const { project } = get();
      if (!project) return;
      const id = uniqueId(project.maps.map((m) => m.id), params.name);
      const name = params.name.trim() || id;
      const map =
        params.kind === "3d"
          ? createDefaultMap3D(id, name, { width: params.width, depth: params.depth, resolution: params.resolution, waterLevel: params.waterLevel })
          : createDefaultMap(id, name, { width: params.width, height: params.height, tileWidth: params.tileWidth, tileHeight: params.tileHeight });
      const result = onProject((p) => ops.createMap(p, map));
      if (result) get().switchMap(id);
    },

    renameMap: (mapId, name) => {
      onProject((p) => ops.renameMap(p, mapId, name));
    },

    deleteMap: (mapId) => {
      const result = onProject((p) => ops.removeMap(p, mapId));
      if (result && get().activeMapId === mapId) {
        const project = get().project!;
        set(mapViewState(project, project.maps[0].id));
      }
    },

    resizeMap: (width, height) => {
      onActiveMap((p, mapId) => ops.resizeMap(p, mapId, width, height));
    },

    renameProject: (name) => {
      onProject((p) => ops.renameProject(p, name));
    },

    setTool: (tool) => set((s) => ({ tool, selectedInstances: tool === "select" ? s.selectedInstances : [] })),
    selectObject: (objectId) => set({ selectedObjectId: objectId }),
    setActiveLayer: (layerId) => set({ activeLayerId: layerId }),

    selectInstanceAt: (layerId, x, y) => {
      // Store the instance's own origin, not the clicked cell — for multi-cell
      // objects those differ, and origin is what mapping[] lookups key on.
      const inst = get().cellIndex.get(cellKey(layerId, x, y));
      set({ selectedInstances: inst ? [{ layerId, x: inst.x, y: inst.y }] : [] });
    },

    selectAllOfType: (objectId) => {
      const { project, activeMapId } = get();
      if (!project || !activeMapId) return;
      set({ selectedInstances: ops.findInstancesByObjectId(project, activeMapId, objectId) });
    },

    clearSelection: () => set({ selectedInstances: [], selectedPlacementIds: [] }),

    deleteSelectedInstances: () => {
      const targets = get().selectedInstances;
      if (targets.length === 0) return;
      if (onActiveMap((p, mapId) => ops.removeInstances(p, mapId, targets))) set({ selectedInstances: [] });
    },

    deleteAllOfType: (objectId) => {
      const result = onActiveMap((p, mapId) => ops.removeInstances(p, mapId, ops.findInstancesByObjectId(p, mapId, objectId)));
      if (result) set({ selectedInstances: [] });
    },

    duplicateInstanceAt: (layerId, x, y) => {
      const result = onActiveMap((p, mapId) => ops.duplicateInstance(p, mapId, { layerId, x, y }));
      if (result?.command.kind === "cells") {
        const placed = result.command.changes[0].after;
        if (placed) set({ selectedInstances: [{ layerId: placed.layerId, x: placed.x, y: placed.y }] });
      }
    },

    setSelectedSprite: (spriteId) => {
      const sel = get().selectedInstances;
      if (sel.length !== 1) return;
      onActiveMap((p, mapId) => ops.setInstanceSprite(p, mapId, { ...sel[0], spriteId }));
    },

    beginStroke: () => set({ strokeChanges: [] }),

    paintAt: (x, y) => {
      const state = get();
      const { project, activeMapId, activeLayerId } = state;
      if (!project || !activeMapId || !activeLayerId) return;

      let result: OpResult | null = null;
      if (state.tool === "pencil") {
        if (!state.selectedObjectId) return;
        result = ops.placeObject(project, activeMapId, { objectId: state.selectedObjectId, layerId: activeLayerId, x, y });
      } else if (state.tool === "eraser") {
        result = ops.removeObject(project, activeMapId, { layerId: activeLayerId, x, y });
      }
      if (!result || result.command.kind !== "cells") return;
      const newChanges = result.command.changes;
      const nextProject = result.project;

      // A drag is one undo step: accumulate cell changes, keeping each cell's first "before" and last "after".
      set((s) => {
        const strokeChanges = s.strokeChanges ? s.strokeChanges.slice() : [];
        for (const change of newChanges) {
          const idx = strokeChanges.findIndex((c) => c.layerId === change.layerId && c.x === change.x && c.y === change.y);
          if (idx >= 0) strokeChanges[idx] = { ...strokeChanges[idx], after: change.after };
          else strokeChanges.push(change);
        }
        return { project: nextProject, cellIndex: indexFor(nextProject, s.activeMapId), strokeChanges, dirty: true };
      });
    },

    endStroke: () => {
      const { strokeChanges, activeMapId, tool, project } = get();
      if (strokeChanges && strokeChanges.length > 0 && activeMapId && project) {
        const command: EditorCommand = { kind: "cells", label: tool === "eraser" ? "Erase" : "Paint", mapId: activeMapId, changes: strokeChanges };
        set((s) => ({ history: pushCommand(s.history, command), strokeChanges: null, issues: validateProject(project).issues }));
      } else if (strokeChanges) {
        set({ strokeChanges: null });
      }
    },

    fillAt: (x, y) => {
      const { selectedObjectId, activeLayerId } = get();
      if (!selectedObjectId || !activeLayerId) return;
      onActiveMap((p, mapId) => ops.fillArea(p, mapId, { objectId: selectedObjectId, layerId: activeLayerId, x, y }));
    },

    updateSelectedPosition: (toX, toY) => {
      const sel = get().selectedInstances;
      if (sel.length !== 1) return;
      const { layerId, x, y } = sel[0];
      if (onActiveMap((p, mapId) => ops.moveObject(p, mapId, { layerId, x, y, toX, toY }))) {
        set({ selectedInstances: [{ layerId, x: toX, y: toY }] });
      }
    },

    // ---- 3D ----

    setTool3d: (tool3d) => set((s) => ({ tool3d, selectedPlacementIds: tool3d === "select" ? s.selectedPlacementIds : [] })),
    setSculptMode: (sculptMode) => set({ sculptMode, tool3d: "sculpt" }),
    setBrush: (brush) => set((s) => ({ brush: { ...s.brush, ...brush } })),
    setPaintLayer: (paintLayerId) => set({ paintLayerId, tool3d: "paint" }),
    setDetailLayer: (detailLayerId) => set({ detailLayerId }),
    setDetailErase: (detailErase) => set({ detailErase }),

    addDetailLayer: (layer) => {
      const map = selectActive3DMap(get());
      if (!map) return;
      const id = uniqueId(map.terrain.detailLayers.map((l) => l.id), layer.name);
      if (onActiveMap((p, mapId) => ops3d.addDetailLayer(p, mapId, { ...layer, id }))) set({ detailLayerId: id });
    },

    updateDetailLayer: (layerId, patch) => {
      onActiveMap((p, mapId) => ops3d.updateDetailLayer(p, mapId, layerId, patch));
    },

    removeDetailLayer: (layerId) => {
      if (onActiveMap((p, mapId) => ops3d.removeDetailLayer(p, mapId, layerId)) && get().detailLayerId === layerId) {
        set({ detailLayerId: selectActive3DMap(get())?.terrain.detailLayers[0]?.id ?? null });
      }
    },

    autoPaintDetails: (params) => {
      onActiveMap((p, mapId) => ops3d.autoPaintDetails(p, mapId, params));
    },
    setTransformMode: (transformMode) => set({ transformMode }),
    setPlaceRandomize: (placeRandomize) => set({ placeRandomize }),
    setPlaceSettings: (settings) => set(settings),
    setHoverPoint: (hoverPoint) => set({ hoverPoint }),

    commitTerrainPatch: (patch, label) => {
      onActiveMap((p, mapId) => ops3d.commitTerrainPatch(p, mapId, patch, label));
    },

    generateTerrain: (params) => {
      onActiveMap((p, mapId) => ops3d.generateTerrain(p, mapId, params));
    },

    autoPaintTerrain: (rules) => {
      onActiveMap((p, mapId) => ops3d.autoPaintTerrain(p, mapId, { rules }));
    },

    setWaterLevel: (level) => {
      onActiveMap((p, mapId) => ops3d.setWaterLevel(p, mapId, level));
    },

    addTerrainLayer: (layer) => {
      const map = selectActive3DMap(get());
      if (!map) return;
      const id = uniqueId(map.terrain.layers.map((l) => l.id), layer.name);
      if (onActiveMap((p, mapId) => ops3d.addTerrainLayer(p, mapId, { ...layer, id }))) set({ paintLayerId: id });
    },

    updateTerrainLayer: (layerId, patch) => {
      onActiveMap((p, mapId) => ops3d.updateTerrainLayer(p, mapId, layerId, patch));
    },

    removeTerrainLayer: (layerId) => {
      const result = onActiveMap((p, mapId) => ops3d.removeTerrainLayer(p, mapId, layerId));
      if (result && get().paintLayerId === layerId) set({ paintLayerId: selectActive3DMap(get())?.terrain.layers[0]?.id ?? null });
    },

    placeObjectAt3D: (x, z) => {
      const { selectedObjectId, activeLayerId, placeRandomize, placeScatter, placeCount, placeRadius, placeSpacing, placeMaxSlope, placeOnTerrainLayerId, placeWater } = get();
      if (!selectedObjectId || !activeLayerId) {
        set({ placeHint: "Select an object and an unlocked layer first." });
        return;
      }
      const rotation = placeRandomize ? Math.round(Math.random() * 360) : 0;
      const scale = placeRandomize ? Math.round((0.85 + Math.random() * 0.3) * 100) / 100 : 1;
      const round = (v: number) => Math.round(v * 100) / 100;
      const { project, activeMapId } = get();
      if (!project || !activeMapId) return;
      if (placeScatter) {
        const result = ops3d.scatterObjects3D(project, activeMapId, {
          objectId: selectedObjectId,
          layerId: activeLayerId,
          count: placeCount,
          circle: { x, z, radius: placeRadius },
          minDistance: placeSpacing,
          avoidOtherObjects: false,
          maxSlope: placeMaxSlope,
          onTerrainLayerId: placeOnTerrainLayerId ?? undefined,
          water: placeWater,
          randomRotation: placeRandomize,
          scaleMin: placeRandomize ? 0.85 : 1,
          scaleMax: placeRandomize ? 1.15 : 1,
          seed: Math.floor(Math.random() * 1e9),
        });
        if (result) commitResult(set, result);
        set({ placeHint: result ? `Placed ${result.ids.length} ${result.ids.length === 1 ? "object" : "objects"}.` : "No valid position in this radius. Try a larger radius or smaller spacing." });
        return;
      }
      const result = ops3d.placeObject3D(project, activeMapId, { objectId: selectedObjectId, layerId: activeLayerId, x: round(x), z: round(z), rotation, scale });
      if (result) commitResult(set, result);
      set({ placeHint: result ? "Object placed." : "Cannot place on this layer or outside the terrain." });
    },

    selectPlacement: (id, additive = false) => {
      if (id === null) {
        if (!additive) set({ selectedPlacementIds: [] });
        return;
      }
      set((s) => {
        if (!additive) return { selectedPlacementIds: [id] };
        const has = s.selectedPlacementIds.includes(id);
        return { selectedPlacementIds: has ? s.selectedPlacementIds.filter((x) => x !== id) : [...s.selectedPlacementIds, id] };
      });
    },

    selectAllPlacementsOfType: (objectId) => {
      const { project, activeMapId } = get();
      if (!project || !activeMapId) return;
      set({ selectedPlacementIds: ops3d.findPlacementsByObjectId(project, activeMapId, objectId), tool3d: "select" });
    },

    updatePlacements: (updates) => {
      onActiveMap((p, mapId) => ops3d.updatePlacements3D(p, mapId, updates));
    },

    deleteSelectedPlacements: () => {
      const ids = get().selectedPlacementIds;
      if (ids.length === 0) return;
      if (onActiveMap((p, mapId) => ops3d.removePlacements3D(p, mapId, ids))) set({ selectedPlacementIds: [] });
    },

    deleteAllPlacementsOfType: (objectId) => {
      onActiveMap((p, mapId) => ops3d.removePlacements3D(p, mapId, ops3d.findPlacementsByObjectId(p, mapId, objectId)));
    },

    duplicateSelectedPlacements: () => {
      const map = selectActive3DMap(get());
      if (!map) return;
      const ids = selectedPlacementUpdates(map, get().selectedPlacementIds).map((p) => p.id);
      if (ids.length === 0) return;
      const { project, activeMapId } = get();
      const result = ops3d.duplicatePlacements3D(project!, activeMapId!, { ids });
      if (result) {
        commitResult(set, result);
        set({ selectedPlacementIds: result.ids });
      }
    },

    scatter: (params) => {
      const { project, activeMapId, selectedObjectId, activeLayerId } = get();
      if (!project || !activeMapId || !selectedObjectId || !activeLayerId) return 0;
      const result = ops3d.scatterObjects3D(project, activeMapId, { ...params, objectId: selectedObjectId, layerId: activeLayerId });
      if (!result) return 0;
      commitResult(set, result);
      return result.ids.length;
    },

    addWaterAt: (x, z) => {
      const { project, activeMapId } = get();
      if (!project || !activeMapId) return;
      // Fill the hollow to the brim, like real water: it can't leak down the slope.
      const result = ops3d.addWaterBody(project, activeMapId, { x, z, fill: true, name: "Lake" });
      if (result) {
        commitResult(set, result);
        set({ selectedWaterId: result.id, waterHint: null });
      } else {
        set({ waterHint: "No hollow there — dig a basin with Lower (2) first, then click inside it." });
      }
    },

    selectWater: (selectedWaterId) => set({ selectedWaterId }),

    updateWaterBody: (id, patch) => {
      onActiveMap((p, mapId) => ops3d.updateWaterBody(p, mapId, id, patch));
    },

    removeWaterBody: (id) => {
      if (onActiveMap((p, mapId) => ops3d.removeWaterBody(p, mapId, id))) set((s) => ({ selectedWaterId: s.selectedWaterId === id ? null : s.selectedWaterId }));
    },

    addLayer: (name) => {
      const layer: MapLayer = { id: generateId("layer"), name, visible: true, locked: false };
      if (onActiveMap((p, mapId) => ops.createLayer(p, mapId, layer))) set({ activeLayerId: layer.id });
    },

    removeLayer: (layerId) => {
      const result = onActiveMap((p, mapId) => ops.removeLayer(p, mapId, layerId));
      if (!result) return;
      set((s) => ({
        activeLayerId: s.activeLayerId === layerId ? (selectActiveMap(s)?.layers[0]?.id ?? null) : s.activeLayerId,
        selectedInstances: s.selectedInstances.filter((sel) => sel.layerId !== layerId),
      }));
    },

    reorderLayer: (layerId, toIndex) => {
      onActiveMap((p, mapId) => ops.reorderLayer(p, mapId, layerId, toIndex));
    },

    toggleLayerVisibility: (layerId) => {
      const layer = selectActiveMap(get())?.layers.find((l) => l.id === layerId);
      if (layer) onActiveMap((p, mapId) => ops.setLayerFlag(p, mapId, layerId, { visible: !layer.visible }));
    },

    toggleLayerLock: (layerId) => {
      const layer = selectActiveMap(get())?.layers.find((l) => l.id === layerId);
      if (layer) onActiveMap((p, mapId) => ops.setLayerFlag(p, mapId, layerId, { locked: !layer.locked }));
    },

    renameLayer: (layerId, name) => {
      onActiveMap((p, mapId) => ops.setLayerFlag(p, mapId, layerId, { name }));
    },

    addObjectDefinition: ({ name, kind, image, model, modelSource, description, sizeInTiles }) => {
      const { project } = get();
      if (!project) return;
      const id = uniqueId(project.objects.map((o) => o.id), name);
      const withImage = kind === "2d" && image;
      const def: MapObjectDefinition = {
        id,
        name,
        kind,
        ...(description ? { description } : {}),
        ...(sizeInTiles ? { sizeInTiles } : {}),
        sprites: withImage ? [{ id: DEFAULT_SPRITE_ID, name: "Default", image, collisions: [] }] : [],
        ...(withImage ? { defaultSpriteId: DEFAULT_SPRITE_ID } : {}),
        ...(kind === "3d" && model ? { model } : {}),
        ...(kind === "3d" && modelSource ? { modelSource } : {}),
      };
      if (onProject((p) => ops.addObjectDefinition(p, def))) set({ selectedObjectId: id });
    },

    updateObjectDefinition: (objectId, patch) => {
      onProject((p) => ops.updateObjectDefinition(p, objectId, patch));
    },

    duplicateObjectDefinition: (sourceObjectId) => {
      const { project } = get();
      const source = project?.objects.find((o) => o.id === sourceObjectId);
      if (!project || !source) return;
      const newId = uniqueId(project.objects.map((o) => o.id), `${source.id}-copy`);
      if (onProject((p) => ops.duplicateObjectDefinition(p, sourceObjectId, newId, `${source.name} copy`))) {
        set({ selectedObjectId: newId });
      }
    },

    removeObjectDefinition: (objectId) => {
      const result = onProject((p) => ops.removeObjectDefinition(p, objectId));
      if (!result) return;
      const surviving = get().cellIndex;
      set((s) => ({
        selectedObjectId: s.selectedObjectId === objectId ? (result.project.objects[0]?.id ?? null) : s.selectedObjectId,
        selectedInstances: s.selectedInstances.filter((sel) => surviving.has(cellKey(sel.layerId, sel.x, sel.y))),
      }));
    },

    undo: () => {
      const { project, history } = get();
      if (!project) return;
      const res = undoHistory(project, history);
      if (res) afterHistoryMove(res.project, res.history, res.command);
    },

    redo: () => {
      const { project, history } = get();
      if (!project) return;
      const res = redoHistory(project, history);
      if (res) afterHistoryMove(res.project, res.history, res.command);
    },

    setCamera: (partial) => set((s) => ({ camera: { ...s.camera, ...partial } })),

    zoomTo: (level, anchor) => {
      const { camera } = get();
      const clamped = Math.min(ZOOM_LEVELS[ZOOM_LEVELS.length - 1], Math.max(ZOOM_LEVELS[0], level));
      const before = screenToWorld(anchor.x, anchor.y, camera);
      set({ camera: { zoom: clamped, x: before.worldX - anchor.x / clamped, y: before.worldY - anchor.y / clamped } });
    },

    zoomStep: (direction, anchor) => {
      const { camera } = get();
      const currentIdx = ZOOM_LEVELS.findIndex((z) => z >= camera.zoom - 0.001);
      const idx = currentIdx < 0 ? ZOOM_LEVELS.length - 1 : currentIdx;
      const nextIdx = Math.min(ZOOM_LEVELS.length - 1, Math.max(0, idx + direction));
      get().zoomTo(ZOOM_LEVELS[nextIdx], anchor);
    },

    setShowGrid: (show) => set({ showGrid: show }),
    setShowCollisions: (show) => set({ showCollisions: show }),
    setHoverCell: (cell) => set({ hoverCell: cell }),

    save: async () => {
      const { project } = get();
      if (!project) return;
      const structural = validateProject(project);
      if (!structural.valid) {
        set({ saveStatus: "error", saveError: "Project has validation errors and cannot be saved.", issues: structural.issues });
        return;
      }
      set({ saveStatus: "saving", saveError: null });
      try {
        await api.saveProject(project);
        set({ saveStatus: "saved", dirty: false, migratedFrom: null, issues: [] });
        const savedPath = get().projectInfo?.file;
        if (savedPath) rememberRecentProject(savedPath, project.name);
        setTimeout(() => {
          if (get().saveStatus === "saved") set({ saveStatus: "idle" });
        }, 2000);
      } catch (e) {
        set({
          saveStatus: "error",
          saveError: e instanceof Error ? e.message : "Failed to save project.",
          issues: e instanceof api.ApiError ? (e.issues ?? []) : [],
        });
      }
    },

    exportActiveMap: async (options) => {
      const { project, activeMapId } = get();
      if (!project || !activeMapId) throw new Error("No map is open.");
      return api.exportMap(project, { ...options, mapId: activeMapId });
    },

    runLocalValidation: () => {
      const { project } = get();
      if (project) set({ issues: validateProject(project).issues });
    },
  };
});
