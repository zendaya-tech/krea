import {
  KREA_FORMAT,
  KREA_VERSION,
  type KreaProject,
  type Map2D,
  type Map3D,
  type MapLayer,
  type MapObjectDefinition,
  type MapSettings,
  type TerrainLayer,
} from "./map-types";
import { createTerrain } from "./terrain";

/** The original single-map format (map.json), before .krea projects existed. */
export interface LegacyMapV1 {
  version: number;
  name: string;
  settings: MapSettings;
  layers: MapLayer[];
  objects: Array<{
    id: string;
    name: string;
    image: string;
    description?: string;
    sizeInTiles?: { width: number; height: number };
  }>;
  mapping: Array<{ objectId: string; layerId: string; x: number; y: number }>;
}

export const DEFAULT_SPRITE_ID = "default";
export const LEGACY_MAP_FILE = "map.json";

export function isLegacyMapV1(input: unknown): input is LegacyMapV1 {
  if (typeof input !== "object" || input === null) return false;
  const o = input as Record<string, unknown>;
  return o.format === undefined && Array.isArray(o.objects) && Array.isArray(o.mapping) && Array.isArray(o.layers);
}

/** Converts a legacy map.json into a one-map .krea project; each object's single image becomes its default sprite. */
export function migrateLegacyMap(legacy: LegacyMapV1): KreaProject {
  const objects: MapObjectDefinition[] = legacy.objects.map((o) => ({
    id: o.id,
    name: o.name,
    kind: "2d",
    ...(o.description ? { description: o.description } : {}),
    ...(o.sizeInTiles ? { sizeInTiles: o.sizeInTiles } : {}),
    sprites: [{ id: DEFAULT_SPRITE_ID, name: "Default", image: o.image, collisions: [] }],
    defaultSpriteId: DEFAULT_SPRITE_ID,
  }));
  return {
    format: KREA_FORMAT,
    version: KREA_VERSION,
    name: legacy.name,
    objects,
    maps: [
      {
        kind: "2d",
        id: "main",
        name: legacy.name,
        settings: legacy.settings,
        layers: legacy.layers,
        mapping: legacy.mapping.map((m) => ({ objectId: m.objectId, layerId: m.layerId, x: m.x, y: m.y })),
      },
    ],
  };
}

/**
 * Version 2 projects (single-kind, 2D only) become version 3 by tagging every
 * map and object "2d". Works on raw JSON, before terrain data is decoded.
 */
export function migrateV2Json(input: Record<string, unknown>): Record<string, unknown> {
  if (input.version !== 2) return input;
  const tag = (list: unknown) =>
    Array.isArray(list) ? list.map((item) => (item && typeof item === "object" && !("kind" in item) ? { kind: "2d", ...item } : item)) : list;
  return { ...input, version: KREA_VERSION, objects: tag(input.objects), maps: tag(input.maps) };
}

const DEFAULT_LAYERS: MapLayer[] = [{ id: "ground", name: "Ground", visible: true, locked: false }];

export function createDefaultMap(id: string, name: string, settings: MapSettings): Map2D {
  return { kind: "2d", id, name, settings, layers: structuredClone(DEFAULT_LAYERS), mapping: [] };
}

export interface Map3DParams {
  /** Meters along x. */
  width: number;
  /** Meters along z. */
  depth: number;
  /** Heightmap samples per side (17-513). */
  resolution: number;
  baseHeight?: number;
  waterLevel?: number | null;
  terrainLayers?: TerrainLayer[];
}

/** Starter terrain layers: painted with plain colors until the user gives them textures. */
export function defaultTerrainLayers(): TerrainLayer[] {
  return [
    { id: "grass", name: "Grass", color: "#5b8c3a", tileSize: 4 },
    { id: "rock", name: "Rock", color: "#7d7a72", tileSize: 6 },
    { id: "sand", name: "Sand", color: "#d8c38a", tileSize: 4 },
    { id: "snow", name: "Snow", color: "#eef2f5", tileSize: 6 },
  ];
}

export function createDefaultMap3D(id: string, name: string, params: Map3DParams): Map3D {
  return {
    kind: "3d",
    id,
    name,
    terrain: createTerrain({
      resolution: params.resolution,
      width: params.width,
      depth: params.depth,
      baseHeight: params.baseHeight,
      waterLevel: params.waterLevel,
      layers: params.terrainLayers ?? defaultTerrainLayers(),
    }),
    waters: [],
    layers: [{ id: "objects", name: "Objects", visible: true, locked: false }],
    placements: [],
  };
}

export const DEFAULT_MAP3D_PARAMS: Map3DParams = { width: 128, depth: 128, resolution: 129 };

/** A blank project: no objects yet, one starter map (2D by default) with one starter layer. */
export function createDefaultProject(
  name: string,
  settings: MapSettings,
  mapName = "Main",
  kind: "2d" | "3d" = "2d",
  params3d: Map3DParams = DEFAULT_MAP3D_PARAMS,
): KreaProject {
  return {
    format: KREA_FORMAT,
    version: KREA_VERSION,
    name,
    objects: [],
    maps: [kind === "3d" ? createDefaultMap3D("main", mapName, params3d) : createDefaultMap("main", mapName, settings)],
  };
}
