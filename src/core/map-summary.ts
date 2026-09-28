import type { KreaProject, MapKind, MapObjectDefinition, MapSettings, ObjectKind, TerrainLayer } from "./map-types";
import { validateProject, type ValidationIssue } from "./map-validator";
import { getMap, getObjectSize } from "./map-utils";
import { terrainStats } from "./terrain";
import { waterMask, waterSampleCount } from "./water";
import { detailCoverage } from "./details";
import type { DetailLayer } from "./map-types";

export interface ProjectSummary {
  name: string;
  maps: Array<
    | { kind: "2d"; id: string; name: string; settings: MapSettings; layerCount: number; instanceCount: number }
    | {
        kind: "3d";
        id: string;
        name: string;
        terrain: { width: number; depth: number; resolution: number; waterLevel: number | null; layers: string[] };
        layerCount: number;
        placementCount: number;
      }
  >;
  objects: Array<{
    id: string;
    name: string;
    kind: ObjectKind;
    description?: string;
    spriteCount: number;
    model?: string;
    collisionShapeCount: number;
  }>;
  valid: boolean;
  issues: ValidationIssue[];
}

interface ObjectSummary {
  id: string;
  name: string;
  kind: ObjectKind;
  description?: string;
  sizeInTiles: { width: number; height: number };
  sprites: Array<{ id: string; name: string; image: string; collisionShapeCount: number }>;
  /** null for sprite-less (invisible) objects and 3D objects. */
  defaultSpriteId: string | null;
  /** 3D objects: the .glb model, or null for an invisible 3D marker. */
  model?: string | null;
  /** Object-level collisions, used only by sprite-less objects. */
  collisionShapeCount: number;
  /** Whether the object can be placed on this map (3D objects don't fit on 2D maps). */
  placeable: boolean;
  usageCount: number;
}

export interface MapSummary2D {
  kind: "2d";
  projectName: string;
  map: { id: string; name: string; settings: MapSettings };
  layers: Array<{ id: string; name: string; visible: boolean; locked: boolean; instanceCount: number }>;
  /** The whole catalog, with how often each object is used on this map. */
  objects: ObjectSummary[];
  totalInstances: number;
  /** Grid bounding box actually covered by placed instances (footprints included) — null on an empty map. */
  occupiedBounds: { minX: number; minY: number; maxX: number; maxY: number } | null;
  valid: boolean;
  issues: ValidationIssue[];
}

export interface MapSummary3D {
  kind: "3d";
  projectName: string;
  map: { id: string; name: string };
  terrain: {
    /** Meters: x spans [0, width], z spans [0, depth], y is up. */
    size: { width: number; depth: number };
    resolution: number;
    /** The sea: a flat water plane covering everything below this height (null = no sea). */
    waterLevel: number | null;
    layers: Array<TerrainLayer & { coverage: number }>;
    /** Grass/flower layers; `coverage` = average painted density over the terrain (0-1). */
    detailLayers: Array<DetailLayer & { coverage: number }>;
    /** Lakes and ponds at their own heights; `surfaceArea` in m² (0 = the seed is above the level: dry). */
    waters: Array<{ id: string; name: string; x: number; z: number; level: number; surfaceArea: number }>;
    minHeight: number;
    maxHeight: number;
    meanHeight: number;
  };
  layers: Array<{ id: string; name: string; visible: boolean; locked: boolean; placementCount: number }>;
  objects: ObjectSummary[];
  totalPlacements: number;
  /** World bounding box of the placements — null when there are none. */
  occupiedBounds: { minX: number; minZ: number; maxX: number; maxZ: number } | null;
  valid: boolean;
  issues: ValidationIssue[];
}

export type MapSummary = MapSummary2D | MapSummary3D;

/** A project-level overview: which maps exist and what the catalog holds. */
export function summarizeProject(project: KreaProject): ProjectSummary {
  const result = validateProject(project);
  return {
    name: project.name,
    maps: project.maps.map((m) =>
      m.kind === "2d"
        ? { kind: "2d", id: m.id, name: m.name, settings: m.settings, layerCount: m.layers.length, instanceCount: m.mapping.length }
        : {
            kind: "3d",
            id: m.id,
            name: m.name,
            terrain: {
              width: m.terrain.size.width,
              depth: m.terrain.size.depth,
              resolution: m.terrain.resolution,
              waterLevel: m.terrain.waterLevel,
              layers: m.terrain.layers.map((l) => l.id),
            },
            layerCount: m.layers.length,
            placementCount: m.placements.length,
          },
    ),
    objects: project.objects.map((o) => ({
      id: o.id,
      name: o.name,
      kind: o.kind,
      description: o.description,
      spriteCount: o.sprites.length,
      ...(o.kind === "3d" ? { model: o.model } : {}),
      collisionShapeCount: o.sprites.reduce((n, s) => n + s.collisions.length, o.collisions?.length ?? 0),
    })),
    valid: result.valid,
    issues: result.issues,
  };
}

function summarizeObject(o: MapObjectDefinition, mapKind: MapKind, usageCount: number): ObjectSummary {
  return {
    id: o.id,
    name: o.name,
    kind: o.kind,
    description: o.description,
    sizeInTiles: getObjectSize(o),
    sprites: o.sprites.map((s) => ({ id: s.id, name: s.name, image: s.image, collisionShapeCount: s.collisions.length })),
    defaultSpriteId: o.defaultSpriteId ?? null,
    ...(o.kind === "3d" ? { model: o.model ?? null } : {}),
    collisionShapeCount: o.collisions?.length ?? 0,
    placeable: mapKind === "3d" || o.kind === "2d",
    usageCount,
  };
}

/**
 * A condensed, agent-friendly overview of one map: counts and bounds instead
 * of the full (potentially large) mapping/terrain arrays, so a caller can
 * decide where to look before pulling the whole project or a screenshot.
 */
export function summarizeMap(project: KreaProject, mapId: string): MapSummary | null {
  const map = getMap(project, mapId);
  if (!map) return null;
  const result = validateProject(project);
  const usage = new Map<string, number>();
  const perLayer = new Map<string, number>();

  if (map.kind === "3d") {
    let minX = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxZ = -Infinity;
    for (const p of map.placements) {
      usage.set(p.objectId, (usage.get(p.objectId) ?? 0) + 1);
      perLayer.set(p.layerId, (perLayer.get(p.layerId) ?? 0) + 1);
      minX = Math.min(minX, p.x);
      minZ = Math.min(minZ, p.z);
      maxX = Math.max(maxX, p.x);
      maxZ = Math.max(maxZ, p.z);
    }
    const stats = terrainStats(map.terrain);
    return {
      kind: "3d",
      projectName: project.name,
      map: { id: map.id, name: map.name },
      terrain: {
        size: map.terrain.size,
        resolution: map.terrain.resolution,
        waterLevel: map.terrain.waterLevel,
        layers: map.terrain.layers.map((l, i) => ({ ...l, coverage: Math.round((stats.layerCoverage[i]?.share ?? 0) * 1000) / 1000 })),
        detailLayers: map.terrain.detailLayers.map((l, i) => ({ ...l, coverage: Math.round((detailCoverage(map.terrain)[i] ?? 0) * 1000) / 1000 })),
        waters: map.waters.map((w) => {
          const cell = (map.terrain.size.width / (map.terrain.resolution - 1)) * (map.terrain.size.depth / (map.terrain.resolution - 1));
          return { id: w.id, name: w.name, x: w.x, z: w.z, level: w.level, surfaceArea: Math.round(waterSampleCount(waterMask(map.terrain, w)) * cell) };
        }),
        minHeight: round2(stats.minHeight),
        maxHeight: round2(stats.maxHeight),
        meanHeight: round2(stats.meanHeight),
      },
      layers: map.layers.map((l) => ({ ...l, placementCount: perLayer.get(l.id) ?? 0 })),
      objects: project.objects.map((o) => summarizeObject(o, "3d", usage.get(o.id) ?? 0)),
      totalPlacements: map.placements.length,
      occupiedBounds: map.placements.length > 0 ? { minX, minZ, maxX, maxZ } : null,
      valid: result.valid,
      issues: result.issues,
    };
  }

  const objectById = new Map(project.objects.map((o) => [o.id, o]));
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const inst of map.mapping) {
    perLayer.set(inst.layerId, (perLayer.get(inst.layerId) ?? 0) + 1);
    usage.set(inst.objectId, (usage.get(inst.objectId) ?? 0) + 1);
    const size = getObjectSize(objectById.get(inst.objectId));
    minX = Math.min(minX, inst.x);
    minY = Math.min(minY, inst.y);
    maxX = Math.max(maxX, inst.x + size.width - 1);
    maxY = Math.max(maxY, inst.y + size.height - 1);
  }
  return {
    kind: "2d",
    projectName: project.name,
    map: { id: map.id, name: map.name, settings: map.settings },
    layers: map.layers.map((l) => ({ ...l, instanceCount: perLayer.get(l.id) ?? 0 })),
    objects: project.objects.map((o) => summarizeObject(o, "2d", usage.get(o.id) ?? 0)),
    totalInstances: map.mapping.length,
    occupiedBounds: map.mapping.length > 0 ? { minX, minY, maxX, maxY } : null,
    valid: result.valid,
    issues: result.issues,
  };
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
